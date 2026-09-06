import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

// The 50 episode counts in migration 0005 are transcribed by hand from Wikipedia
// and are the likeliest place in this feature for a quiet error. A dropped row
// leaves a 0; a slipped digit leaves a 130. Both are caught here.
describe('seeded episode counts', () => {
    it('gives all 50 seasons a plausible episode count', async () => {
        const { results } = await env.DB.prepare(
            'SELECT id, episode_count FROM seasons ORDER BY id ASC',
        ).all();
        expect(results).toHaveLength(50);
        for (const season of results) {
            expect(season.episode_count).toBeGreaterThanOrEqual(12);
            expect(season.episode_count).toBeLessThanOrEqual(17);
        }
    });

    it('has the new discussion tables', async () => {
        const { results } = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        ).all();
        const names = results.map((r) => r.name);
        expect(names).toContain('posts');
        expect(names).toContain('reveals');
        expect(names).toContain('watch_sessions');
    });
});

// The two columns individual attribution rests on. Both are added by ALTER
// TABLE, which rewrites the stored CREATE statement, so sqlite_master is a
// faithful record of whether migration 0006 actually applied.
describe('individual author columns', () => {
    it('adds a per-person name and a post author', async () => {
        const { results } = await env.DB.prepare(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name IN ('posts', 'user_emails')`,
        ).all();
        const sqlFor = Object.fromEntries(results.map((r) => [r.name, r.sql]));
        expect(sqlFor.user_emails).toContain('name TEXT');
        expect(sqlFor.posts).toContain('author_email TEXT');
    });
});

// Migration 0007. The two posts columns arrive by ALTER TABLE, which rewrites
// the stored CREATE statement, so sqlite_master records whether they applied.
describe('reply, edit, and reaction schema', () => {
    it('adds the reply and edit columns to posts', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'posts'",
        ).first();
        expect(row.sql).toContain('reply_to_post_id INTEGER');
        expect(row.sql).toContain('edited_at TEXT');
    });

    it('creates the reactions table keyed on the individual', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reactions'",
        ).first();
        expect(row.sql).toContain('COLLATE NOCASE');
        expect(row.sql).toContain('PRIMARY KEY (post_id, email, emoji)');
    });

    it('rejects a duplicate reaction from the same person', async () => {
        await env.DB.exec(
            "INSERT OR IGNORE INTO users (id, name, sort_order) VALUES ('user-mig', 'Mig', 9)",
        );
        await env.DB.exec(
            "INSERT OR IGNORE INTO user_emails (email, user_id) VALUES ('mig@example.com', 'user-mig')",
        );
        const inserted = await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at)
             VALUES (1, 1, 'user-mig', 'note', '2026-07-28T00:00:00.000Z')
             RETURNING id`,
        ).first();
        const postId = inserted.id;
        const insert = () =>
            env.DB.prepare(
                `INSERT OR IGNORE INTO reactions (post_id, email, emoji, created_at)
                 VALUES (?, 'mig@example.com', '👍', '2026-07-28T00:00:00.000Z')`,
            )
                .bind(postId)
                .run();
        await insert();
        await insert();
        const { results } = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?',
        )
            .bind(postId)
            .all();
        expect(results[0].n).toBe(1);
    });
});

// The correction deliberately lives outside watch_sessions: `start` zeroes that
// row, and zeroing a correction would silently un-shift notes it had already
// moved. Its own table is what makes it outlive the session that produced it.
describe('watch offset corrections', () => {
    it('has a watch_offsets table keyed per user, season, and episode', async () => {
        const { results } = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'watch_offsets'",
        ).all();
        expect(results).toHaveLength(1);
        expect(results[0].sql).toContain('adjust_secs');
        expect(results[0].sql).toContain('PRIMARY KEY (user_id, season_id, episode)');
    });

    it('indexes the season_id column for efficient reads by season', async () => {
        const { results } = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_watch_offsets_season'",
        ).all();
        expect(results).toHaveLength(1);
    });
});

// Migration 0010. GET /api/feed filters posts on created_at alone, which
// idx_posts_board (season_id, episode, id) cannot serve — its leading column is
// not in the query — so before this index the bell scanned the whole table on
// every page load. Asserted through the query planner as well as sqlite_master:
// the index existing is not the property worth having, being used is, and a
// later index or a rewritten WHERE clause could take that away while leaving
// the CREATE statement sitting there looking correct.
describe('feed window index', () => {
    it('creates idx_posts_created', async () => {
        const { results } = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_posts_created'",
        ).all();
        expect(results).toHaveLength(1);
    });

    it('plans the feed window scan through it', async () => {
        const { results } = await env.DB.prepare(
            'EXPLAIN QUERY PLAN SELECT id FROM posts WHERE created_at >= ?',
        )
            .bind('2026-01-01T00:00:00.000Z')
            .all();
        const plan = results.map((row) => row.detail).join(' ');
        expect(plan).toContain('idx_posts_created');
    });
});

// Migration 0009. The column arrives by ALTER TABLE, which rewrites the stored
// CREATE statement, so sqlite_master records whether it applied. It sits on
// user_emails rather than users because reading the feed is something a person
// does with their own eyes — a shared column's two logins keep separate badges.
describe('feed seen marks', () => {
    it('adds a per-individual feed_seen_at to user_emails', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_emails'",
        ).first();
        expect(row.sql).toContain('feed_seen_at TEXT');
    });

    it('does not add the column to users', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'",
        ).first();
        expect(row.sql).not.toContain('feed_seen_at');
    });
});

// A skip is a per-column, per-episode row, the same shape reveals and
// watch_offsets take. The index is what the discussion read leans on: it loads
// every user's statuses for one season, filtering on the primary key's second
// column, which the implicit PK index cannot serve.
describe('episode statuses', () => {
    it('creates the table with a status and a reason', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episode_statuses'",
        ).first();
        expect(row).not.toBeNull();
        expect(row.sql).toContain('status');
        expect(row.sql).toContain('reason');
    });

    it('indexes the table by season', async () => {
        const row = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_episode_statuses_season'",
        ).first();
        expect(row).not.toBeNull();
    });
});
