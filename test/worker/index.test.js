import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/index.js';

const mockAssetsFetch = vi.fn().mockResolvedValue(new Response('index.html'));

function makeEnv(overrides = {}) {
    // Force DEV_USER_EMAIL off by default so the no-identity / 403 tests assert
    // the real unauthenticated branch. `env` carries the developer's local
    // .dev.vars value, which would otherwise leak in and make those tests pass
    // (or fail) incidentally depending on local config. Tests that need the
    // dev-fallback behavior re-add it via envOverrides.
    return {
        ...env,
        DEV_USER_EMAIL: undefined,
        ASSETS: { fetch: mockAssetsFetch },
        DB: env.DB,
        ...overrides,
    };
}

// `email` simulates the Cloudflare Access identity header. Omit it to act as an
// unauthenticated request (as in production before Access, or an unknown user).
async function req(method, path, { body, email, envOverrides } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    if (email) init.headers['Cf-Access-Authenticated-User-Email'] = email;
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv(envOverrides));
}

// Schema comes from the real migrations/*.sql, applied in test/apply-migrations.js.
beforeEach(async () => {
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
        "INSERT INTO seasons (id, subtitle, wikipedia_url) VALUES (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo')",
    ).run();
    await env.DB.prepare(
        "INSERT INTO seasons (id, subtitle, wikipedia_url) VALUES (41, '', 'https://en.wikipedia.org/wiki/Survivor_41')",
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

    it('resolves "me" from the Access email header', async () => {
        const { me } = await (await req('GET', '/api/board', { email: 'bob@example.com' })).json();
        expect(me).toEqual({ id: 'user-bob', name: 'Bob & Carol' });
    });

    it('resolves either email of a shared column to the same user', async () => {
        const bob = await (await req('GET', '/api/board', { email: 'bob@example.com' })).json();
        const carol = await (await req('GET', '/api/board', { email: 'carol@example.com' })).json();
        expect(bob.me.id).toBe('user-bob');
        expect(carol.me.id).toBe('user-bob');
    });

    it('matches the Access email case-insensitively', async () => {
        const { me } = await (await req('GET', '/api/board', { email: 'BOB@EXAMPLE.COM' })).json();
        expect(me.id).toBe('user-bob');
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

    it('falls back to DEV_USER_EMAIL when no Access header is present', async () => {
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
                    'Cf-Access-Authenticated-User-Email': 'alice@example.com',
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
