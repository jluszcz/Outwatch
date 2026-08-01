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
    await env.DB.exec('DELETE FROM reactions');
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
            "(45, '', 'https://en.wikipedia.org/wiki/Survivor_45', 13), " +
            "(46, '', 'https://en.wikipedia.org/wiki/Survivor_46', 13)",
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

// postNote, revealEpisode, watchSeason, and episodeView were `post`, `reveal`,
// `watch`, and `discussion` inside this describe block, scoped there because
// they collided with the narrower, older module-level `post`/`discussion`
// helpers above (used by ~30 call sites in the earlier suites). Hoisted to
// module scope, under these names, so Tasks 3 and 4 can share them instead of
// redefining the same block per task.
async function postNote(email, body, episode = 7, replyTo = undefined) {
    const r = await req('POST', `/api/seasons/45/episodes/${episode}/posts`, {
        body: replyTo === undefined ? { body } : { body, reply_to_post_id: replyTo },
        email,
    });
    return r;
}

async function revealEpisode(email, episode = 7) {
    return req('POST', `/api/seasons/45/episodes/${episode}/reveal`, { email });
}

async function watchSeason(email) {
    return req('POST', '/api/watched', { body: { season_id: 45 }, email });
}

async function episodeView(email, episode = 7) {
    const { episodes } = await (await req('GET', '/api/seasons/45/discussion', { email })).json();
    return episodes.find((e) => e.episode === episode);
}

describe('quote replies', () => {
    it('stores the parent and serializes it with its body', async () => {
        const { post: parent } = await (await postNote('bob@example.com', 'jeff is right')).json();
        await revealEpisode('alice@example.com');
        const r = await postNote('alice@example.com', 'agreed', 7, parent.id);
        expect(r.status).toBe(201);

        const ep = await episodeView('alice@example.com');
        const reply = ep.posts.find((p) => p.body === 'agreed');
        expect(reply.reply_to).toMatchObject({
            id: parent.id,
            author_name: 'Bob',
            body: 'jeff is right',
            mine: false,
        });
    });

    it('returns 404 for a parent in another episode', async () => {
        const { post: parent } = await (await postNote('alice@example.com', 'ep 6 note', 6)).json();
        const r = await postNote('alice@example.com', 'reply', 7, parent.id);
        expect(r.status).toBe(404);
    });

    // The reply-parent check enforces both axes independently: same episode
    // number is not enough if it belongs to a different season. The parent is
    // the caller's own note, so it is visible regardless of watched/reveal
    // state — isolating the season mismatch from the visibility gate.
    it('returns 404 for a parent in another season', async () => {
        const { post: parent } = await (
            await req('POST', '/api/seasons/46/episodes/7/posts', {
                body: { body: 'season 46 note' },
                email: 'alice@example.com',
            })
        ).json();
        const r = await postNote('alice@example.com', 'reply', 7, parent.id);
        expect(r.status).toBe(404);
    });

    it('returns 404 for a parent the caller cannot see', async () => {
        const { post: parent } = await (await postNote('bob@example.com', 'secret')).json();
        const r = await postNote('alice@example.com', 'reply', 7, parent.id);
        expect(r.status).toBe(404);
    });

    it('returns 404 for a parent that does not exist', async () => {
        const r = await postNote('alice@example.com', 'reply', 7, 999999);
        expect(r.status).toBe(404);
    });

    // The one case the locked form exists for: marking a season watched makes
    // every episode readable without writing a reveals row, so unmarking it
    // re-locks episodes the caller never explicitly revealed — while their own
    // reply, and its now-unreadable parent id, remain.
    it('hides a parent that became unreadable after an unmark', async () => {
        const { post: parent } = await (await postNote('bob@example.com', 'the blindside')).json();
        await watchSeason('alice@example.com');
        await postNote('alice@example.com', 'called it', 7, parent.id);
        await req('DELETE', '/api/watched/45', { email: 'alice@example.com' });

        const ep = await episodeView('alice@example.com');
        expect(ep.readable).toBe(false);
        const reply = ep.posts.find((p) => p.body === 'called it');
        expect(reply.reply_to).toEqual({ id: parent.id, locked: true });
        expect(JSON.stringify(ep)).not.toContain('the blindside');
    });

    it('leaves a reply intact when its parent is deleted', async () => {
        const { post: parent } = await (await postNote('alice@example.com', 'first')).json();
        await postNote('alice@example.com', 'second', 7, parent.id);
        const del = await req('DELETE', `/api/posts/${parent.id}`, { email: 'alice@example.com' });
        expect(del.status).toBe(200);

        const ep = await episodeView('alice@example.com');
        const reply = ep.posts.find((p) => p.body === 'second');
        expect(reply).toBeDefined();
        expect(reply.reply_to).toBeNull();
    });

    it('does not let a non-owner delete detach anything', async () => {
        const { post: parent } = await (await postNote('bob@example.com', 'bob note')).json();
        await revealEpisode('alice@example.com');
        await postNote('alice@example.com', 'alice reply', 7, parent.id);

        const del = await req('DELETE', `/api/posts/${parent.id}`, { email: 'alice@example.com' });
        expect(del.status).toBe(404);

        const ep = await episodeView('alice@example.com');
        const reply = ep.posts.find((p) => p.body === 'alice reply');
        expect(reply.reply_to.body).toBe('bob note');
    });
});

describe('PATCH /api/posts/:post_id', () => {
    it('rewrites the body and stamps edited_at without moving the note', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'typo hree')).json();
        const r = await req('PATCH', `/api/posts/${p.id}`, {
            body: { body: 'typo here' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);

        const ep = await episodeView('alice@example.com');
        const edited = ep.posts.find((x) => x.id === p.id);
        expect(edited.body).toBe('typo here');
        expect(edited.edited_at).not.toBeNull();
        expect(edited.created_at).toBe(p.created_at);
        expect(edited.offset_secs).toBe(p.offset_secs);
    });

    it('is null on edited_at until the note is edited', async () => {
        await postNote('alice@example.com', 'untouched');
        const ep = await episodeView('alice@example.com');
        expect(ep.posts[0].edited_at).toBeNull();
    });

    it('refuses a note written by the other individual in the same column', async () => {
        const { post: p } = await (await postNote('bob@example.com', 'bob wrote this')).json();
        const r = await req('PATCH', `/api/posts/${p.id}`, {
            body: { body: 'carol rewrote it' },
            email: 'carol@example.com',
        });
        expect(r.status).toBe(404);
    });

    // A note predating individual attribution belongs to the column, exactly as
    // the delete rule has it.
    it('allows the column to edit a note with no recorded author', async () => {
        await env.DB.exec(
            'INSERT INTO posts (season_id, episode, user_id, body, created_at) ' +
                "VALUES (45, 7, 'user-bob', 'legacy note', '2026-01-01T00:00:00.000Z')",
        );
        const row = await env.DB.prepare("SELECT id FROM posts WHERE body = 'legacy note'").first();
        const r = await req('PATCH', `/api/posts/${row.id}`, {
            body: { body: 'legacy note, fixed' },
            email: 'carol@example.com',
        });
        expect(r.status).toBe(200);
    });

    it('returns 400 for an empty body and one over 2000 characters', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        for (const body of ['', '   ', 'x'.repeat(2001)]) {
            const r = await req('PATCH', `/api/posts/${p.id}`, {
                body: { body },
                email: 'alice@example.com',
            });
            expect(r.status).toBe(400);
        }
    });

    it('returns 404 for a post that does not exist', async () => {
        const r = await req('PATCH', '/api/posts/999999', {
            body: { body: 'nope' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('shows an edited parent through to a reply that quotes it', async () => {
        const { post: parent } = await (await postNote('bob@example.com', 'before')).json();
        await revealEpisode('alice@example.com');
        await postNote('alice@example.com', 'quoting', 7, parent.id);
        await req('PATCH', `/api/posts/${parent.id}`, {
            body: { body: 'after' },
            email: 'bob@example.com',
        });

        const ep = await episodeView('alice@example.com');
        const reply = ep.posts.find((x) => x.body === 'quoting');
        expect(reply.reply_to.body).toBe('after');
    });

    // reply_to_post_id is named alongside created_at and offset_secs as frozen
    // by an edit — an edit that re-pointed a quote would silently rewrite which
    // note it answers.
    it('keeps reply_to_post_id frozen across an edit of the reply itself', async () => {
        const { post: parent } = await (await postNote('bob@example.com', 'the blindside')).json();
        await revealEpisode('alice@example.com');
        const { post: reply } = await (
            await postNote('alice@example.com', 'called it', 7, parent.id)
        ).json();

        const r = await req('PATCH', `/api/posts/${reply.id}`, {
            body: { body: 'called it, obviously' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);

        const ep = await episodeView('alice@example.com');
        const edited = ep.posts.find((x) => x.id === reply.id);
        expect(edited.body).toBe('called it, obviously');
        expect(edited.reply_to).toMatchObject({ id: parent.id, body: 'the blindside' });
    });
});

async function react(email, postId, emoji, on) {
    return req('PUT', `/api/posts/${postId}/reactions`, { body: { emoji, on }, email });
}

describe('PUT /api/posts/:post_id/reactions', () => {
    it('adds a reaction and is idempotent', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        expect((await react('alice@example.com', p.id, '👍', true)).status).toBe(200);
        await react('alice@example.com', p.id, '👍', true);

        const ep = await episodeView('alice@example.com');
        expect(ep.posts[0].reactions).toEqual([
            { emoji: '👍', count: 1, mine: true, names: ['Alice'] },
        ]);
    });

    it('removes a reaction, and removing an absent one is a no-op', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        await react('alice@example.com', p.id, '👍', true);
        await react('alice@example.com', p.id, '👍', false);
        expect((await react('alice@example.com', p.id, '👍', false)).status).toBe(200);

        const ep = await episodeView('alice@example.com');
        expect(ep.posts[0].reactions).toEqual([]);
    });

    it('lets one person apply several different emoji', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        await react('alice@example.com', p.id, '😮', true);
        await react('alice@example.com', p.id, '👍', true);

        const ep = await episodeView('alice@example.com');
        expect(ep.posts[0].reactions.map((r) => r.emoji).sort()).toEqual(['👍', '😮'].sort());
    });

    // Written straight to the table with chosen timestamps rather than through
    // the route: the ordering rule is about which emoji appeared first, and two
    // real requests can land in the same millisecond, which would make the
    // assertion depend on the tie-break instead of on the rule under test.
    it('orders chips by when each emoji first appeared, not by count', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        await revealEpisode('bob@example.com');
        await env.DB.batch(
            [
                ['bob@example.com', '🐍', '2026-01-01T00:00:03.000Z'],
                ['alice@example.com', '🔥', '2026-01-01T00:00:01.000Z'],
                ['bob@example.com', '🔥', '2026-01-01T00:00:04.000Z'],
                ['alice@example.com', '🗿', '2026-01-01T00:00:02.000Z'],
            ].map(([email, emoji, at]) =>
                env.DB.prepare(
                    'INSERT INTO reactions (post_id, email, emoji, created_at) VALUES (?, ?, ?, ?)',
                ).bind(p.id, email, emoji, at),
            ),
        );

        const ep = await episodeView('alice@example.com');
        // 🔥 leads on first use even though 🐍 and 🗿 have the same count, and
        // 🔥's second reaction does not move it.
        expect(ep.posts[0].reactions.map((r) => r.emoji)).toEqual(['🔥', '🗿', '🐍']);
        expect(ep.posts[0].reactions.map((r) => r.count)).toEqual([2, 1, 1]);
    });

    it('accepts any emoji, not just the quick row', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        // A multi-codepoint sequence, a ZWJ family, a flag, and a skin tone —
        // the shapes a picker or a phone keyboard actually produces.
        for (const emoji of ['❤️', '🐍', '👨‍👩‍👧‍👦', '🏳️‍🌈', '👍🏽']) {
            expect((await react('alice@example.com', p.id, emoji, true)).status).toBe(200);
        }

        const ep = await episodeView('alice@example.com');
        expect(ep.posts[0].reactions.map((r) => r.emoji).sort()).toEqual(
            ['❤️', '🐍', '👨‍👩‍👧‍👦', '🏳️‍🌈', '👍🏽'].sort(),
        );
    });

    // Reactions are the individual's, so the two halves of a shared column count
    // separately — unlike the watched checkbox they sit beside.
    it('counts both halves of a shared column separately', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        await revealEpisode('bob@example.com');
        await revealEpisode('carol@example.com');
        await react('bob@example.com', p.id, '🤣', true);
        await react('carol@example.com', p.id, '🤣', true);

        const ep = await episodeView('alice@example.com');
        const [chip] = ep.posts[0].reactions;
        expect(chip.count).toBe(2);
        expect(chip.names.sort()).toEqual(['Bob', 'Carol']);
        expect(chip.mine).toBe(false);
    });

    it('allows reacting to your own note', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        expect((await react('alice@example.com', p.id, '🤣', true)).status).toBe(200);
    });

    // The `v`-flag `\p{RGI_Emoji}` property is the whole validator, so this is
    // as much a check that workerd's regex engine supports it as it is a check
    // of the rule: if the property were unsupported the module would not even
    // parse, and if the anchors were dropped every case here would pass.
    it('returns 400 for anything that is not exactly one emoji', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        const bad = [
            'x', // plain text
            '', // empty
            ' ', // whitespace
            '👍👍', // two emoji
            'a👍', // text with an emoji in it
            '👍 ', // one emoji plus a trailing space
            '❤', // U+2764 without the U+FE0F variation selector: not RGI
            '‍', // a bare zero-width joiner
        ];
        for (const emoji of bad) {
            expect((await react('alice@example.com', p.id, emoji, true)).status).toBe(400);
        }
        for (const emoji of [1, null, true, ['👍']]) {
            expect((await react('alice@example.com', p.id, emoji, true)).status).toBe(400);
        }
    });

    it('caps a note at 12 distinct emoji but always allows toggling an existing one', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        const twelve = ['👍', '👎', '🤣', '😮', '🐍', '🔥', '🗿', '💀', '🎯', '🏆', '🥥', '🌴'];
        for (const emoji of twelve) {
            expect((await react('alice@example.com', p.id, emoji, true)).status).toBe(200);
        }

        // A thirteenth distinct emoji is refused...
        expect((await react('alice@example.com', p.id, '🦑', true)).status).toBe(409);

        // ...but a second person joining one of the twelve is not, and neither
        // is removing one. Removing frees a slot for the thirteenth.
        await revealEpisode('bob@example.com');
        expect((await react('bob@example.com', p.id, '🔥', true)).status).toBe(200);
        expect((await react('alice@example.com', p.id, '🌴', false)).status).toBe(200);
        expect((await react('alice@example.com', p.id, '🦑', true)).status).toBe(200);

        const ep = await episodeView('alice@example.com');
        expect(ep.posts[0].reactions).toHaveLength(12);
    });

    it('returns 404 for a post the caller cannot see', async () => {
        const { post: p } = await (await postNote('bob@example.com', 'hidden')).json();
        expect((await react('alice@example.com', p.id, '👍', true)).status).toBe(404);
    });

    it('returns 404 for a post that does not exist', async () => {
        expect((await react('alice@example.com', 999999, '👍', true)).status).toBe(404);
    });

    it('serializes no reactions for a foreign post on a locked board', async () => {
        const { post: p } = await (await postNote('bob@example.com', 'locked body')).json();
        await react('bob@example.com', p.id, '👍', true);

        const ep = await episodeView('alice@example.com');
        expect(ep.readable).toBe(false);
        expect(ep.posts).toHaveLength(0);
        expect(JSON.stringify(ep)).not.toContain('👍');
    });

    it('takes a post reactions with it when the post is deleted', async () => {
        const { post: p } = await (await postNote('alice@example.com', 'note')).json();
        await react('alice@example.com', p.id, '👍', true);
        await req('DELETE', `/api/posts/${p.id}`, { email: 'alice@example.com' });

        const { results } = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?',
        )
            .bind(p.id)
            .all();
        expect(results[0].n).toBe(0);
    });

    it('leaves reactions alone when a non-owner delete is refused', async () => {
        const { post: p } = await (await postNote('bob@example.com', 'bob note')).json();
        await react('bob@example.com', p.id, '👍', true);
        expect(
            (await req('DELETE', `/api/posts/${p.id}`, { email: 'alice@example.com' })).status,
        ).toBe(404);

        const { results } = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?',
        )
            .bind(p.id)
            .all();
        expect(results[0].n).toBe(1);
    });
});
