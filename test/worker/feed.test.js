import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/index.js';
import { accessEnv, signAccessToken, stubJwksEndpoint } from './access-token.js';
import { groupNotes, FEED_GROUP_GAP_MS } from '../../src/feed.js';

// A row as the feed query returns it. author_key is what the SQL computes:
// the lowercased email for an attributed note, 'user:<id>' for one written
// before authorship was recorded.
function row(overrides = {}) {
    return {
        author_key: 'alice@example.com',
        author_email: 'alice@example.com',
        user_id: 'user-alice',
        season_id: 45,
        episode: 3,
        created_at: '2026-08-02T00:00:00.000Z',
        ...overrides,
    };
}

// Named offsetAt rather than `at` so it does not shadow the `at` parameter the
// route tests below destructure.
const offsetAt = (ms) => new Date(Date.parse('2026-08-02T00:00:00.000Z') + ms).toISOString();

describe('groupNotes', () => {
    it('returns nothing for no rows', () => {
        expect(groupNotes([])).toEqual([]);
    });

    it('folds one sitting on one episode into a single group', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(10 * 60 * 1000) }),
            row({ created_at: offsetAt(40 * 60 * 1000) }),
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].season_id).toBe(45);
        expect(groups[0].episode).toBe(3);
    });

    it('stamps a group with its newest note', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(40 * 60 * 1000) }),
        ]);
        expect(groups[0].at).toBe(offsetAt(40 * 60 * 1000));
    });

    it('splits when consecutive notes are further apart than the gap', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(FEED_GROUP_GAP_MS + 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('keeps a note exactly on the gap in the same group', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(FEED_GROUP_GAP_MS) }),
        ]);
        expect(groups).toHaveLength(1);
    });

    // The reason the gap rule replaced a calendar-day rule: created_at is UTC,
    // and UTC midnight is 8pm Eastern, so an evening session straddles it.
    it('does not split an evening session that crosses UTC midnight', () => {
        const groups = groupNotes([
            row({ created_at: '2026-08-02T23:40:00.000Z' }),
            row({ created_at: '2026-08-03T00:20:00.000Z' }),
        ]);
        expect(groups).toHaveLength(1);
    });

    it('measures the gap from the previous note, not the group start', () => {
        const hour = 60 * 60 * 1000;
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(5 * hour) }),
            row({ created_at: offsetAt(10 * hour) }),
        ]);
        expect(groups).toHaveLength(1);
    });

    it('does not group two people together', () => {
        const groups = groupNotes([
            row({ author_key: 'alice@example.com', created_at: offsetAt(0) }),
            row({
                author_key: 'bob@example.com',
                author_email: 'bob@example.com',
                user_id: 'user-bob',
                created_at: offsetAt(60 * 1000),
            }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('does not group two episodes together', () => {
        const groups = groupNotes([
            row({ episode: 3, created_at: offsetAt(0) }),
            row({ episode: 4, created_at: offsetAt(60 * 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('does not group two seasons together', () => {
        const groups = groupNotes([
            row({ season_id: 45, created_at: offsetAt(0) }),
            row({ season_id: 46, created_at: offsetAt(60 * 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('carries the fields the byline is resolved from', () => {
        const groups = groupNotes([row()]);
        expect(groups[0].author_email).toBe('alice@example.com');
        expect(groups[0].user_id).toBe('user-alice');
    });

    it('never carries a note body', () => {
        const groups = groupNotes([{ ...row(), body: 'no way he played that idol' }]);
        expect(JSON.stringify(groups)).not.toContain('idol');
    });
});

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

async function req(method, path, { body, email } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    if (email) init.headers['Cf-Access-Jwt-Assertion'] = await signAccessToken({ email });
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv());
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function addPost({
    user = 'user-alice',
    email = 'alice@example.com',
    season = 45,
    episode = 3,
    at,
}) {
    await env.DB.prepare(
        `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
         VALUES (?, ?, ?, 'no way he played that idol', ?, ?)`,
    )
        .bind(season, episode, user, at, email)
        .run();
}

describe('GET /api/feed', () => {
    beforeEach(async () => {
        await stubJwksEndpoint();
        await env.DB.exec('DELETE FROM reactions');
        await env.DB.exec('DELETE FROM posts');
        await env.DB.exec('DELETE FROM user_emails');
        await env.DB.exec('DELETE FROM users');
        await env.DB.exec('DELETE FROM seasons');
        await env.DB.exec(
            "INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1)",
        );
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

    it('403s for a caller who is not on the roster', async () => {
        const res = await req('GET', '/api/feed', { email: 'nobody@example.com' });
        expect(res.status).toBe(403);
    });

    it('names another individual, their season, and their episode', async () => {
        await addPost({ at: ago(3 * 60 * 60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toHaveLength(1);
        expect(data.events[0]).toMatchObject({
            author_name: 'Alice',
            season_id: 45,
            episode: 3,
        });
    });

    it("excludes the caller's own notes", async () => {
        await addPost({ at: ago(60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'alice@example.com' });
        const data = await res.json();
        expect(data.events).toEqual([]);
        expect(data.unread_count).toBe(0);
    });

    // Bob and Carol share a column but are different people, and the byline is
    // already per individual — so Carol's note is news to Bob.
    it("shows a note by the other half of the caller's own column", async () => {
        await addPost({ user: 'user-bob', email: 'carol@example.com', at: ago(60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toHaveLength(1);
        expect(data.events[0].author_name).toBe('Carol');
    });

    it('bylines a note with no recorded author to its column', async () => {
        await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
             VALUES (45, 3, 'user-bob', 'old note', ?, NULL)`,
        )
            .bind(ago(60 * 1000))
            .run();
        const res = await req('GET', '/api/feed', { email: 'alice@example.com' });
        const data = await res.json();
        expect(data.events[0].author_name).toBe('Bob & Carol');
    });

    it("excludes an unattributed note written by the caller's own column", async () => {
        await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
             VALUES (45, 3, 'user-bob', 'old note', ?, NULL)`,
        )
            .bind(ago(60 * 1000))
            .run();
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toEqual([]);
    });

    it('drops notes older than the 30-day window', async () => {
        await addPost({ at: ago(31 * 24 * 60 * 60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toEqual([]);
    });

    it('orders events newest first', async () => {
        await addPost({ episode: 3, at: ago(5 * 60 * 60 * 1000) });
        await addPost({ episode: 4, at: ago(1 * 60 * 60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events.map((e) => e.episode)).toEqual([4, 3]);
    });

    it('returns at most ten events but counts every unread group', async () => {
        for (let episode = 1; episode <= 13; episode += 1) {
            await addPost({ episode, at: ago(episode * 60 * 60 * 1000) });
        }
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toHaveLength(10);
        expect(data.unread_count).toBe(13);
    });

    it('marks everything unread when the caller has never checked', async () => {
        await addPost({ at: ago(60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events[0].unread).toBe(true);
        expect(data.unread_count).toBe(1);
    });

    it('marks a group read once the caller has checked since it landed', async () => {
        await addPost({ at: ago(2 * 60 * 60 * 1000) });
        await env.DB.prepare('UPDATE user_emails SET feed_seen_at = ? WHERE email = ?')
            .bind(ago(60 * 60 * 1000), 'bob@example.com')
            .run();
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events[0].unread).toBe(false);
        expect(data.unread_count).toBe(0);
    });

    it('leaves a group unread for the partner who has not checked', async () => {
        await addPost({ at: ago(2 * 60 * 60 * 1000) });
        await env.DB.prepare('UPDATE user_emails SET feed_seen_at = ? WHERE email = ?')
            .bind(ago(60 * 60 * 1000), 'bob@example.com')
            .run();
        const res = await req('GET', '/api/feed', { email: 'carol@example.com' });
        const data = await res.json();
        expect(data.unread_count).toBe(1);
    });

    it('drops a deleted note from the feed', async () => {
        await addPost({ at: ago(60 * 1000) });
        await env.DB.exec('DELETE FROM posts');
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toEqual([]);
    });

    it('serializes no note body and no email', async () => {
        await addPost({ at: ago(60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const text = await res.text();
        expect(text).not.toContain('idol');
        expect(text).not.toContain('@example.com');
    });

    it('carries no per-group note count', async () => {
        await addPost({ at: ago(60 * 60 * 1000) });
        await addPost({ at: ago(30 * 60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toHaveLength(1);
        expect(data.events[0].count).toBeUndefined();
    });

    it('echoes the server clock', async () => {
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(Number.isNaN(Date.parse(data.now))).toBe(false);
    });
});
