import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { HTTPException } from 'hono/http-exception';
import worker from '../../src/index.js';
import { accessEnv, signAccessToken, stubJwksEndpoint } from './access-token.js';

const mockAssetsFetch = vi.fn().mockResolvedValue(new Response('index.html'));

function makeEnv(overrides = {}) {
    // Force DEV_USER_EMAIL off by default so the no-identity / 403 tests assert
    // the real unauthenticated branch. `env` carries the developer's local
    // .dev.vars value, which would otherwise leak in and make those tests pass
    // (or fail) incidentally depending on local config. Tests that need the
    // dev-fallback behavior re-add it via envOverrides.
    return {
        ...env,
        ...accessEnv,
        DEV_USER_EMAIL: undefined,
        ASSETS: { fetch: mockAssetsFetch },
        DB: env.DB,
        ...overrides,
    };
}

// `email` signs a Cloudflare Access token for that address, the way Access would.
// Omit it to act as an unauthenticated request (an unknown user, or a request that
// never went through Access at all). test/worker/access.test.js covers what
// happens to a token that doesn't verify.
async function req(method, path, { body, email, envOverrides } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    if (email) init.headers['Cf-Access-Jwt-Assertion'] = await signAccessToken({ email });
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv(envOverrides));
}

// Schema comes from the real migrations/*.sql, applied in test/apply-migrations.js.
beforeEach(async () => {
    // Access tokens are verified against the team's published keys, so the test
    // signing key has to be served the way Cloudflare serves the real one.
    await stubJwksEndpoint();
    // Children before parents: the timer, reveal, status, and post tables all carry
    // foreign keys into users and seasons, and leftover rows from any of the
    // discussion-adjacent tests below would otherwise make the DELETE FROM
    // users / seasons further down fail.
    await env.DB.exec('DELETE FROM watch_sessions');
    await env.DB.exec('DELETE FROM watch_offsets');
    await env.DB.exec('DELETE FROM episode_statuses');
    await env.DB.exec('DELETE FROM reveals');
    await env.DB.exec('DELETE FROM posts');
    await env.DB.exec('DELETE FROM watched');
    await env.DB.exec('DELETE FROM user_emails');
    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM seasons');
    // 'Alice' is one person; 'Bob & Carol' is a couple sharing a column with two emails.
    await env.DB.prepare(
        "INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1)",
    ).run();
    await env.DB.prepare(
        "INSERT INTO users (id, name, sort_order) VALUES ('user-bob', 'Bob & Carol', 2)",
    ).run();
    await env.DB.exec(
        'INSERT INTO user_emails (email, user_id) VALUES ' +
            "('alice@example.com', 'user-alice'), " +
            "('bob@example.com', 'user-bob'), " +
            "('carol@example.com', 'user-bob')",
    );
    await env.DB.prepare(
        "INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo', 13)",
    ).run();
    await env.DB.prepare(
        "INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES (41, '', 'https://en.wikipedia.org/wiki/Survivor_41', 13)",
    ).run();
});

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

describe('static assets', () => {
    it('serves / via ASSETS', async () => {
        const response = await req('GET', '/');
        expect(mockAssetsFetch).toHaveBeenCalled();
        expect(await response.text()).toBe('index.html');
    });

    it('returns 404 JSON for unknown /api/* paths', async () => {
        const response = await req('GET', '/api/nope');
        expect(response.status).toBe(404);
        expect((await response.json()).error).toBe('Unknown API endpoint');
    });
});

// ---------------------------------------------------------------------------
// Cache headers
// ---------------------------------------------------------------------------

// Every API response is per-caller and immediately stale — the spoiler gate
// alone means two people asking for the same URL get different bodies — so none
// of it may be held by a browser or an intermediary.
describe('cache headers', () => {
    it('marks a successful API response no-store', async () => {
        const r = await req('GET', '/api/board', { email: 'alice@example.com' });
        expect(r.headers.get('Cache-Control')).toBe('no-store');
    });

    it('marks the unknown-endpoint 404 no-store', async () => {
        const r = await req('GET', '/api/nope');
        expect(r.headers.get('Cache-Control')).toBe('no-store');
    });

    // The header is set before the handler runs precisely so this case is
    // covered: a throw rejects next(), so a response built by app.onError never
    // comes back through the middleware to be decorated on the way out.
    it('marks an error response no-store', async () => {
        const r = await req('GET', '/api/board', {
            envOverrides: {
                DB: {
                    prepare() {
                        throw new Error('boom');
                    },
                },
            },
        });
        expect(r.status).toBe(500);
        expect(r.headers.get('Cache-Control')).toBe('no-store');
    });

    it('leaves static assets alone', async () => {
        const r = await req('GET', '/');
        expect(r.headers.get('Cache-Control')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
    it('returns JSON 500 when an unexpected error is thrown', async () => {
        const r = await req('GET', '/api/board', {
            envOverrides: {
                DB: {
                    prepare() {
                        throw new Error('boom');
                    },
                },
            },
        });
        expect(r.status).toBe(500);
        expect((await r.json()).error).toBe('Internal error');
    });

    it('honors a custom Response attached to an HTTPException', async () => {
        const r = await req('GET', '/api/board', {
            envOverrides: {
                DB: {
                    prepare() {
                        throw new HTTPException(503, {
                            res: new Response(JSON.stringify({ error: 'Down for maintenance' }), {
                                status: 503,
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Retry-After': '30',
                                },
                            }),
                        });
                    },
                },
            },
        });
        expect(r.status).toBe(503);
        expect(r.headers.get('Retry-After')).toBe('30');
        expect((await r.json()).error).toBe('Down for maintenance');
    });
});

// ---------------------------------------------------------------------------
// GET /api/board
// ---------------------------------------------------------------------------

describe('GET /api/board', () => {
    it('returns users ordered by sort_order and seasons ordered by id', async () => {
        const r = await req('GET', '/api/board');
        expect(r.status).toBe(200);
        const { users, seasons } = await r.json();
        expect(users.map((u) => u.name)).toEqual(['Alice', 'Bob & Carol']);
        expect(seasons.map((s) => s.id)).toEqual([1, 41]);
    });

    it('does not leak user emails to the client', async () => {
        const { users } = await (await req('GET', '/api/board')).json();
        expect(users[0]).not.toHaveProperty('email');
    });

    it('resolves "me" from the Access token', async () => {
        const { me } = await (await req('GET', '/api/board', { email: 'bob@example.com' })).json();
        expect(me).toEqual({ id: 'user-bob', name: 'Bob & Carol' });
    });

    it('resolves either email of a shared column to the same user', async () => {
        const bob = await (await req('GET', '/api/board', { email: 'bob@example.com' })).json();
        const carol = await (await req('GET', '/api/board', { email: 'carol@example.com' })).json();
        expect(bob.me.id).toBe('user-bob');
        expect(carol.me.id).toBe('user-bob');
    });

    it('matches the token email case-insensitively', async () => {
        const { me } = await (await req('GET', '/api/board', { email: 'BOB@EXAMPLE.COM' })).json();
        expect(me.id).toBe('user-bob');
    });

    it('matches a mixed-case email stored in the roster (COLLATE NOCASE)', async () => {
        await env.DB.prepare(
            "INSERT INTO user_emails (email, user_id) VALUES ('Alice.Second@Example.COM', 'user-alice')",
        ).run();
        const { me } = await (
            await req('GET', '/api/board', { email: 'alice.second@example.com' })
        ).json();
        expect(me.id).toBe('user-alice');
    });

    it('returns me: null when there is no identity', async () => {
        const { me } = await (await req('GET', '/api/board')).json();
        expect(me).toBeNull();
    });

    it('returns me: null when the email is not a known user', async () => {
        const { me } = await (
            await req('GET', '/api/board', { email: 'stranger@example.com' })
        ).json();
        expect(me).toBeNull();
    });

    it('falls back to DEV_USER_EMAIL when no Access token is present', async () => {
        const { me } = await (
            await req('GET', '/api/board', {
                envOverrides: { DEV_USER_EMAIL: 'alice@example.com' },
            })
        ).json();
        expect(me.id).toBe('user-alice');
    });

    it('includes currently_watching_season_id (null by default) per user', async () => {
        const { users } = await (await req('GET', '/api/board')).json();
        expect(users[0].currently_watching_season_id).toBeNull();
        expect(users[1].currently_watching_season_id).toBeNull();
    });

    it('reflects currently_watching_season_id after it is set', async () => {
        await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        const { users } = await (await req('GET', '/api/board')).json();
        const alice = users.find((u) => u.id === 'user-alice');
        expect(alice.currently_watching_season_id).toBe(1);
    });

    it('reports watched_by per season', async () => {
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'alice@example.com' });
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'bob@example.com' });
        const { seasons } = await (await req('GET', '/api/board')).json();
        const s1 = seasons.find((s) => s.id === 1);
        expect(s1.watched_by.sort()).toEqual(['user-alice', 'user-bob']);
        const s41 = seasons.find((s) => s.id === 41);
        expect(s41.watched_by).toEqual([]);
    });

    it('includes episode_count per season', async () => {
        const { seasons } = await (await req('GET', '/api/board')).json();
        expect(seasons.find((s) => s.id === 1).episode_count).toBe(13);
    });

    it('reports post_count across every episode of a season', async () => {
        await req('POST', '/api/seasons/1/episodes/1/posts', {
            body: { body: 'first' },
            email: 'alice@example.com',
        });
        await req('POST', '/api/seasons/1/episodes/5/posts', {
            body: { body: 'second' },
            email: 'bob@example.com',
        });
        const { seasons } = await (await req('GET', '/api/board')).json();
        expect(seasons.find((s) => s.id === 1).post_count).toBe(2);
        expect(seasons.find((s) => s.id === 41).post_count).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// PUT /api/currently-watching
// ---------------------------------------------------------------------------

describe('PUT /api/currently-watching', () => {
    it('sets the currently-watching season for the caller', async () => {
        const r = await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body).toMatchObject({ success: true, user_id: 'user-alice', season_id: 1 });
    });

    it('clears the currently-watching season when season_id is null', async () => {
        await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        await req('PUT', '/api/currently-watching', {
            body: { season_id: null },
            email: 'alice@example.com',
        });
        const { users } = await (await req('GET', '/api/board')).json();
        const alice = users.find((u) => u.id === 'user-alice');
        expect(alice.currently_watching_season_id).toBeNull();
    });

    it('updates the board response immediately', async () => {
        await req('PUT', '/api/currently-watching', {
            body: { season_id: 41 },
            email: 'bob@example.com',
        });
        const { users } = await (await req('GET', '/api/board')).json();
        const bob = users.find((u) => u.id === 'user-bob');
        expect(bob.currently_watching_season_id).toBe(41);
    });

    it('only updates the caller — other users are unaffected', async () => {
        await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        const { users } = await (await req('GET', '/api/board')).json();
        const bob = users.find((u) => u.id === 'user-bob');
        expect(bob.currently_watching_season_id).toBeNull();
    });

    it('either partner of a shared column can set it', async () => {
        await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'carol@example.com',
        });
        const { users } = await (await req('GET', '/api/board')).json();
        const bob = users.find((u) => u.id === 'user-bob');
        expect(bob.currently_watching_season_id).toBe(1);
    });

    it('is idempotent — setting the same season twice returns 200', async () => {
        // Works because SQLite counts same-value updates in meta.changes; this
        // pins that subtlety so the atomic not-watched UPDATE can't regress it
        // into a spurious 409.
        await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        const r = await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
        const { users } = await (await req('GET', '/api/board')).json();
        const alice = users.find((u) => u.id === 'user-alice');
        expect(alice.currently_watching_season_id).toBe(1);
    });

    it('returns 403 when there is no identity', async () => {
        const r = await req('PUT', '/api/currently-watching', { body: { season_id: 1 } });
        expect(r.status).toBe(403);
    });

    it('returns 403 when the email is not a known user', async () => {
        const r = await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'stranger@example.com',
        });
        expect(r.status).toBe(403);
    });

    it('returns 404 for an unknown season', async () => {
        const r = await req('PUT', '/api/currently-watching', {
            body: { season_id: 999 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('returns 409 for a season the caller has already watched', async () => {
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'alice@example.com' });
        const r = await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(409);
        const { users } = await (await req('GET', '/api/board')).json();
        const alice = users.find((u) => u.id === 'user-alice');
        expect(alice.currently_watching_season_id).toBeNull();
    });

    it('allows a season someone else (but not the caller) has watched', async () => {
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'bob@example.com' });
        const r = await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
    });

    it('returns 400 when season_id is missing', async () => {
        const r = await req('PUT', '/api/currently-watching', {
            body: {},
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('returns 400 when season_id is not a positive integer', async () => {
        const r = await req('PUT', '/api/currently-watching', {
            body: { season_id: -1 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// POST /api/watched
// ---------------------------------------------------------------------------

describe('POST /api/watched', () => {
    it('marks the calling user as having watched a season', async () => {
        const r = await req('POST', '/api/watched', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(201);
        const body = await r.json();
        expect(body).toMatchObject({ success: true, user_id: 'user-alice', season_id: 1 });
    });

    it('clears the season as currently-watching when marked seen', async () => {
        await req('PUT', '/api/currently-watching', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'alice@example.com' });
        const { users } = await (await req('GET', '/api/board')).json();
        const alice = users.find((u) => u.id === 'user-alice');
        expect(alice.currently_watching_season_id).toBeNull();
    });

    it('leaves currently-watching alone when a different season is marked seen', async () => {
        await req('PUT', '/api/currently-watching', {
            body: { season_id: 41 },
            email: 'alice@example.com',
        });
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'alice@example.com' });
        const { users } = await (await req('GET', '/api/board')).json();
        const alice = users.find((u) => u.id === 'user-alice');
        expect(alice.currently_watching_season_id).toBe(41);
    });

    it('is idempotent — marking twice does not error or duplicate', async () => {
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'alice@example.com' });
        const r = await req('POST', '/api/watched', {
            body: { season_id: 1 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(201);
        const row = await env.DB.prepare(
            'SELECT COUNT(*) AS count FROM watched WHERE user_id = ? AND season_id = ?',
        )
            .bind('user-alice', 1)
            .first();
        expect(row.count).toBe(1);
    });

    it('attributes to the caller, not a client-supplied id', async () => {
        // The body has no user_id field; identity is server-derived from the email.
        await req('POST', '/api/watched', {
            body: { season_id: 1, user_id: 'user-bob' },
            email: 'alice@example.com',
        });
        const { user_id } = await (
            await req('POST', '/api/watched', {
                body: { season_id: 41 },
                email: 'alice@example.com',
            })
        ).json();
        expect(user_id).toBe('user-alice');
        const bobRows = await env.DB.prepare(
            'SELECT COUNT(*) AS count FROM watched WHERE user_id = ?',
        )
            .bind('user-bob')
            .first();
        expect(bobRows.count).toBe(0);
    });

    it('attributes both partners of a shared column to the same user', async () => {
        // Carol marks it; the board credits the shared "user-bob" column, and Bob
        // can later remove it — they act as one column.
        await req('POST', '/api/watched', { body: { season_id: 41 }, email: 'carol@example.com' });
        let { seasons } = await (await req('GET', '/api/board')).json();
        expect(seasons.find((s) => s.id === 41).watched_by).toEqual(['user-bob']);

        const del = await req('DELETE', '/api/watched/41', { email: 'bob@example.com' });
        expect(del.status).toBe(200);
        ({ seasons } = await (await req('GET', '/api/board')).json());
        expect(seasons.find((s) => s.id === 41).watched_by).toEqual([]);
    });

    it('returns 403 when the caller is not a known user', async () => {
        const r = await req('POST', '/api/watched', {
            body: { season_id: 1 },
            email: 'stranger@example.com',
        });
        expect(r.status).toBe(403);
    });

    it('returns 403 when there is no identity', async () => {
        const r = await req('POST', '/api/watched', { body: { season_id: 1 } });
        expect(r.status).toBe(403);
    });

    it('returns 404 for an unknown season', async () => {
        const r = await req('POST', '/api/watched', {
            body: { season_id: 999 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('returns 400 when season_id is missing', async () => {
        const r = await req('POST', '/api/watched', { body: {}, email: 'alice@example.com' });
        expect(r.status).toBe(400);
    });

    it('returns 400 when season_id is not a positive integer', async () => {
        const r = await req('POST', '/api/watched', {
            body: { season_id: -3 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('returns 400 for malformed JSON body', async () => {
        const r = await worker.fetch(
            new Request('https://example.com/api/watched', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cf-Access-Jwt-Assertion': await signAccessToken({
                        email: 'alice@example.com',
                    }),
                },
                body: 'not-json',
            }),
            makeEnv(),
        );
        expect(r.status).toBe(400);
        expect((await r.json()).error).toBe('Invalid JSON body');
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/watched/:season_id
// ---------------------------------------------------------------------------

describe('DELETE /api/watched/:season_id', () => {
    beforeEach(async () => {
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'alice@example.com' });
        await req('POST', '/api/watched', { body: { season_id: 1 }, email: 'bob@example.com' });
    });

    it('removes only the calling user’s mark', async () => {
        const r = await req('DELETE', '/api/watched/1', { email: 'alice@example.com' });
        expect(r.status).toBe(200);
        const { seasons } = await (await req('GET', '/api/board')).json();
        expect(seasons.find((s) => s.id === 1).watched_by).toEqual(['user-bob']);
    });

    it('is a no-op (still 200) when the mark does not exist', async () => {
        const r = await req('DELETE', '/api/watched/41', { email: 'alice@example.com' });
        expect(r.status).toBe(200);
        expect((await r.json()).success).toBe(true);
    });

    it('returns 403 when there is no identity', async () => {
        const r = await req('DELETE', '/api/watched/1');
        expect(r.status).toBe(403);
    });

    it('returns 400 for a non-numeric season_id', async () => {
        const r = await req('DELETE', '/api/watched/abc', { email: 'alice@example.com' });
        expect(r.status).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

describe('POST /api/seasons', () => {
    it('adds the next season with a derived Wikipedia link', async () => {
        const r = await req('POST', '/api/seasons', {
            body: { id: 42, subtitle: '  Fans vs. Favorites  ', episode_count: 13 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(201);
        expect(await r.json()).toEqual({
            id: 42,
            subtitle: 'Fans vs. Favorites',
            wikipedia_url: 'https://en.wikipedia.org/wiki/Survivor_42',
            episode_count: 13,
        });
        const { seasons } = await (await req('GET', '/api/board')).json();
        expect(seasons.map((s) => s.id)).toEqual([1, 41, 42]);
    });

    it('defaults the subtitle to empty', async () => {
        const r = await req('POST', '/api/seasons', {
            body: { id: 42, episode_count: 13 },
            email: 'bob@example.com',
        });
        expect(r.status).toBe(201);
        expect((await r.json()).subtitle).toBe('');
    });

    it('refuses a number that is not the next one with 409', async () => {
        // A second click racing the first sends the same number; by the time it
        // lands, 42 exists and the next is 43, so it must not create 43 instead.
        await req('POST', '/api/seasons', {
            body: { id: 42, episode_count: 13 },
            email: 'alice@example.com',
        });
        const again = await req('POST', '/api/seasons', {
            body: { id: 42, episode_count: 13 },
            email: 'bob@example.com',
        });
        expect(again.status).toBe(409);
        const skip = await req('POST', '/api/seasons', {
            body: { id: 50, episode_count: 13 },
            email: 'bob@example.com',
        });
        expect(skip.status).toBe(409);
        const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM seasons').first();
        expect(count).toBe(3);
    });

    it('rejects an out-of-range episode count with 400', async () => {
        for (const episode_count of [0, 31, 1.5, '13']) {
            const r = await req('POST', '/api/seasons', {
                body: { id: 42, episode_count },
                email: 'alice@example.com',
            });
            expect(r.status).toBe(400);
        }
    });

    it('rejects an overlong subtitle with 400', async () => {
        const r = await req('POST', '/api/seasons', {
            body: { id: 42, subtitle: 'x'.repeat(101), episode_count: 13 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('returns 403 for a caller off the roster', async () => {
        const r = await req('POST', '/api/seasons', {
            body: { id: 42, episode_count: 13 },
            email: 'stranger@example.com',
        });
        expect(r.status).toBe(403);
        const row = await env.DB.prepare('SELECT 1 FROM seasons WHERE id = 42').first();
        expect(row).toBeNull();
    });
});

describe('PATCH /api/seasons/:season_id', () => {
    it('updates the subtitle and episode count', async () => {
        const r = await req('PATCH', '/api/seasons/41', {
            body: { subtitle: ' A New Era ', episode_count: 14 },
            email: 'carol@example.com',
        });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({
            id: 41,
            subtitle: 'A New Era',
            wikipedia_url: 'https://en.wikipedia.org/wiki/Survivor_41',
            episode_count: 14,
        });
    });

    it('leaves an omitted field alone', async () => {
        const r = await req('PATCH', '/api/seasons/1', {
            body: { episode_count: 14 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ subtitle: 'Borneo', episode_count: 14 });
    });

    it('allows lowering the count down to the last episode with activity', async () => {
        await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at)
             VALUES (41, 10, 'user-alice', 'hi', '2026-01-01T00:00:00Z')`,
        ).run();
        const r = await req('PATCH', '/api/seasons/41', {
            body: { episode_count: 10 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
    });

    it.each([
        [
            'a note',
            `INSERT INTO posts (season_id, episode, user_id, body, created_at)
             VALUES (41, 13, 'user-alice', 'hi', '2026-01-01T00:00:00Z')`,
        ],
        [
            'a reveal',
            `INSERT INTO reveals (user_id, season_id, episode, created_at)
             VALUES ('user-alice', 41, 13, '2026-01-01T00:00:00Z')`,
        ],
        [
            'a timer',
            `INSERT INTO watch_sessions
                 (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at)
             VALUES ('user-alice', 41, 13, 0, NULL, '2026-01-01T00:00:00Z')`,
        ],
        [
            'a timer correction',
            `INSERT INTO watch_offsets (user_id, season_id, episode, adjust_secs, updated_at)
             VALUES ('user-alice', 41, 13, 60, '2026-01-01T00:00:00Z')`,
        ],
        [
            'a skip',
            `INSERT INTO episode_statuses (user_id, season_id, episode, status, reason, created_at)
             VALUES ('user-alice', 41, 13, 'skipping', 'reunion', '2026-01-01T00:00:00Z')`,
        ],
    ])('refuses to drop an episode that has %s with 409', async (_, sql) => {
        await env.DB.prepare(sql).run();
        const r = await req('PATCH', '/api/seasons/41', {
            body: { episode_count: 12 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(409);
        const row = await env.DB.prepare('SELECT episode_count FROM seasons WHERE id = 41').first();
        expect(row.episode_count).toBe(13);
    });

    it('ignores activity on other seasons when lowering the count', async () => {
        await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at)
             VALUES (1, 13, 'user-alice', 'hi', '2026-01-01T00:00:00Z')`,
        ).run();
        const r = await req('PATCH', '/api/seasons/41', {
            body: { episode_count: 12 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
    });

    it('rejects an empty body with 400', async () => {
        const r = await req('PATCH', '/api/seasons/41', { body: {}, email: 'alice@example.com' });
        expect(r.status).toBe(400);
    });

    it('returns 404 for an unknown season', async () => {
        const r = await req('PATCH', '/api/seasons/99', {
            body: { episode_count: 13 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('returns 400 for a non-numeric season_id', async () => {
        const r = await req('PATCH', '/api/seasons/abc', {
            body: { episode_count: 13 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('returns 403 for a caller off the roster', async () => {
        const r = await req('PATCH', '/api/seasons/41', {
            body: { episode_count: 20 },
            email: 'stranger@example.com',
        });
        expect(r.status).toBe(403);
    });
});
