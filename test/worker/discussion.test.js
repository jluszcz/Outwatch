import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/index.js';

const mockAssetsFetch = vi.fn().mockResolvedValue(new Response('index.html'));

function makeEnv(overrides = {}) {
    return {
        ...env,
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
    if (email) init.headers['Cf-Access-Authenticated-User-Email'] = email;
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv(envOverrides));
}

// Children before parents — the new tables carry foreign keys into seasons and users.
beforeEach(async () => {
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
        'INSERT INTO user_emails (email, user_id) VALUES ' +
            "('alice@example.com', 'user-alice'), " +
            "('bob@example.com', 'user-bob'), " +
            "('carol@example.com', 'user-bob')",
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
});
