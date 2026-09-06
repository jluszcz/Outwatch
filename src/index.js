import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import {
    sessionOffsetSecs,
    MAX_OFFSET_ADJUST_SECS,
    MAX_SKIP_DELTA_SECS,
} from '../shared/session.js';
import { MAX_REACTIONS_PER_POST, isReactionEmoji } from '../shared/reactions.js';
import { accessTokenEmail } from './access.js';
import { groupNotes, FEED_WINDOW_MS, FEED_MAX_EVENTS } from './feed.js';

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

const timerAction = z
    .object({
        action: z.enum(['start', 'pause', 'resume', 'skip', 'stop'], {
            message: 'action must be start, pause, resume, skip, or stop',
        }),
        delta_secs: z
            .number()
            .int({ message: 'delta_secs must be a whole number of seconds' })
            .min(-MAX_SKIP_DELTA_SECS, {
                message: `delta_secs must be within ${MAX_SKIP_DELTA_SECS} seconds of zero`,
            })
            .max(MAX_SKIP_DELTA_SECS, {
                message: `delta_secs must be within ${MAX_SKIP_DELTA_SECS} seconds of zero`,
            })
            .refine((v) => v !== 0, { message: 'delta_secs must not be zero' })
            .optional(),
    })
    .refine((data) => data.action !== 'skip' || data.delta_secs !== undefined, {
        message: 'delta_secs is required for a skip action',
        path: ['delta_secs'],
    });

const offsetAdjust = z.object({
    adjust_secs: z
        .number()
        .int({ message: 'adjust_secs must be a whole number of seconds' })
        .min(-MAX_OFFSET_ADJUST_SECS, {
            message: `adjust_secs must be within ${MAX_OFFSET_ADJUST_SECS} seconds of zero`,
        })
        .max(MAX_OFFSET_ADJUST_SECS, {
            message: `adjust_secs must be within ${MAX_OFFSET_ADJUST_SECS} seconds of zero`,
        }),
});

// Validated as a pair rather than as two independent fields: a reason belongs to
// a skip, so `status: null` must come without one and `status: 'skipping'` must
// come with one. A future second status would take no reason at all, which is
// what the `status` column is for.
const episodeStatus = z
    .object({
        status: z.enum(['skipping'], { message: 'status must be "skipping" or null' }).nullable(),
        reason: z
            .enum(['recap', 'reunion'], { message: 'reason must be "recap" or "reunion"' })
            .nullish(),
    })
    .refine((data) => (data.status === null) === (data.reason == null), {
        message: 'a skipping status needs a reason, and a reason needs a skipping status',
        path: ['reason'],
    });

const postBody = z
    .string()
    .trim()
    .min(1, { message: 'body must not be empty' })
    .max(2000, { message: 'body must be at most 2000 characters' });

const postCreate = z.object({
    body: postBody,
    reply_to_post_id: z
        .number()
        .int()
        .positive({ message: 'reply_to_post_id must be a positive integer' })
        .nullish(),
});

const postEdit = z.object({ body: postBody });

const reactionUpdate = z.object({
    emoji: z
        .string({ message: 'emoji must be a single emoji' })
        .refine(isReactionEmoji, { message: 'emoji must be a single emoji' }),
    on: z.boolean({ message: 'on must be true or false' }),
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

// Every API response is per-caller and immediately stale: the board changes
// under you, and the spoiler gate means two people asking for the same URL get
// different bodies. Set before the handler runs rather than after, so the
// responses app.onError builds — which never come back through this middleware,
// since a throw rejects next() — carry it too.
app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
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
    const column = await c.env.DB.prepare(
        `SELECT users.id, users.name
         FROM user_emails JOIN users ON users.id = user_emails.user_id
         WHERE user_emails.email = ?`,
    )
        .bind(email)
        .first();
    // The row identifies the column; the email identifies the person inside it.
    // A shared column has two logins, and discussion notes need to tell them
    // apart — so the email rides along rather than being dropped here. It is
    // never serialized: routes that echo the caller pick `id` and `name`
    // explicitly.
    return column && { ...column, email };
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

// The pair of lookups every episode-scoped route opens with: who is asking, and
// whether the episode exists. Neither depends on the other, so they go together
// rather than one after the other — a D1 round-trip is most of what these routes
// spend, and the write path was serializing four or five of them.
//
// A helper rather than an inlined Promise.all at each of the four call sites so
// the reason lives in one place. Callers still decide what to do with each
// half, and they all check `me` first: answering 404 for an imaginary episode
// before 403 for a caller off the roster would let a stranger map the seasons.
function callerAndEpisode(c) {
    return Promise.all([callerUser(c), resolveEpisode(c)]);
}

// The single-post form of the spoiler gate. GET /discussion evaluates
// readability per episode; the routes that act on one post by id need the same
// predicate for one row. Returns the post when the caller may see it — the
// board is readable (season watched, or that episode revealed) or it is their
// own column's note — and null otherwise. Callers turn null into the same 404 a
// missing post gets, so these routes never become an oracle for which post ids
// are real.
async function visiblePost(c, postId, me) {
    if (!me) return null;

    const post = await c.env.DB.prepare(
        `SELECT id, season_id, episode, user_id, body, author_email
         FROM posts WHERE id = ?`,
    )
        .bind(postId)
        .first();
    if (!post) return null;

    // Column-level, matching the read path: a partner's note is not a spoiler.
    if (post.user_id === me.id) return post;

    const [watchedRow, revealRow] = await Promise.all([
        c.env.DB.prepare('SELECT 1 FROM watched WHERE user_id = ? AND season_id = ?')
            .bind(me.id, post.season_id)
            .first(),
        c.env.DB.prepare(
            'SELECT 1 FROM reveals WHERE user_id = ? AND season_id = ? AND episode = ?',
        )
            .bind(me.id, post.season_id, post.episode)
            .first(),
    ]);
    return watchedRow || revealRow ? post : null;
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
        const [me, resolved] = await callerAndEpisode(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { body, reply_to_post_id: replyToId = null } = c.req.valid('json');

        // A reply may only point at a note the caller can actually see, in this
        // same episode. Missing, wrong-episode, and not-visible all answer 404
        // alike.
        if (replyToId != null) {
            const parent = await visiblePost(c, replyToId, me);
            if (!parent || parent.season_id !== season.id || parent.episode !== episode) {
                // Worded for the one reader who actually sees it: someone whose
                // reply target was deleted while they were writing, watching
                // this land in the season view's error banner. The status is
                // still the same 404 all three cases answer with, so it
                // distinguishes nothing a bare "Unknown post" didn't.
                return c.json({ error: 'The note you replied to is gone' }, 404);
            }
        }

        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const offsetSecs = await currentOffsetSecs(c, me.id, season.id, episode, nowMs);

        // Writing a note is activity: it keeps a live session from going stale
        // mid-episode just because you were typing. The touch is a no-op when
        // there is no session row.
        const [inserted] = await c.env.DB.batch([
            c.env.DB.prepare(
                `INSERT INTO posts (season_id, episode, user_id, body, created_at, offset_secs, author_email, reply_to_post_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 RETURNING id, season_id, episode, user_id, body, created_at, offset_secs, reply_to_post_id`,
            ).bind(season.id, episode, me.id, body, now, offsetSecs, me.email, replyToId),
            c.env.DB.prepare(
                `UPDATE watch_sessions SET last_activity_at = ?
                 WHERE user_id = ? AND season_id = ? AND episode = ?`,
            ).bind(now, me.id, season.id, episode),
        ]);

        return c.json({ success: true, post: inserted.results[0] }, 201);
    },
);

// The roster seen as individuals rather than as columns: one entry per login,
// ordered so it does not depend on who is asking. That ordering is what makes
// an author's accent slot stable — a person keeps the same colour across
// reloads and across everyone's screens, for as long as the roster's shape
// doesn't change; adding or removing an entry that sorts earlier reshuffles
// every index after it, which is rare and only costs a colour. `name` falls
// back to the column's own name, which is what a solo column and a
// not-yet-named roster entry get.
async function rosterPeople(c) {
    const { results } = await c.env.DB.prepare(
        `SELECT user_emails.email AS email, user_emails.name AS person_name,
                users.id AS user_id, users.name AS user_name
         FROM user_emails JOIN users ON users.id = user_emails.user_id
         ORDER BY users.sort_order ASC, users.name ASC, user_emails.email ASC`,
    ).all();

    const byEmail = new Map();
    const columnName = new Map();
    results.forEach((row, index) => {
        // user_emails.email is COLLATE NOCASE, so the stored spelling may differ
        // from the lowercased one written onto a post. Key on the lowered form.
        byEmail.set(row.email.toLowerCase(), { index, name: row.person_name || row.user_name });
        columnName.set(row.user_id, row.user_name);
    });
    return { byEmail, columnName };
}

// A note's author. The individual when the note carries an email the roster
// still knows, the column otherwise — which covers every note written before
// authorship was recorded and anyone since removed from the roster. `mine`
// mirrors exactly what DELETE /api/posts/:post_id permits, so the delete button
// the client draws from it is never a button the server would refuse.
function attribute(post, people, me) {
    const email = post.author_email ? post.author_email.toLowerCase() : null;
    const person = email ? people.byEmail.get(email) : null;
    return {
        author_name: person?.name ?? people.columnName.get(post.user_id) ?? 'Someone',
        author_index: person ? person.index : null,
        mine: Boolean(me) && post.user_id === me.id && (email === null || email === me.email),
    };
}

// A quote block's source. The parent is always in the same season, so it comes
// from the map already built over the season's posts — no extra query. Three
// forms: absent, visible (with its body), or locked (its id alone). A locked
// parent's body is never serialized, which is the whole point: reply_to_post_id
// is frozen at write time while visibility is recomputed on every read, so the
// two can disagree.
function quoteOf(post, byId, visibleIds, people, me) {
    if (post.reply_to_post_id == null) return null;
    const parent = byId.get(post.reply_to_post_id);
    if (!parent) return null;
    if (!visibleIds.has(parent.id)) return { id: parent.id, locked: true };
    const { author_name, author_index, mine } = attribute(parent, people, me);
    return { id: parent.id, author_name, author_index, mine, body: parent.body };
}

// A note's reactions, ordered by when each emoji first landed on it. Names
// rather than a bare count: on a roster this size "2" says almost nothing and
// "Bob, Carol" says all of it. Only ever called for posts that survived the
// visibility filter, so a locked board carries no counts and no names.
//
// Any emoji can be a reaction now, so there is no fixed set to order by. First
// use rather than count keeps a chip still: ordering by popularity would make
// chips trade places under someone's finger as other people click, and the
// order a conversation's reactions appeared in is the more meaningful one
// anyway. ISO timestamps sort lexicographically, so they compare as strings.
// Two can still land in the same millisecond; the emoji itself breaks the tie,
// which is arbitrary but keeps a given set of rows ordered the same on every
// read rather than following whatever order SQLite handed them back.
function reactionsOf(postId, byPost, people, me) {
    const rows = byPost.get(postId);
    if (!rows) return [];

    const firstSeen = new Map();
    for (const r of rows) {
        const prev = firstSeen.get(r.emoji);
        if (prev === undefined || r.created_at < prev) firstSeen.set(r.emoji, r.created_at);
    }

    return [...firstSeen.keys()]
        .sort((a, b) => {
            const at = firstSeen.get(a);
            const bt = firstSeen.get(b);
            return at === bt ? (a < b ? -1 : 1) : at < bt ? -1 : 1;
        })
        .map((emoji) => {
            const hits = rows.filter((r) => r.emoji === emoji);
            return {
                emoji,
                count: hits.length,
                mine: Boolean(me) && hits.some((r) => r.email.toLowerCase() === me.email),
                names: hits.map(
                    (r) => people.byEmail.get(r.email.toLowerCase())?.name ?? 'Someone',
                ),
            };
        });
}

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

    const [
        { results: posts },
        watchedRow,
        { results: reveals },
        { results: sessions },
        people,
        { results: reactionRows },
        { results: offsets },
    ] = await Promise.all([
        c.env.DB.prepare(
            `SELECT id, episode, user_id, body, created_at, offset_secs, author_email,
                    reply_to_post_id, edited_at
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
            ? c.env.DB.prepare('SELECT episode FROM reveals WHERE user_id = ? AND season_id = ?')
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
        rosterPeople(c),
        // One query for the season's reactions rather than one per note; grouped
        // below alongside the posts themselves.
        c.env.DB.prepare(
            `SELECT reactions.post_id AS post_id, reactions.email AS email,
                    reactions.emoji AS emoji, reactions.created_at AS created_at
             FROM reactions JOIN posts ON posts.id = reactions.post_id
             WHERE posts.season_id = ?`,
        )
            .bind(seasonId)
            .all(),
        // Every user's corrections, not just the caller's: a post is shifted by the
        // correction of whoever wrote it. One query for the season, grouped below.
        c.env.DB.prepare(
            'SELECT user_id, episode, adjust_secs FROM watch_offsets WHERE season_id = ?',
        )
            .bind(seasonId)
            .all(),
    ]);

    const watchedSeason = watchedRow != null;
    const revealed = new Set(reveals.map((r) => r.episode));
    const sessionByEpisode = new Map(sessions.map((s) => [s.episode, s]));

    // A watch-timer correction (migration 0008) is applied here rather than stored
    // into posts.offset_secs, which keeps meaning what the writer's timer actually
    // read. Applying on read is what lets a correction be revised, and what makes
    // it reach the notes that revealed the drift in the first place.
    const adjustByKey = new Map(offsets.map((o) => [`${o.user_id}:${o.episode}`, o.adjust_secs]));
    const adjustFor = (userId, episode) => adjustByKey.get(`${userId}:${episode}`) ?? 0;

    const byEpisode = new Map();
    for (const p of posts) {
        if (!byEpisode.has(p.episode)) byEpisode.set(p.episode, []);
        byEpisode.get(p.episode).push(p);
    }
    const byId = new Map(posts.map((p) => [p.id, p]));

    const reactionsByPost = new Map();
    for (const r of reactionRows) {
        if (!reactionsByPost.has(r.post_id)) reactionsByPost.set(r.post_id, []);
        reactionsByPost.get(r.post_id).push(r);
    }

    const episodes = [];
    for (let episode = 1; episode <= season.episode_count; episode++) {
        const all = byEpisode.get(episode) ?? [];
        const readable = watchedSeason || revealed.has(episode);

        // Authors are named even on a locked board: the main board already shows
        // who has watched which season, so this reveals nothing new — and it
        // tells you whether opening the board is worth it. Deduped on the author
        // key rather than the display name, so two people who share a first name
        // still list twice. The key mixes two spaces — author_email when a note
        // has one, user_id when it doesn't — so until the one-time backfill
        // attributes every pre-existing note, a household with both an old and a
        // new note lists twice (once as the column, once as the individual).
        // Self-healing once the backfill lands, and the conservative choice
        // given the data: there is no way to tell from a NULL author_email alone
        // whether it's the same person as a later attributed one.
        const authors = [];
        const seenAuthors = new Set();
        for (const p of all) {
            const key = p.author_email ? p.author_email.toLowerCase() : p.user_id;
            if (seenAuthors.has(key)) continue;
            seenAuthors.add(key);
            const { author_name, mine } = attribute(p, people, me);
            authors.push({ name: author_name, mine });
        }

        // The one line that matters. On a locked board only the caller's own
        // column's posts survive; nobody else's body reaches the response.
        // Column-level, not per-person: a couple watches together, so a
        // partner's note is not a spoiler.
        const visible = readable ? all : all.filter((p) => me && p.user_id === me.id);
        const visibleIds = new Set(visible.map((p) => p.id));

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
                offset_secs:
                    p.offset_secs == null ? null : p.offset_secs + adjustFor(p.user_id, episode),
                edited_at: p.edited_at,
                reply_to: quoteOf(p, byId, visibleIds, people, me),
                reactions: reactionsOf(p.id, reactionsByPost, people, me),
                ...attribute(p, people, me),
            })),
            session: session
                ? {
                      elapsed_secs: session.elapsed_secs,
                      running_since: session.running_since,
                      last_activity_at: session.last_activity_at,
                  }
                : null,
            // The caller's own correction, for the live chip — it ticks locally, so it
            // has to add the same number the posts above already got.
            adjust_secs: me ? adjustFor(me.id, episode) : 0,
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
    const [me, resolved] = await callerAndEpisode(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);
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

// What other people have said since you last looked.
//
// Read from posts rather than an event log, which is what makes a deleted note
// leave the feed on its own. The whole window is fetched and grouped in one
// pass rather than paged: a household board's 30 days is a few hundred rows,
// and one pass is what keeps the unread count and the ten shown groups from
// ever disagreeing about what a group is.
//
// The caller's own notes are excluded in SQL rather than after grouping, so the
// ten returned are ten they can actually act on. The CASE matches
// attribute()'s `mine` rule for every note the write path can actually
// produce — an attributed note is excluded when the email matches, an
// unattributed one when the column does — though it is not literally the same
// test: the non-null branch skips attribute()'s user_id === me.id conjunct.
// That only diverges for a note whose author_email and user_id disagree, which
// the write path never produces (a post's author_email always names the same
// person its user_id's column resolves to), so the two rules agree in
// practice without agreeing on paper.
app.get('/api/feed', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const nowMs = Date.now();
    const since = new Date(nowMs - FEED_WINDOW_MS).toISOString();

    const [{ results: rows }, people, seenRow] = await Promise.all([
        c.env.DB.prepare(
            `SELECT posts.season_id   AS season_id,
                    posts.episode     AS episode,
                    posts.user_id     AS user_id,
                    posts.author_email AS author_email,
                    posts.created_at  AS created_at,
                    COALESCE(LOWER(posts.author_email), 'user:' || posts.user_id) AS author_key
             FROM posts
             WHERE posts.created_at >= ?
               AND CASE WHEN posts.author_email IS NULL
                        THEN posts.user_id <> ?
                        ELSE LOWER(posts.author_email) <> ?
                   END
             ORDER BY author_key ASC, posts.season_id ASC, posts.episode ASC,
                      posts.created_at ASC`,
        )
            .bind(since, me.id, me.email)
            .all(),
        rosterPeople(c),
        c.env.DB.prepare('SELECT feed_seen_at FROM user_emails WHERE email = ?')
            .bind(me.email)
            .first(),
    ]);

    const seenAt = seenRow?.feed_seen_at ?? null;

    // Both sides are toISOString() output — fixed-length UTC — so a string
    // compare is a chronological one and needs no parsing.
    const groups = groupNotes(rows).map((group) => ({
        ...group,
        unread: seenAt === null || group.at > seenAt,
    }));

    // groupNotes returns them grouped by author; the panel wants them by time.
    groups.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    return c.json({
        now: new Date(nowMs).toISOString(),
        // Counts every unread group in the window, not only the ten shown, so
        // the badge can read higher than the list is long. Deliberate: the
        // panel has no second page, so a footer explaining the difference could
        // only name a number nobody can follow.
        unread_count: groups.filter((group) => group.unread).length,
        events: groups.slice(0, FEED_MAX_EVENTS).map((group) => ({
            // attribute() resolves the byline the same way the discussion route
            // does, so a note reads the same in the feed as on its board.
            author_name: attribute(group, people, me).author_name,
            season_id: group.season_id,
            episode: group.episode,
            at: group.at,
            unread: group.unread,
        })),
    });
});

// Marks the feed read for the individual, not their column — the same reason
// feed_seen_at sits on user_emails.
//
// The body is ignored on purpose. The stamp is the server's own clock, so a
// caller cannot backdate the mark to keep a badge lit or forward-date it to
// silence one. Idempotent: calling it twice just moves the mark forward.
app.post('/api/feed/seen', async (c) => {
    // Ignoring the body is not the same as accepting a request without one. A
    // POST carrying no body and no content type is a CORS *simple* request, so
    // a hostile page could fire one cross-site with the Access cookie attached
    // and clear someone's badge — no preflight to refuse, and it does not need
    // to read the response to have had its effect. Every other mutation here is
    // already out of reach: they run through zValidator, and Hono's json
    // validator hands a non-JSON content type an empty object, which their
    // schemas reject with a 400. This route has no required field to reject
    // with, so it asks for the content type directly. Requiring a header that
    // is not CORS-safelisted is what forces the preflight this app answers for
    // nobody.
    const contentType = c.req.header('Content-Type') ?? '';
    if (!/^application\/json\b/i.test(contentType)) {
        return c.json({ error: 'Content-Type must be application/json' }, 415);
    }

    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const seenAt = new Date().toISOString();
    await c.env.DB.prepare('UPDATE user_emails SET feed_seen_at = ? WHERE email = ?')
        .bind(seenAt, me.email)
        .run();

    return c.json({ feed_seen_at: seenAt });
});

// A reaction is the individual's, so it is keyed on the caller's verified email
// rather than their column — both halves of a shared column react separately.
// `on` is explicit rather than a toggle, which makes the route idempotent: a
// double tap cannot flip the state twice, and a retry after a dropped response
// is harmless. The emoji travels in the body rather than the path because every
// one of them is an astral character a path param carries only percent-encoded.
app.put(
    '/api/posts/:post_id/reactions',
    zValidator('json', reactionUpdate, onInvalid),
    async (c) => {
        const me = await callerUser(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

        const postId = Number(c.req.param('post_id'));
        if (!Number.isInteger(postId) || postId <= 0) {
            return c.json({ error: 'post_id must be a positive integer' }, 400);
        }

        // Same gate, same 404: you cannot react to a note you cannot read.
        const post = await visiblePost(c, postId, me);
        if (!post) return c.json({ error: 'Unknown post' }, 404);

        const { emoji, on } = c.req.valid('json');
        if (on) {
            // The cap is on how many *distinct* emoji a note carries, so it can
            // only ever block a new one — joining a chip that already exists,
            // or removing anything, is never refused. Checked before the
            // INSERT rather than enforced in the schema because it depends on
            // the note's current state, and a 409 (not a 400) because the
            // request is well-formed and would have succeeded a moment ago.
            //
            // Known and accepted: this read and the INSERT below are not one
            // transaction, so two people adding two *different* new emoji to a
            // note sitting at 11 can both see 11, both pass, and leave it at 13.
            // Deliberately not closed. The cap is a layout guard, not an
            // invariant anything reads back — a thirteenth chip is a slightly
            // wider reaction bar, and the next attempt is refused normally — and
            // the window needs two of five people to act in the same instant.
            // Closing it would mean folding the count into the INSERT's own
            // WHERE (SQLite evaluates that atomically) and then distinguishing
            // "already there" from "cap refused" by a follow-up read, since both
            // surface as zero rows changed. That is a real cost in a route this
            // legible, paid for a miscount nobody can see. If the cap ever
            // becomes something a client depends on, that is the fix.
            const { results: distinct } = await c.env.DB.prepare(
                'SELECT DISTINCT emoji FROM reactions WHERE post_id = ?',
            )
                .bind(postId)
                .all();
            const isNew = !distinct.some((r) => r.emoji === emoji);
            if (isNew && distinct.length >= MAX_REACTIONS_PER_POST) {
                return c.json(
                    {
                        error: `A note can carry at most ${MAX_REACTIONS_PER_POST} different reactions`,
                    },
                    409,
                );
            }
            await c.env.DB.prepare(
                `INSERT OR IGNORE INTO reactions (post_id, email, emoji, created_at)
             VALUES (?, ?, ?, ?)`,
            )
                .bind(postId, me.email, emoji, new Date().toISOString())
                .run();
        } else {
            await c.env.DB.prepare(
                'DELETE FROM reactions WHERE post_id = ? AND email = ? AND emoji = ?',
            )
                .bind(postId, me.email, emoji)
                .run();
        }

        return c.json({ success: true, post_id: postId, emoji, on });
    },
);

// Editing a note changes its body and nothing else: created_at and offset_secs
// are frozen, so the note holds its place on the timeline however often it is
// rewritten, and reply_to_post_id is frozen so an edit cannot re-point a quote.
// Season-agnostic like the delete route — a post id alone identifies the row.
// Ownership is the same predicate delete uses: the individual who wrote it, or
// the column for a note predating individual attribution. Not-yours and
// not-real answer 404 alike.
app.patch('/api/posts/:post_id', zValidator('json', postEdit, onInvalid), async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const postId = Number(c.req.param('post_id'));
    if (!Number.isInteger(postId) || postId <= 0) {
        return c.json({ error: 'post_id must be a positive integer' }, 400);
    }

    const { body } = c.req.valid('json');
    const editedAt = new Date().toISOString();

    const { meta } = await c.env.DB.prepare(
        `UPDATE posts SET body = ?, edited_at = ?
         WHERE id = ? AND user_id = ? AND (author_email = ? OR author_email IS NULL)`,
    )
        .bind(body, editedAt, postId, me.id, me.email)
        .run();
    if (meta.changes === 0) return c.json({ error: 'Unknown post' }, 404);

    // The client refetches the whole discussion regardless, so this is a
    // receipt rather than a payload.
    return c.json({ success: true, post_id: postId, edited_at: editedAt });
});

// Season-agnostic: a post id alone identifies the row, so this doesn't go
// through resolveEpisode. Ownership is the individual, not the column — your
// partner's note is not yours to delete — except for a note with no recorded
// author, which predates individual attribution and so belongs to the column.
// Deleting a note you do not own and deleting one that never existed return the
// same 404: a distinct "forbidden" would turn this route into an oracle for
// which post ids are real.
app.delete('/api/posts/:post_id', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const postId = Number(c.req.param('post_id'));
    if (!Number.isInteger(postId) || postId <= 0) {
        return c.json({ error: 'post_id must be a positive integer' }, 400);
    }

    // Ownership is checked first, with a select, so a caller who does not own the
    // note cannot reach the cleanup statements below and strip its reactions or
    // detach its replies.
    const owned = await c.env.DB.prepare(
        `SELECT id FROM posts
         WHERE id = ? AND user_id = ? AND (author_email = ? OR author_email IS NULL)`,
    )
        .bind(postId, me.id, me.email)
        .first();
    if (!owned) return c.json({ error: 'Unknown post' }, 404);

    // Order matters whether or not D1 enforces foreign keys: dependants go before
    // the row they reference. Children are detached rather than deleted — a reply
    // survives its parent as an ordinary note, because delete is the author's
    // explicit "unsay it" and a [deleted] ghost would preserve what they removed.
    const [, , deleted] = await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM reactions WHERE post_id = ?').bind(postId),
        c.env.DB.prepare(
            'UPDATE posts SET reply_to_post_id = NULL WHERE reply_to_post_id = ?',
        ).bind(postId),
        c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId),
    ]);
    // The row vanished between the select and the batch — report it honestly
    // rather than as a success that deleted nothing.
    if (deleted.meta.changes === 0) return c.json({ error: 'Unknown post' }, 404);

    return c.json({ success: true, post_id: postId });
});

// The watch timer. A session also goes stale after three hours without a
// start, pause, resume, or post (see shared/session.js) — stop is the
// explicit, on-demand way to reach that same "no session" state, for whoever
// doesn't want to wait three hours for the retroactive correction
// (PUT .../offset) to become reachable in the UI. Sessions are per (user,
// episode) and deliberately not mutually exclusive — a forgotten one on
// another episode is harmless, because offsets freeze onto the post at write
// time and the stale session stamps nothing.
app.post(
    '/api/seasons/:season_id/episodes/:episode/timer',
    zValidator('json', timerAction, onInvalid),
    async (c) => {
        const [me, resolved] = await callerAndEpisode(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);
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
        } else if (action === 'stop') {
            // Idempotent: deleting a row that's already gone, or was never
            // there, is still success — the caller only cares that there's no
            // session afterward. Returns straight away rather than falling
            // into the shared session/offset_secs response below, since
            // there's no row left to select back.
            await c.env.DB.prepare(
                `DELETE FROM watch_sessions WHERE user_id = ? AND season_id = ? AND episode = ?`,
            )
                .bind(...key)
                .run();
            return c.json({
                success: true,
                season_id: season.id,
                episode,
                session: null,
                offset_secs: null,
            });
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
            } else if (action === 'resume') {
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
            } else {
                // Skip jumps elapsed_secs by delta_secs, forward or backward,
                // whether the session is running or paused — the total a read
                // reports is elapsed_secs plus whatever the running segment
                // adds (shared/session.js), so bumping elapsed_secs moves
                // that total regardless of state, and running_since needs no
                // change. Nothing here touches posts.offset_secs — that's
                // frozen at write time (see currentOffsetSecs above), which
                // is what keeps this forward-only: only a post written after
                // this update reads the new elapsed_secs.
                //
                // Clamped against the total offset (elapsed_secs plus
                // whatever the running segment currently adds — `banked`,
                // already computed above for the staleness check), not
                // against elapsed_secs alone: elapsed_secs sits at zero for a
                // session that's been running continuously since start (the
                // default flow), so clamping elapsed_secs alone made every
                // backward skip silently a no-op there. Relative rather than
                // absolute so two concurrent skips still compose instead of
                // one clobbering the other; the stored elapsed_secs can go
                // transiently negative while running (self-corrects on the
                // next pause, which always writes the freshly recomputed
                // `banked` total) — sessionOffsetSecs only cares about the
                // sum, not either term. `banked` is guaranteed non-null here:
                // the branch above already returned a 409 if it were null.
                const { delta_secs } = c.req.valid('json');
                const applied = Math.max(delta_secs, -banked);
                await c.env.DB.prepare(
                    `UPDATE watch_sessions
                     SET elapsed_secs = elapsed_secs + ?, last_activity_at = ?
                     WHERE user_id = ? AND season_id = ? AND episode = ?`,
                )
                    .bind(applied, now, ...key)
                    .run();
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

// Correct where this episode started for you. Timers drift because people press
// start at different points relative to the show — before the "previously on",
// after the cold open, or not at all because they skipped the recap — so the
// error is a constant shift and one number fixes it.
//
// The value is absolute rather than a delta, for the reason the reactions route
// takes an explicit `on` instead of toggling: the client computes the new total
// from what the server last reported, so a double-tap, a retry, or a slow
// network cannot accumulate a correction nobody asked for.
//
// Its own route rather than a fourth timer action: it writes no session, and it
// has to work when none exists. Noticing your notes sit in the wrong place
// happens while reading the board, long after the timer went stale.
app.put(
    '/api/seasons/:season_id/episodes/:episode/offset',
    zValidator('json', offsetAdjust, onInvalid),
    async (c) => {
        const [me, resolved] = await callerAndEpisode(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { adjust_secs } = c.req.valid('json');
        const key = [me.id, season.id, episode];

        if (adjust_secs === 0) {
            // "No correction" gets one representation rather than two.
            await c.env.DB.prepare(
                'DELETE FROM watch_offsets WHERE user_id = ? AND season_id = ? AND episode = ?',
            )
                .bind(...key)
                .run();
        } else {
            await c.env.DB.prepare(
                `INSERT INTO watch_offsets
                     (user_id, season_id, episode, adjust_secs, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (user_id, season_id, episode) DO UPDATE SET
                     adjust_secs = excluded.adjust_secs,
                     updated_at = excluded.updated_at`,
            )
                .bind(...key, adjust_secs, new Date().toISOString())
                .run();
        }

        return c.json({ success: true, season_id: season.id, episode, adjust_secs });
    },
);

// What the caller intends for one episode, as opposed to what they have already
// watched or said. One status today — skipping — and it carries a required
// reason, so the other people watching read a silent episode as deliberate
// rather than as nobody having got there yet.
//
// Absolute rather than a toggle, the same reason PUT .../reactions takes an
// explicit `on`: a retried or duplicated request lands on the same state instead
// of flipping back out of it. It is also what lets the reason change in place —
// recap to reunion is one request, not an unskip followed by a re-skip.
//
// Requires a real episode and roster membership, but deliberately neither a
// reveal nor a live session: deciding to skip an episode is something you do
// before watching it, so gating on either would be backwards.
app.put(
    '/api/seasons/:season_id/episodes/:episode/status',
    zValidator('json', episodeStatus, onInvalid),
    async (c) => {
        const [me, resolved] = await callerAndEpisode(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { status, reason = null } = c.req.valid('json');
        const key = [me.id, season.id, episode];

        if (status === null) {
            // "No status" gets one representation rather than two.
            await c.env.DB.prepare(
                'DELETE FROM episode_statuses WHERE user_id = ? AND season_id = ? AND episode = ?',
            )
                .bind(...key)
                .run();
        } else {
            // created_at is deliberately not in the DO UPDATE list: it records
            // when the skip was declared, and changing your mind about why is
            // not a new declaration.
            await c.env.DB.prepare(
                `INSERT INTO episode_statuses
                     (user_id, season_id, episode, status, reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (user_id, season_id, episode) DO UPDATE SET
                     status = excluded.status,
                     reason = excluded.reason`,
            )
                .bind(...key, status, reason, new Date().toISOString())
                .run();
        }

        return c.json({ success: true, season_id: season.id, episode, status, reason });
    },
);

app.all('/api/*', (c) => c.json({ error: 'Unknown API endpoint' }, 404));

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
