import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const app = new Hono();

const onInvalid = (result, c) => {
    if (!result.success) {
        const message = result.error.issues.map((i) => i.message).join('; ') || 'Invalid input';
        return c.json({ error: message }, 400);
    }
};

const watchedCreate = z.object({
    season_id: z.number().int().positive({ message: 'season_id must be a positive integer' }),
});

const currentlyWatchingUpdate = z.object({
    season_id: z
        .number()
        .int()
        .positive({ message: 'season_id must be a positive integer' })
        .nullable(),
});

app.onError((err, c) => {
    if (
        err instanceof HTTPException &&
        err.status === 400 &&
        err.message === 'Malformed JSON in request body'
    ) {
        return c.json({ error: 'Invalid JSON body' }, 400);
    }
    // Keep the API contract uniformly JSON — without this, an unexpected error
    // (e.g. a D1 hiccup) surfaces as the runtime's plain-text 500.
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
});

// Cloudflare Access authenticates at the edge and forwards the verified identity
// in the Cf-Access-Authenticated-User-Email header — the client cannot spoof it
// because Access overwrites the header. Local dev bypasses Access, so fall back
// to DEV_USER_EMAIL (set in .dev.vars) to simulate a signed-in user.
function callerEmail(c) {
    const header = c.req.header('Cf-Access-Authenticated-User-Email');
    const email = header || c.env.DEV_USER_EMAIL || '';
    return email.trim().toLowerCase() || null;
}

async function callerUser(c) {
    const email = callerEmail(c);
    if (!email) return null;
    return c.env.DB.prepare(
        `SELECT users.id, users.name
         FROM user_emails JOIN users ON users.id = user_emails.user_id
         WHERE user_emails.email = ?`,
    )
        .bind(email)
        .first();
}

app.get('/api/board', async (c) => {
    const [me, { results: users }, { results: seasons }, { results: watched }] = await Promise.all([
        callerUser(c),
        c.env.DB.prepare(
            'SELECT id, name, currently_watching_season_id FROM users ORDER BY sort_order ASC, name ASC',
        ).all(),
        c.env.DB.prepare('SELECT id, subtitle, wikipedia_url FROM seasons ORDER BY id ASC').all(),
        c.env.DB.prepare('SELECT season_id, user_id FROM watched').all(),
    ]);

    const watchedBySeason = new Map(seasons.map((s) => [s.id, []]));
    for (const row of watched) {
        watchedBySeason.get(row.season_id)?.push(row.user_id);
    }

    const board = seasons.map((s) => ({
        id: s.id,
        subtitle: s.subtitle,
        wikipedia_url: s.wikipedia_url,
        watched_by: watchedBySeason.get(s.id),
    }));

    return c.json({
        me: me ? { id: me.id, name: me.name } : null,
        users,
        seasons: board,
    });
});

app.put(
    '/api/currently-watching',
    zValidator('json', currentlyWatchingUpdate, onInvalid),
    async (c) => {
        const me = await callerUser(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

        const { season_id } = c.req.valid('json');

        if (season_id !== null) {
            const season = await c.env.DB.prepare('SELECT id FROM seasons WHERE id = ?')
                .bind(season_id)
                .first();
            if (!season) return c.json({ error: `Unknown season: ${season_id}` }, 404);

            // Invariant: your currently-watching season is always one of your
            // unwatched seasons. The picker only offers those; enforce it here
            // too so a direct API call can't break it. The not-watched check and
            // the write are a single statement so a concurrent POST /api/watched
            // can't land between them and leave you "watching" a watched season.
            const { meta } = await c.env.DB.prepare(
                `UPDATE users SET currently_watching_season_id = ?1
                 WHERE id = ?2
                   AND NOT EXISTS (SELECT 1 FROM watched WHERE user_id = ?2 AND season_id = ?1)`,
            )
                .bind(season_id, me.id)
                .run();
            if (meta.changes === 0) {
                return c.json({ error: `You have already watched season ${season_id}` }, 409);
            }
        } else {
            await c.env.DB.prepare(
                'UPDATE users SET currently_watching_season_id = NULL WHERE id = ?',
            )
                .bind(me.id)
                .run();
        }

        return c.json({ success: true, user_id: me.id, season_id });
    },
);

app.post('/api/watched', zValidator('json', watchedCreate, onInvalid), async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const { season_id } = c.req.valid('json');
    const season = await c.env.DB.prepare('SELECT id FROM seasons WHERE id = ?')
        .bind(season_id)
        .first();
    if (!season) return c.json({ error: `Unknown season: ${season_id}` }, 404);

    const now = new Date().toISOString();
    await c.env.DB.batch([
        c.env.DB.prepare(
            'INSERT OR IGNORE INTO watched (user_id, season_id, created_at) VALUES (?, ?, ?)',
        ).bind(me.id, season_id, now),
        // Finishing a season clears it as your currently-watching season — you
        // can't be mid-watch on something you've marked seen. No-op otherwise.
        c.env.DB.prepare(
            'UPDATE users SET currently_watching_season_id = NULL WHERE id = ? AND currently_watching_season_id = ?',
        ).bind(me.id, season_id),
    ]);

    return c.json({ success: true, user_id: me.id, season_id }, 201);
});

app.delete('/api/watched/:season_id', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const seasonId = Number(c.req.param('season_id'));
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
        return c.json({ error: 'season_id must be a positive integer' }, 400);
    }

    // Invariant: a user's currently_watching_season_id is always one of their
    // *unwatched* seasons (the picker only offers those, and POST /api/watched
    // clears it on finish). Unmarking a season leaves it unwatched — a valid
    // currently-watching state — but we deliberately don't restore it here:
    // there's no signal the user resumed it, so we leave their pick untouched.
    await c.env.DB.prepare('DELETE FROM watched WHERE user_id = ? AND season_id = ?')
        .bind(me.id, seasonId)
        .run();

    return c.json({ success: true, user_id: me.id, season_id: seasonId });
});

app.all('/api/*', (c) => c.json({ error: 'Unknown API endpoint' }, 404));

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
