import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { sessionOffsetSecs } from '../shared/session.js';
import { accessTokenEmail } from './access.js';

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

const timerAction = z.object({
    action: z.enum(['start', 'pause', 'resume'], {
        message: 'action must be start, pause, or resume',
    }),
});

const postCreate = z.object({
    body: z
        .string()
        .trim()
        .min(1, { message: 'body must not be empty' })
        .max(2000, { message: 'body must be at most 2000 characters' }),
});

app.onError((err, c) => {
    // An HTTPException is an intentional HTTP error (e.g. Hono's 400 for a
    // body that fails JSON.parse) — keep its status instead of collapsing it
    // into a 500, just with a friendlier message for the malformed-JSON case.
    if (err instanceof HTTPException) {
        // A custom Response attached to the exception wins — nothing in this
        // app constructs one today, but middleware may.
        if (err.res) return err.getResponse();
        const message =
            err.message === 'Malformed JSON in request body' ? 'Invalid JSON body' : err.message;
        return c.json({ error: message || 'Request failed' }, err.status);
    }
    // Keep the API contract uniformly JSON — without this, an unexpected error
    // (e.g. a D1 hiccup) surfaces as the runtime's plain-text 500.
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
});

// Cloudflare Access authenticates at the edge and forwards the identity two ways:
// a plaintext Cf-Access-Authenticated-User-Email header and a signed JWT in
// Cf-Access-Jwt-Assertion. We use only the signed one. The header is trustworthy
// solely because Access overwrites it, which holds only on hostnames the Access
// application actually covers — and a Worker keeps answering on every hostname
// bound to it, workers.dev included. On one Access doesn't front, anybody could
// send that header and act as any member of the roster; a signature can't be
// forged that way, whatever hostname the request arrives on.
//
// Local dev has no Access in front of it and so no token: DEV_USER_EMAIL (set in
// .dev.vars) stands in for a signed-in user there.
async function callerEmail(c) {
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (token) return accessTokenEmail(token, c.env);
    return (c.env.DEV_USER_EMAIL || '').trim().toLowerCase() || null;
}

async function callerUser(c) {
    const email = await callerEmail(c);
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
    const [
        me,
        { results: users },
        { results: seasons },
        { results: watched },
        { results: counts },
    ] = await Promise.all([
        callerUser(c),
        c.env.DB.prepare(
            'SELECT id, name, currently_watching_season_id FROM users ORDER BY sort_order ASC, name ASC',
        ).all(),
        c.env.DB.prepare(
            'SELECT id, subtitle, wikipedia_url, episode_count FROM seasons ORDER BY id ASC',
        ).all(),
        c.env.DB.prepare('SELECT season_id, user_id FROM watched').all(),
        // Post counts let the board show which seasons have any discussion at
        // all — without it there is nothing to click towards.
        c.env.DB.prepare(
            'SELECT season_id, COUNT(*) AS post_count FROM posts GROUP BY season_id',
        ).all(),
    ]);

    const watchedBySeason = new Map(seasons.map((s) => [s.id, []]));
    for (const row of watched) {
        watchedBySeason.get(row.season_id)?.push(row.user_id);
    }

    const postCounts = new Map(counts.map((row) => [row.season_id, row.post_count]));

    const board = seasons.map((s) => ({
        id: s.id,
        subtitle: s.subtitle,
        wikipedia_url: s.wikipedia_url,
        episode_count: s.episode_count,
        post_count: postCounts.get(s.id) ?? 0,
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

// Resolves and validates the :season_id / :episode path pair. Returns either
// { season, episode } or { error, status } for the caller to return directly.
// An episode number is meaningless without its season, so the two are checked
// together rather than by a route-level validator.
async function resolveEpisode(c) {
    const seasonId = Number(c.req.param('season_id'));
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
        return { error: 'season_id must be a positive integer', status: 400 };
    }

    // Non-numeric is a malformed request (400); an episode number that just
    // doesn't exist for this season — including 0 or negative — is a 404,
    // decided below once we know the season's episode_count.
    const episode = Number(c.req.param('episode'));
    if (!Number.isInteger(episode)) {
        return { error: 'episode must be a positive integer', status: 400 };
    }

    const season = await c.env.DB.prepare(
        'SELECT id, subtitle, wikipedia_url, episode_count FROM seasons WHERE id = ?',
    )
        .bind(seasonId)
        .first();
    if (!season) return { error: `Unknown season: ${seasonId}`, status: 404 };

    if (episode <= 0 || episode > season.episode_count) {
        return { error: `Season ${seasonId} has no episode ${episode}`, status: 404 };
    }

    return { season, episode };
}

// The caller's accumulated watch time for this episode, or null when no live
// timer is running. Read fresh on every post so the stamp reflects the session
// as it stands at write time.
async function currentOffsetSecs(c, userId, seasonId, episode, nowMs) {
    const session = await c.env.DB.prepare(
        `SELECT elapsed_secs, running_since, last_activity_at
         FROM watch_sessions
         WHERE user_id = ? AND season_id = ? AND episode = ?`,
    )
        .bind(userId, seasonId, episode)
        .first();
    return sessionOffsetSecs(session, nowMs);
}

app.post(
    '/api/seasons/:season_id/episodes/:episode/posts',
    zValidator('json', postCreate, onInvalid),
    async (c) => {
        const me = await callerUser(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

        const resolved = await resolveEpisode(c);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { body } = c.req.valid('json');
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const offsetSecs = await currentOffsetSecs(c, me.id, season.id, episode, nowMs);

        // Writing a note is activity: it keeps a live session from going stale
        // mid-episode just because you were typing. The touch is a no-op when
        // there is no session row.
        const [inserted] = await c.env.DB.batch([
            c.env.DB.prepare(
                `INSERT INTO posts (season_id, episode, user_id, body, created_at, offset_secs)
                 VALUES (?, ?, ?, ?, ?, ?)
                 RETURNING id, season_id, episode, user_id, body, created_at, offset_secs`,
            ).bind(season.id, episode, me.id, body, now, offsetSecs),
            c.env.DB.prepare(
                `UPDATE watch_sessions SET last_activity_at = ?
                 WHERE user_id = ? AND season_id = ? AND episode = ?`,
            ).bind(now, me.id, season.id, episode),
        ]);

        return c.json({ success: true, post: inserted.results[0] }, 201);
    },
);

// The spoiler gate. An episode is readable when the caller has watched the whole
// season or has explicitly opened that episode. Everything else about the
// feature follows from this one predicate — and it is evaluated here, on the
// server, so a hidden body is never serialized at all.
app.get('/api/seasons/:season_id/discussion', async (c) => {
    const seasonId = Number(c.req.param('season_id'));
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
        return c.json({ error: 'season_id must be a positive integer' }, 400);
    }

    const season = await c.env.DB.prepare(
        'SELECT id, subtitle, wikipedia_url, episode_count FROM seasons WHERE id = ?',
    )
        .bind(seasonId)
        .first();
    if (!season) return c.json({ error: `Unknown season: ${seasonId}` }, 404);

    const me = await callerUser(c);

    const [{ results: posts }, watchedRow, { results: reveals }, { results: sessions }] =
        await Promise.all([
            c.env.DB.prepare(
                `SELECT id, episode, user_id, body, created_at, offset_secs
                 FROM posts WHERE season_id = ? ORDER BY episode ASC, id ASC`,
            )
                .bind(seasonId)
                .all(),
            me
                ? c.env.DB.prepare('SELECT 1 FROM watched WHERE user_id = ? AND season_id = ?')
                      .bind(me.id, seasonId)
                      .first()
                : null,
            me
                ? c.env.DB.prepare(
                      'SELECT episode FROM reveals WHERE user_id = ? AND season_id = ?',
                  )
                      .bind(me.id, seasonId)
                      .all()
                : { results: [] },
            me
                ? c.env.DB.prepare(
                      `SELECT episode, elapsed_secs, running_since, last_activity_at
                       FROM watch_sessions WHERE user_id = ? AND season_id = ?`,
                  )
                      .bind(me.id, seasonId)
                      .all()
                : { results: [] },
        ]);

    const watchedSeason = watchedRow != null;
    const revealed = new Set(reveals.map((r) => r.episode));
    const sessionByEpisode = new Map(sessions.map((s) => [s.episode, s]));

    const byEpisode = new Map();
    for (const p of posts) {
        if (!byEpisode.has(p.episode)) byEpisode.set(p.episode, []);
        byEpisode.get(p.episode).push(p);
    }

    const episodes = [];
    for (let episode = 1; episode <= season.episode_count; episode++) {
        const all = byEpisode.get(episode) ?? [];
        const readable = watchedSeason || revealed.has(episode);

        // Authors are named even on a locked board: the main board already shows
        // who has watched which season, so this reveals nothing new — and it
        // tells you whether opening the board is worth it.
        const authors = [...new Set(all.map((p) => p.user_id))];

        // The one line that matters. On a locked board only the caller's own
        // posts survive; nobody else's body reaches the response.
        const visible = readable ? all : all.filter((p) => me && p.user_id === me.id);

        const session = sessionByEpisode.get(episode) ?? null;
        episodes.push({
            episode,
            readable,
            count: all.length,
            authors,
            posts: visible.map((p) => ({
                id: p.id,
                user_id: p.user_id,
                body: p.body,
                created_at: p.created_at,
                offset_secs: p.offset_secs,
            })),
            session: session
                ? {
                      elapsed_secs: session.elapsed_secs,
                      running_since: session.running_since,
                      last_activity_at: session.last_activity_at,
                  }
                : null,
        });
    }

    return c.json({
        season,
        me: me ? { id: me.id, name: me.name } : null,
        // The server clock, so a device with a skewed one still renders a
        // correct ticking timer.
        now: new Date().toISOString(),
        episodes,
    });
});

// Opening an episode for reading is one-way and idempotent — there is no
// re-lock, because you cannot unsee it. Reveals are stored independently of
// `watched`, so un-marking a season (usually a mis-click correction) does not
// take back an episode you have already read.
app.post('/api/seasons/:season_id/episodes/:episode/reveal', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const resolved = await resolveEpisode(c);
    if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
    const { season, episode } = resolved;

    await c.env.DB.prepare(
        `INSERT OR IGNORE INTO reveals (user_id, season_id, episode, created_at)
         VALUES (?, ?, ?, ?)`,
    )
        .bind(me.id, season.id, episode, new Date().toISOString())
        .run();

    return c.json({ success: true, season_id: season.id, episode });
});

// Season-agnostic: a post id alone identifies the row, so this doesn't go
// through resolveEpisode. Deleting a note you do not own and deleting one that
// never existed return the same 404 — a distinct "forbidden" would turn this
// route into an oracle for which post ids are real.
app.delete('/api/posts/:post_id', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const postId = Number(c.req.param('post_id'));
    if (!Number.isInteger(postId) || postId <= 0) {
        return c.json({ error: 'post_id must be a positive integer' }, 400);
    }

    const { meta } = await c.env.DB.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?')
        .bind(postId, me.id)
        .run();
    if (meta.changes === 0) return c.json({ error: 'Unknown post' }, 404);

    return c.json({ success: true, post_id: postId });
});

// The watch timer. There is no stop action: a session simply goes stale after
// three hours without a start, pause, resume, or post (see shared/session.js).
// Sessions are per (user, episode) and deliberately not mutually exclusive —
// a forgotten one on another episode is harmless, because offsets freeze onto
// the post at write time and the stale session stamps nothing.
app.post(
    '/api/seasons/:season_id/episodes/:episode/timer',
    zValidator('json', timerAction, onInvalid),
    async (c) => {
        const me = await callerUser(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

        const resolved = await resolveEpisode(c);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { action } = c.req.valid('json');
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const key = [me.id, season.id, episode];

        if (action === 'start') {
            // Starting again zeroes the session — it is the "I'm beginning this
            // episode" action, not a resume.
            await c.env.DB.prepare(
                `INSERT INTO watch_sessions
                     (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at)
                 VALUES (?, ?, ?, 0, ?, ?)
                 ON CONFLICT (user_id, season_id, episode) DO UPDATE SET
                     elapsed_secs = 0, running_since = excluded.running_since,
                     last_activity_at = excluded.last_activity_at`,
            )
                .bind(...key, now, now)
                .run();
        } else {
            // Pause and resume both act on an existing session, and neither may
            // revive one that has already gone stale — that is precisely the
            // failure sessionOffsetSecs exists to prevent, and computing the
            // banked total in SQL (via julianday) bypassed it entirely: a pause
            // clicked the morning after would bank the whole overnight gap and
            // stamp last_activity_at as if the session had been live all along.
            // Read the row and ask the shared helper first, in JS, so pause and
            // resume see exactly the same staleness rule a read does.
            const existing = await c.env.DB.prepare(
                `SELECT elapsed_secs, running_since, last_activity_at
                 FROM watch_sessions WHERE user_id = ? AND season_id = ? AND episode = ?`,
            )
                .bind(...key)
                .first();
            if (!existing) return c.json({ error: 'No timer to update' }, 409);

            const banked = sessionOffsetSecs(existing, nowMs);
            if (banked === null) {
                // Dead session: write nothing. The caller sees an expired timer
                // and should start over rather than resume a session that no
                // longer represents anything real.
                return c.json(
                    { error: 'Timer expired after 3 hours of inactivity — start a new session' },
                    409,
                );
            }

            if (action === 'pause') {
                // Bank the running segment using the same total a read would
                // report. Guarded on running_since so a double pause cannot
                // bank the same stretch twice — a session already paused is
                // left untouched.
                if (existing.running_since !== null) {
                    await c.env.DB.prepare(
                        `UPDATE watch_sessions
                         SET elapsed_secs = ?, running_since = NULL, last_activity_at = ?
                         WHERE user_id = ? AND season_id = ? AND episode = ?
                           AND running_since IS NOT NULL`,
                    )
                        .bind(banked, now, ...key)
                        .run();
                }
            } else {
                // Resume only restarts the clock; the banked total is
                // untouched. A session already running is left untouched.
                if (existing.running_since === null) {
                    await c.env.DB.prepare(
                        `UPDATE watch_sessions SET running_since = ?, last_activity_at = ?
                         WHERE user_id = ? AND season_id = ? AND episode = ? AND running_since IS NULL`,
                    )
                        .bind(now, now, ...key)
                        .run();
                }
            }
        }

        const session = await c.env.DB.prepare(
            `SELECT elapsed_secs, running_since, last_activity_at
             FROM watch_sessions WHERE user_id = ? AND season_id = ? AND episode = ?`,
        )
            .bind(...key)
            .first();
        if (!session) return c.json({ error: 'No timer to update' }, 409);

        return c.json({
            success: true,
            season_id: season.id,
            episode,
            session,
            offset_secs: sessionOffsetSecs(session, nowMs),
        });
    },
);

app.all('/api/*', (c) => c.json({ error: 'Unknown API endpoint' }, 404));

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
