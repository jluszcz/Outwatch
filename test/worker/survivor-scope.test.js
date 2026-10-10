import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/index.js';
import { accessEnv, signAccessToken, stubJwksEndpoint } from './access-token.js';
import { resetDatabase, insertSurvivorSeasons, survivorShowId } from './survivor.js';

// Outwatch's API speaks Survivor season numbers; TV Talk's tables key on a
// surrogate seasons.id. The other suites seed row id === number, so they
// cannot tell the two apart. Here they always differ (Survivor 1 is row 101,
// Survivor 2 is row 102), and a Lanterns season sits on row 1, the id a
// number/row mix-up would hit.

function makeEnv() {
    return {
        ...env,
        ...accessEnv,
        DEV_USER_EMAIL: undefined,
        ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('index.html')) },
        DB: env.DB,
    };
}

async function req(method, path, { body, email = 'alice@example.com' } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    if (email) init.headers['Cf-Access-Jwt-Assertion'] = await signAccessToken({ email });
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv());
}

const LANTERNS_ROW = 1;

async function insertPost({
    season_id,
    episode = 1,
    user_id = 'user-bob',
    email = 'bob@example.com',
}) {
    const row = await env.DB.prepare(
        `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
         VALUES (?, ?, ?, 'tribal was wild', ?, ?) RETURNING id`,
    )
        .bind(season_id, episode, user_id, new Date().toISOString(), email)
        .first();
    return row.id;
}

beforeEach(async () => {
    await stubJwksEndpoint();
    await resetDatabase();
    await env.DB.exec(
        "INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1), ('user-bob', 'Bob & Carol', 2)",
    );
    await env.DB.exec(
        'INSERT INTO user_emails (email, user_id, name) VALUES ' +
            "('alice@example.com', 'user-alice', NULL), " +
            "('bob@example.com', 'user-bob', 'Bob'), " +
            "('carol@example.com', 'user-bob', 'Carol')",
    );
    await insertSurvivorSeasons([
        { number: 1, row_id: 101, subtitle: 'Borneo', episode_count: 13 },
        { number: 2, row_id: 102, episode_count: 15 },
    ]);
    await env.DB.prepare(
        `INSERT INTO seasons (id, show_id, number, subtitle, url, episode_count, created_at)
         SELECT ${LANTERNS_ROW}, id, 5, '', '', 8, '2026-01-01T00:00:00.000Z' FROM shows WHERE name = 'Lanterns'`,
    ).run();
});

describe('board', () => {
    it('lists only Survivor seasons, by number', async () => {
        await insertPost({ season_id: 101 });
        await insertPost({ season_id: LANTERNS_ROW });
        await env.DB.exec(
            "INSERT INTO watched (user_id, season_id, created_at) VALUES ('user-alice', 101, 'x'), ('user-alice', 1, 'x')",
        );
        const board = await (await req('GET', '/api/board')).json();
        expect(board.seasons.map((s) => s.id)).toEqual([1, 2]);
        expect(board.seasons[0]).toMatchObject({
            id: 1,
            subtitle: 'Borneo',
            episode_count: 13,
            post_count: 1,
            watched_by: ['user-alice'],
        });
        expect(board.seasons[0]).not.toHaveProperty('row_id');
        expect(board.seasons[1]).toMatchObject({ id: 2, post_count: 0, watched_by: [] });
    });

    it('ignores a currently-watching pick on another show', async () => {
        await env.DB.prepare(
            `INSERT INTO currently_watching (user_id, show_id, season_id)
             SELECT 'user-alice', id, ${LANTERNS_ROW} FROM shows WHERE name = 'Lanterns'`,
        ).run();
        const board = await (await req('GET', '/api/board')).json();
        const alice = board.users.find((u) => u.id === 'user-alice');
        expect(alice.currently_watching_season_id).toBeNull();
    });
});

describe('watched and currently-watching', () => {
    it('writes the row id and answers with the number', async () => {
        const r = await req('POST', '/api/watched', { body: { season_id: 1 } });
        expect(r.status).toBe(201);
        expect((await r.json()).season_id).toBe(1);
        const row = await env.DB.prepare(
            "SELECT season_id FROM watched WHERE user_id = 'user-alice'",
        ).first();
        expect(row.season_id).toBe(101);

        expect((await req('DELETE', '/api/watched/1')).status).toBe(200);
        const gone = await env.DB.prepare(
            "SELECT 1 FROM watched WHERE user_id = 'user-alice'",
        ).first();
        expect(gone).toBeNull();
    });

    it('treats an unknown number as a no-op on unwatch', async () => {
        expect((await req('DELETE', '/api/watched/99')).status).toBe(200);
    });

    it('sets, reports, and clears a Survivor pick without touching another show', async () => {
        await env.DB.prepare(
            `INSERT INTO currently_watching (user_id, show_id, season_id)
             SELECT 'user-alice', id, ${LANTERNS_ROW} FROM shows WHERE name = 'Lanterns'`,
        ).run();
        const put = await req('PUT', '/api/currently-watching', { body: { season_id: 2 } });
        expect(put.status).toBe(200);
        expect((await put.json()).season_id).toBe(2);

        const show = await survivorShowId();
        const pick = await env.DB.prepare(
            "SELECT season_id FROM currently_watching WHERE user_id = 'user-alice' AND show_id = ?",
        )
            .bind(show)
            .first();
        expect(pick.season_id).toBe(102);
        const board = await (await req('GET', '/api/board')).json();
        expect(board.users.find((u) => u.id === 'user-alice').currently_watching_season_id).toBe(2);

        // Finishing the season clears the Survivor pick only.
        await req('POST', '/api/watched', { body: { season_id: 2 } });
        const { results } = await env.DB.prepare(
            "SELECT season_id FROM currently_watching WHERE user_id = 'user-alice'",
        ).all();
        expect(results).toEqual([{ season_id: LANTERNS_ROW }]);

        await req('PUT', '/api/currently-watching', { body: { season_id: 1 } });
        await req('PUT', '/api/currently-watching', { body: { season_id: null } });
        const after = await env.DB.prepare(
            "SELECT season_id FROM currently_watching WHERE user_id = 'user-alice'",
        ).all();
        expect(after.results).toEqual([{ season_id: LANTERNS_ROW }]);
    });

    it('refuses a pick the caller has already watched', async () => {
        await req('POST', '/api/watched', { body: { season_id: 1 } });
        const r = await req('PUT', '/api/currently-watching', { body: { season_id: 1 } });
        expect(r.status).toBe(409);
    });

    it('404s a number with no Survivor season', async () => {
        const r = await req('PUT', '/api/currently-watching', { body: { season_id: 5 } });
        expect(r.status).toBe(404);
    });
});

describe('seasons', () => {
    it("numbers the next season from Survivor's seasons only", async () => {
        // Lanterns has a season 5; Survivor's next is still 3.
        const r = await req('POST', '/api/seasons', { body: { id: 3, episode_count: 14 } });
        expect(r.status).toBe(201);
        expect(await r.json()).toEqual({
            id: 3,
            subtitle: '',
            wikipedia_url: 'https://en.wikipedia.org/wiki/Survivor_3',
            episode_count: 14,
        });
        const skip = await req('POST', '/api/seasons', { body: { id: 6, episode_count: 14 } });
        expect(skip.status).toBe(409);
    });

    it('edits the Survivor season, not the row whose id equals the number', async () => {
        const r = await req('PATCH', '/api/seasons/1', { body: { subtitle: 'Pulau Tiga' } });
        expect(r.status).toBe(200);
        expect((await r.json()).id).toBe(1);
        const lanterns = await env.DB.prepare('SELECT subtitle FROM seasons WHERE id = ?')
            .bind(LANTERNS_ROW)
            .first();
        expect(lanterns.subtitle).toBe('');
    });

    it('applies the shrink guard to the resolved row', async () => {
        await insertPost({ season_id: 101, episode: 12 });
        const r = await req('PATCH', '/api/seasons/1', { body: { episode_count: 10 } });
        expect(r.status).toBe(409);
    });

    it('404s an edit to a number with no Survivor season', async () => {
        const r = await req('PATCH', '/api/seasons/5', { body: { subtitle: 'x' } });
        expect(r.status).toBe(404);
    });
});

describe('discussion and episode routes', () => {
    it('posts onto the row id and reads back by number', async () => {
        const post = await req('POST', '/api/seasons/1/episodes/2/posts', {
            body: { body: 'hi' },
        });
        expect(post.status).toBe(201);
        const row = await env.DB.prepare('SELECT season_id FROM posts').first();
        expect(row.season_id).toBe(101);

        const d = await (await req('GET', '/api/seasons/1/discussion')).json();
        expect(d.season).toEqual({
            id: 1,
            subtitle: 'Borneo',
            wikipedia_url: 'https://en.wikipedia.org/wiki/Survivor_1',
            episode_count: 13,
        });
        expect(d.episodes).toHaveLength(13);
        expect(d.episodes[1].posts.map((p) => p.body)).toEqual(['hi']);
    });

    it('accepts a reply only to a post on the same Survivor season', async () => {
        const parent = await insertPost({
            season_id: 101,
            user_id: 'user-alice',
            email: 'alice@example.com',
        });
        const ok = await req('POST', '/api/seasons/1/episodes/1/posts', {
            body: { body: 'agreed', reply_to_post_id: parent },
        });
        expect(ok.status).toBe(201);
        const foreign = await insertPost({
            season_id: LANTERNS_ROW,
            user_id: 'user-alice',
            email: 'alice@example.com',
        });
        const bad = await req('POST', '/api/seasons/1/episodes/1/posts', {
            body: { body: 'agreed', reply_to_post_id: foreign },
        });
        expect(bad.status).toBe(404);
    });

    it('writes reveals, timers, offsets, and statuses against the row id', async () => {
        const reveal = await req('POST', '/api/seasons/1/episodes/3/reveal');
        expect((await reveal.json()).season_id).toBe(1);
        const timer = await req('POST', '/api/seasons/1/episodes/3/timer', {
            body: { action: 'start' },
        });
        expect((await timer.json()).season_id).toBe(1);
        await req('PUT', '/api/seasons/1/episodes/3/offset', { body: { adjust_secs: 30 } });
        await req('PUT', '/api/seasons/1/episodes/3/status', {
            body: { status: 'skipping', reason: 'recap' },
        });
        for (const table of ['reveals', 'watch_sessions', 'watch_offsets', 'episode_statuses']) {
            const row = await env.DB.prepare(`SELECT season_id FROM ${table}`).first();
            expect(row.season_id, table).toBe(101);
        }
        const d = await (await req('GET', '/api/seasons/1/discussion')).json();
        expect(d.episodes[2]).toMatchObject({ readable: true, hideable: true, adjust_secs: 30 });
        expect(d.episodes[2].session).not.toBeNull();
        expect(d.episodes[2].statuses).toEqual([
            { user_id: 'user-alice', name: 'Alice', status: 'skipping', reason: 'recap' },
        ]);
    });

    it('404s a discussion for a number with no Survivor season', async () => {
        expect((await req('GET', '/api/seasons/5/discussion')).status).toBe(404);
    });
});

describe("another show's notes", () => {
    it('cannot be edited, deleted, or reacted to', async () => {
        await env.DB.exec(
            "INSERT INTO watched (user_id, season_id, created_at) VALUES ('user-bob', 1, 'x')",
        );
        const id = await insertPost({ season_id: LANTERNS_ROW });
        const asBob = { email: 'bob@example.com' };
        const edit = await req('PATCH', `/api/posts/${id}`, { ...asBob, body: { body: 'x' } });
        expect(edit.status).toBe(404);
        const react = await req('PUT', `/api/posts/${id}/reactions`, {
            ...asBob,
            body: { emoji: '🔥', on: true },
        });
        expect(react.status).toBe(404);
        expect((await req('DELETE', `/api/posts/${id}`, asBob)).status).toBe(404);
        const still = await env.DB.prepare('SELECT 1 FROM posts WHERE id = ?').bind(id).first();
        expect(still).not.toBeNull();
    });

    it('stay out of the feed, which reports Survivor numbers', async () => {
        await insertPost({ season_id: LANTERNS_ROW });
        await insertPost({ season_id: 102, episode: 4 });
        const feed = await (await req('GET', '/api/feed')).json();
        expect(feed.events).toHaveLength(1);
        expect(feed.events[0]).toMatchObject({ author_name: 'Bob', season_id: 2, episode: 4 });
        expect(feed.unread_count).toBe(1);
    });
});
