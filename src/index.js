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

app.onError((err, c) => {
    if (
        err instanceof HTTPException &&
        err.status === 400 &&
        err.message === 'Malformed JSON in request body'
    ) {
        return c.json({ error: 'Invalid JSON body' }, 400);
    }
    throw err;
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
    const me = await callerUser(c);

    const [{ results: users }, { results: seasons }, { results: watched }] = await Promise.all([
        c.env.DB.prepare('SELECT id, name FROM users ORDER BY sort_order ASC, name ASC').all(),
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

app.post('/api/watched', zValidator('json', watchedCreate, onInvalid), async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const { season_id } = c.req.valid('json');
    const season = await c.env.DB.prepare('SELECT id FROM seasons WHERE id = ?')
        .bind(season_id)
        .first();
    if (!season) return c.json({ error: `Unknown season: ${season_id}` }, 404);

    const now = new Date().toISOString();
    await c.env.DB.prepare(
        'INSERT OR IGNORE INTO watched (user_id, season_id, created_at) VALUES (?, ?, ?)',
    )
        .bind(me.id, season_id, now)
        .run();

    return c.json({ success: true, user_id: me.id, season_id }, 201);
});

app.delete('/api/watched/:season_id', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const seasonId = Number(c.req.param('season_id'));
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
        return c.json({ error: 'season_id must be a positive integer' }, 400);
    }

    await c.env.DB.prepare('DELETE FROM watched WHERE user_id = ? AND season_id = ?')
        .bind(me.id, seasonId)
        .run();

    return c.json({ success: true, user_id: me.id, season_id: seasonId });
});

app.all('/api/*', (c) => c.json({ error: 'Unknown API endpoint' }, 404));

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
