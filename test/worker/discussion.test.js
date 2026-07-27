import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/index.js';
import { accessEnv, signAccessToken, stubJwksEndpoint } from './access-token.js';

const mockAssetsFetch = vi.fn().mockResolvedValue(new Response('index.html'));

function makeEnv(overrides = {}) {
    return {
        ...env,
        ...accessEnv,
        DEV_USER_EMAIL: undefined,
        ASSETS: { fetch: mockAssetsFetch },
        DB: env.DB,
        ...overrides,
    };
}

async function req(method, path, { body, email, envOverrides } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    if (email) init.headers['Cf-Access-Jwt-Assertion'] = await signAccessToken({ email });
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv(envOverrides));
}

// Children before parents — the new tables carry foreign keys into seasons and users.
beforeEach(async () => {
    // Serve the test signing key the way Cloudflare serves the team's real one.
    await stubJwksEndpoint();
    await env.DB.exec('DELETE FROM watch_sessions');
    await env.DB.exec('DELETE FROM reveals');
    await env.DB.exec('DELETE FROM posts');
    await env.DB.exec('DELETE FROM watched');
    await env.DB.exec('DELETE FROM user_emails');
    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM seasons');
    await env.DB.exec("INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1)");
    await env.DB.exec(
        "INSERT INTO users (id, name, sort_order) VALUES ('user-bob', 'Bob & Carol', 2)",
    );
    await env.DB.exec(
        'INSERT INTO user_emails (email, user_id, name) VALUES ' +
            "('alice@example.com', 'user-alice', NULL), " +
            "('bob@example.com', 'user-bob', 'Bob'), " +
            "('carol@example.com', 'user-bob', 'Carol')",
    );
    await env.DB.exec(
        'INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES ' +
            "(45, '', 'https://en.wikipedia.org/wiki/Survivor_45', 13)",
    );
});

describe('POST /api/seasons/:season_id/episodes/:episode/posts', () => {
    it('stores a note attributed to the caller', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'blindside was insane' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(201);
        const { post } = await r.json();
        expect(post).toMatchObject({
            season_id: 45,
            episode: 7,
            user_id: 'user-alice',
            body: 'blindside was insane',
            offset_secs: null,
        });
    });

    it('trims surrounding whitespace', async () => {
        const { post } = await (
            await req('POST', '/api/seasons/45/episodes/7/posts', {
                body: { body: '  spaced out  ' },
                email: 'alice@example.com',
            })
        ).json();
        expect(post.body).toBe('spaced out');
    });

    it('attributes to the caller, not a client-supplied id', async () => {
        const { post } = await (
            await req('POST', '/api/seasons/45/episodes/7/posts', {
                body: { body: 'note', user_id: 'user-bob' },
                email: 'alice@example.com',
            })
        ).json();
        expect(post.user_id).toBe('user-alice');
    });

    it('returns 400 for an empty or whitespace-only body', async () => {
        for (const body of ['', '   ']) {
            const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
                body: { body },
                email: 'alice@example.com',
            });
            expect(r.status).toBe(400);
        }
    });

    it('returns 400 for a body over 2000 characters', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'x'.repeat(2001) },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('accepts a body of exactly 2000 characters', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'x'.repeat(2000) },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(201);
    });

    it('returns 404 for episode 0 and for an episode past episode_count', async () => {
        for (const episode of [0, 14, 99]) {
            const r = await req(`POST`, `/api/seasons/45/episodes/${episode}/posts`, {
                body: { body: 'note' },
                email: 'alice@example.com',
            });
            expect(r.status).toBe(404);
        }
    });

    it('returns 400 for a non-numeric episode', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/abc/posts', {
            body: { body: 'note' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('returns 404 for an unknown season', async () => {
        const r = await req('POST', '/api/seasons/999/episodes/1/posts', {
            body: { body: 'note' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('returns 403 with no identity and for a stranger', async () => {
        const anon = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'note' },
        });
        expect(anon.status).toBe(403);
        const stranger = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'note' },
            email: 'stranger@example.com',
        });
        expect(stranger.status).toBe(403);
    });

    it('records which half of a shared column wrote the note', async () => {
        await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'she is cooked' },
            email: 'carol@example.com',
        });

        const row = await env.DB.prepare('SELECT user_id, author_email FROM posts').first();
        expect(row).toEqual({ user_id: 'user-bob', author_email: 'carol@example.com' });
    });

    it('does not echo the author email back to the client', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'called it' },
            email: 'carol@example.com',
        });
        const { post } = await r.json();
        expect(post).not.toHaveProperty('author_email');
    });
});

const post = (email, episode, body) =>
    req('POST', `/api/seasons/45/episodes/${episode}/posts`, { body: { body }, email });

const discussion = (email) => req('GET', '/api/seasons/45/discussion', { email });

describe('GET /api/seasons/:season_id/discussion', () => {
    it('returns one entry per episode, in order', async () => {
        const { season, episodes } = await (await discussion('alice@example.com')).json();
        expect(season).toMatchObject({ id: 45, episode_count: 13 });
        expect(episodes).toHaveLength(13);
        expect(episodes.map((e) => e.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    });

    it('hides other people’s bodies on a locked board but reports count and authors', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await post('bob@example.com', 7, 'told you');
        await post('alice@example.com', 7, 'called it');

        const { episodes } = await (await discussion('alice@example.com')).json();
        const ep7 = episodes.find((e) => e.episode === 7);

        expect(ep7.readable).toBe(false);
        expect(ep7.count).toBe(3);
        expect(ep7.authors).toEqual([
            { name: 'Bob', mine: false },
            { name: 'Alice', mine: true },
        ]);
        expect(ep7.posts).toHaveLength(1);
        expect(ep7.posts[0].body).toBe('called it');
    });

    it('leaks no hidden body anywhere in the serialized response', async () => {
        await post('bob@example.com', 7, 'SECRET-BLINDSIDE');
        const r = await discussion('alice@example.com');
        expect(await r.text()).not.toContain('SECRET-BLINDSIDE');
    });

    it('shows everything once the caller has watched the season', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await req('POST', '/api/watched', { body: { season_id: 45 }, email: 'alice@example.com' });

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.every((e) => e.readable)).toBe(true);
        const ep7 = episodes.find((e) => e.episode === 7);
        expect(ep7.posts.map((p) => p.body)).toEqual(['no way she flips']);
    });

    it('returns empty locked boards for a caller who is not on the roster', async () => {
        await post('alice@example.com', 7, 'called it');
        const { me, episodes } = await (await discussion('stranger@example.com')).json();
        expect(me).toBeNull();
        const ep7 = episodes.find((e) => e.episode === 7);
        expect(ep7.readable).toBe(false);
        expect(ep7.count).toBe(1);
        expect(ep7.posts).toEqual([]);
    });

    it('returns 404 for an unknown season', async () => {
        expect((await req('GET', '/api/seasons/999/discussion')).status).toBe(404);
    });

    it('returns 400 for a non-numeric season id', async () => {
        expect((await req('GET', '/api/seasons/abc/discussion')).status).toBe(400);
    });
});

describe('note attribution', () => {
    // The whole point of the feature: two logins, one column, two bylines.
    it('names each half of a shared column separately', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await post('carol@example.com', 7, 'she is cooked');
        // Reading requires the episode be open — alice has not watched season 45.
        await req('POST', '/api/seasons/45/episodes/7/reveal', { email: 'alice@example.com' });

        const { episodes } = await (await discussion('alice@example.com')).json();
        const names = episodes.find((e) => e.episode === 7).posts.map((p) => p.author_name);
        expect(names).toEqual(['Bob', 'Carol']);
    });

    it('gives the two people distinct accent slots', async () => {
        await post('bob@example.com', 7, 'one');
        await post('carol@example.com', 7, 'two');
        await req('POST', '/api/seasons/45/episodes/7/reveal', { email: 'alice@example.com' });

        const { episodes } = await (await discussion('alice@example.com')).json();
        const [first, second] = episodes.find((e) => e.episode === 7).posts;
        expect(first.author_index).not.toBe(second.author_index);
    });

    // Viewer-independent: a person's colour must not shift depending on who is
    // looking, which is the one thing an index computed per-request could get
    // wrong.
    it('gives a person the same slot whoever is asking', async () => {
        await post('carol@example.com', 7, 'two');
        await req('POST', '/api/seasons/45/episodes/7/reveal', { email: 'alice@example.com' });

        const seenBy = async (email) => {
            const { episodes } = await (await discussion(email)).json();
            return episodes.find((e) => e.episode === 7).posts[0].author_index;
        };
        expect(await seenBy('alice@example.com')).toBe(await seenBy('bob@example.com'));
    });

    it('falls back to the column name when the roster has no individual name', async () => {
        await post('alice@example.com', 7, 'called it');

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).posts[0].author_name).toBe('Alice');
    });

    it('marks only your own notes as yours, not your partner’s', async () => {
        await post('bob@example.com', 7, 'mine');
        await post('carol@example.com', 7, 'theirs');

        const { episodes } = await (await discussion('bob@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).posts.map((p) => p.mine)).toEqual([
            true,
            false,
        ]);
    });

    // Un-attributed notes predate the feature. They belong to the column, so
    // both partners still own them — matching what the delete route allows.
    it('treats a note with no author as the whole column’s', async () => {
        await post('bob@example.com', 7, 'from before');
        await env.DB.exec('UPDATE posts SET author_email = NULL');

        const { episodes } = await (await discussion('carol@example.com')).json();
        const [only] = episodes.find((e) => e.episode === 7).posts;
        expect(only).toMatchObject({ author_name: 'Bob & Carol', author_index: null, mine: true });
    });

    it('leaves an author who is no longer on the roster unplaceable', async () => {
        await post('carol@example.com', 7, 'goodbye');
        // posts.author_email has a real FK into user_emails, and D1 enforces it
        // unconditionally (PRAGMA foreign_keys can't be turned off). Deferring
        // the check for this one statement is the only way to land a post on a
        // login the roster no longer has — exactly the state this test targets.
        await env.DB.exec(
            'PRAGMA defer_foreign_keys = ON; ' +
                "UPDATE posts SET author_email = 'ghost@example.com'; " +
                'PRAGMA defer_foreign_keys = OFF;',
        );

        const { episodes } = await (await discussion('bob@example.com')).json();
        const [only] = episodes.find((e) => e.episode === 7).posts;
        expect(only).toMatchObject({ author_name: 'Bob & Carol', author_index: null, mine: false });
    });

    it('names individuals in a locked episode’s author list', async () => {
        await post('carol@example.com', 7, 'she is cooked');

        const { episodes } = await (await discussion('alice@example.com')).json();
        const ep = episodes.find((e) => e.episode === 7);
        expect(ep.readable).toBe(false);
        expect(ep.authors).toEqual([{ name: 'Carol', mine: false }]);
    });

    it('lists an author once however many notes they wrote', async () => {
        await post('carol@example.com', 7, 'one');
        await post('carol@example.com', 7, 'two');

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).authors).toHaveLength(1);
    });

    // The spoiler gate stays column-level: a couple watches together, so a
    // partner's note is not a spoiler even on an episode you have not opened.
    it('still shows a partner’s notes on a locked board', async () => {
        await post('carol@example.com', 7, 'she is cooked');

        const { episodes } = await (await discussion('bob@example.com')).json();
        const ep = episodes.find((e) => e.episode === 7);
        expect(ep.readable).toBe(false);
        expect(ep.posts).toHaveLength(1);
    });

    it('never serializes an email', async () => {
        await post('carol@example.com', 7, 'she is cooked');

        const body = await (await discussion('carol@example.com')).text();
        expect(body).not.toContain('@example.com');
    });
});

const reveal = (email, episode) =>
    req('POST', `/api/seasons/45/episodes/${episode}/reveal`, { email });

describe('POST /api/seasons/:season_id/episodes/:episode/reveal', () => {
    it('opens that episode and leaves the others locked', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await post('bob@example.com', 8, 'still reeling');

        expect((await reveal('alice@example.com', 7)).status).toBe(200);

        const { episodes } = await (await discussion('alice@example.com')).json();
        const ep7 = episodes.find((e) => e.episode === 7);
        const ep8 = episodes.find((e) => e.episode === 8);
        expect(ep7.readable).toBe(true);
        expect(ep7.posts.map((p) => p.body)).toEqual(['no way she flips']);
        expect(ep8.readable).toBe(false);
        expect(ep8.posts).toEqual([]);
    });

    it('is idempotent', async () => {
        await reveal('alice@example.com', 7);
        expect((await reveal('alice@example.com', 7)).status).toBe(200);
        const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM reveals').first();
        expect(row.count).toBe(1);
    });

    it('reveals only for the caller', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await reveal('alice@example.com', 7);
        const { episodes } = await (await discussion('bob@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).readable).toBe(false);
    });

    it('survives un-marking the season as watched', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await reveal('alice@example.com', 7);
        await req('POST', '/api/watched', { body: { season_id: 45 }, email: 'alice@example.com' });
        await req('DELETE', '/api/watched/45', { email: 'alice@example.com' });

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).readable).toBe(true);
        expect(episodes.find((e) => e.episode === 8).readable).toBe(false);
    });

    it('returns 404 for an episode past episode_count and 403 for a stranger', async () => {
        expect((await reveal('alice@example.com', 14)).status).toBe(404);
        expect((await reveal('stranger@example.com', 7)).status).toBe(403);
    });
});

describe('DELETE /api/posts/:post_id', () => {
    it('removes your own note', async () => {
        const { post: mine } = await (await post('alice@example.com', 7, 'called it')).json();
        const r = await req('DELETE', `/api/posts/${mine.id}`, { email: 'alice@example.com' });
        expect(r.status).toBe(200);

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).count).toBe(0);
    });

    it('refuses someone else’s note and leaves it intact', async () => {
        const { post: theirs } = await (
            await post('bob@example.com', 7, 'no way she flips')
        ).json();
        const r = await req('DELETE', `/api/posts/${theirs.id}`, { email: 'alice@example.com' });
        expect(r.status).toBe(404);

        const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM posts').first();
        expect(row.count).toBe(1);
    });

    it('returns the same 404 for a note that does not exist', async () => {
        // Deliberately indistinguishable from the not-yours case: a distinct
        // status would let anyone probe for which post ids are real.
        const r = await req('DELETE', '/api/posts/999999', { email: 'alice@example.com' });
        expect(r.status).toBe(404);
    });

    it('refuses to delete a note your partner wrote', async () => {
        const { post: theirs } = await (await post('bob@example.com', 7, 'ours')).json();
        const r = await req('DELETE', `/api/posts/${theirs.id}`, { email: 'carol@example.com' });
        expect(r.status).toBe(404);

        const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM posts').first();
        expect(row.count).toBe(1);
    });

    it('lets you delete your own note from a shared column', async () => {
        const { post: mine } = await (await post('carol@example.com', 7, 'mine')).json();
        const r = await req('DELETE', `/api/posts/${mine.id}`, { email: 'carol@example.com' });
        expect(r.status).toBe(200);
    });

    // An un-attributed note predates individual authorship. It belongs to the
    // column, so either partner may delete it rather than it being stranded.
    it('lets either partner delete a note with no recorded author', async () => {
        const { post: old } = await (await post('bob@example.com', 7, 'from before')).json();
        await env.DB.exec('UPDATE posts SET author_email = NULL');

        const r = await req('DELETE', `/api/posts/${old.id}`, { email: 'carol@example.com' });
        expect(r.status).toBe(200);
    });

    it('returns 400 for a non-numeric id and 403 with no identity', async () => {
        expect((await req('DELETE', '/api/posts/abc', { email: 'alice@example.com' })).status).toBe(
            400,
        );
        expect((await req('DELETE', '/api/posts/1')).status).toBe(403);
    });
});

const timer = (email, episode, action) =>
    req('POST', `/api/seasons/45/episodes/${episode}/timer`, { body: { action }, email });

describe('POST /api/seasons/:season_id/episodes/:episode/timer', () => {
    it('starts a running session at zero', async () => {
        const r = await timer('alice@example.com', 7, 'start');
        expect(r.status).toBe(200);
        const { session, offset_secs } = await r.json();
        expect(session.elapsed_secs).toBe(0);
        expect(session.running_since).not.toBeNull();
        expect(offset_secs).toBeLessThan(5);
    });

    it('stamps a note posted while the timer runs', async () => {
        await timer('alice@example.com', 7, 'start');
        const { post: note } = await (await post('alice@example.com', 7, 'called it')).json();
        expect(note.offset_secs).not.toBeNull();
        expect(note.offset_secs).toBeLessThan(5);
    });

    it('banks elapsed time on pause and freezes the offset', async () => {
        await env.DB.exec(
            'INSERT INTO watch_sessions (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at) ' +
                "VALUES ('user-alice', 45, 7, 0, '2026-07-25T21:00:00.000Z', '2026-07-25T21:00:00.000Z')",
        );
        // Rewrite running_since to a known 600s ago so the banked total is exact.
        const since = new Date(Date.now() - 600_000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET running_since = ?, last_activity_at = ?')
            .bind(since, since)
            .run();

        const { session } = await (await timer('alice@example.com', 7, 'pause')).json();
        expect(session.running_since).toBeNull();
        expect(session.elapsed_secs).toBeGreaterThanOrEqual(600);
        expect(session.elapsed_secs).toBeLessThan(610);
    });

    it('does not bank the same stretch twice on a double pause', async () => {
        const since = new Date(Date.now() - 600_000).toISOString();
        await env.DB.exec(
            'INSERT INTO watch_sessions (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at) ' +
                `VALUES ('user-alice', 45, 7, 0, '${since}', '${since}')`,
        );

        const first = await (await timer('alice@example.com', 7, 'pause')).json();
        const second = await (await timer('alice@example.com', 7, 'pause')).json();

        expect(first.session.elapsed_secs).toBeGreaterThanOrEqual(600);
        expect(second.session.elapsed_secs).toBe(first.session.elapsed_secs);
        expect(second.session.running_since).toBeNull();
    });

    it('carries the frozen offset onto a note written while paused', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare(
            'UPDATE watch_sessions SET elapsed_secs = 900, running_since = NULL',
        ).run();
        const { post: note } = await (await post('alice@example.com', 7, 'paused to type')).json();
        expect(note.offset_secs).toBe(900);
    });

    it('continues from the banked total on resume', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare(
            'UPDATE watch_sessions SET elapsed_secs = 900, running_since = NULL',
        ).run();
        const { session, offset_secs } = await (
            await timer('alice@example.com', 7, 'resume')
        ).json();
        expect(session.elapsed_secs).toBe(900);
        expect(session.running_since).not.toBeNull();
        expect(offset_secs).toBeGreaterThanOrEqual(900);
        expect(offset_secs).toBeLessThan(905);
    });

    it('zeroes the session when started again', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare('UPDATE watch_sessions SET elapsed_secs = 900').run();
        const { session } = await (await timer('alice@example.com', 7, 'start')).json();
        expect(session.elapsed_secs).toBe(0);
    });

    it('leaves a note untimed once the session has been idle three hours', async () => {
        await timer('alice@example.com', 7, 'start');
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET running_since = ?, last_activity_at = ?')
            .bind(stale, stale)
            .run();

        const { post: note } = await (await post('alice@example.com', 7, 'next morning')).json();
        expect(note.offset_secs).toBeNull();
    });

    it('refuses to pause a stale session and leaves it untouched', async () => {
        await timer('alice@example.com', 7, 'start');
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET running_since = ?, last_activity_at = ?')
            .bind(stale, stale)
            .run();

        const r = await timer('alice@example.com', 7, 'pause');
        expect(r.status).toBe(409);
        const { error } = await r.json();
        expect(error).toMatch(/expired/i);

        const row = await env.DB.prepare(
            'SELECT elapsed_secs, running_since, last_activity_at FROM watch_sessions WHERE user_id = ?',
        )
            .bind('user-alice')
            .first();
        expect(row.elapsed_secs).toBe(0);
        expect(row.running_since).toBe(stale);
        expect(row.last_activity_at).toBe(stale);
    });

    it('refuses to resume a stale session and leaves it untouched', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare(
            'UPDATE watch_sessions SET elapsed_secs = 900, running_since = NULL',
        ).run();
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET last_activity_at = ?').bind(stale).run();

        const r = await timer('alice@example.com', 7, 'resume');
        expect(r.status).toBe(409);
        const { error } = await r.json();
        expect(error).toMatch(/expired/i);

        const row = await env.DB.prepare(
            'SELECT elapsed_secs, running_since, last_activity_at FROM watch_sessions WHERE user_id = ?',
        )
            .bind('user-alice')
            .first();
        expect(row.elapsed_secs).toBe(900);
        expect(row.running_since).toBeNull();
        expect(row.last_activity_at).toBe(stale);
    });

    it('keeps a session live across a post', async () => {
        await timer('alice@example.com', 7, 'start');
        const nearly = new Date(Date.now() - 2.9 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET last_activity_at = ?').bind(nearly).run();
        await post('alice@example.com', 7, 'still here');

        const row = await env.DB.prepare(
            'SELECT last_activity_at FROM watch_sessions WHERE user_id = ?',
        )
            .bind('user-alice')
            .first();
        expect(Date.parse(row.last_activity_at)).toBeGreaterThan(Date.parse(nearly));
    });

    it('keeps sessions per episode and per user', async () => {
        await timer('alice@example.com', 7, 'start');
        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).session).not.toBeNull();
        expect(episodes.find((e) => e.episode === 8).session).toBeNull();

        const bob = await (await discussion('bob@example.com')).json();
        expect(bob.episodes.find((e) => e.episode === 7).session).toBeNull();
    });

    it('returns 400 for an unknown action and 403 for a stranger', async () => {
        expect((await timer('alice@example.com', 7, 'stop')).status).toBe(400);
        expect((await timer('stranger@example.com', 7, 'start')).status).toBe(403);
    });
});
