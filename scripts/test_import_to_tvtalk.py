"""Tests for import-to-tvtalk.py. Run: python3 -I -m unittest scripts/test_import_to_tvtalk.py"""

import glob
import importlib.util
import os
import sqlite3
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location("importer", os.path.join(HERE, "import-to-tvtalk.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

ROSTER = """
INSERT INTO users (id, name, sort_order) VALUES ('user-1', 'Alice', 1), ('user-2', 'Bob & Carol', 2);
INSERT INTO user_emails (email, user_id, name) VALUES
    ('alice@example.com', 'user-1', NULL),
    ('bob@example.com', 'user-2', 'Bob'),
    ('carol@example.com', 'user-2', 'Carol');
"""


def outwatch_db():
    conn = sqlite3.connect(":memory:")
    with open(os.path.join(HERE, "outwatch-schema.sql")) as f:
        conn.executescript(f.read())
    conn.executescript(ROSTER)
    conn.executescript("""
        INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES
            (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo', 14),
            (52, 'New Era', 'https://en.wikipedia.org/wiki/Survivor_52', 13);
        UPDATE users SET currently_watching_season_id = 52 WHERE id = 'user-1';
        INSERT INTO watched (user_id, season_id, created_at) VALUES ('user-2', 1, '2026-01-01T00:00:00Z');
        INSERT INTO posts (id, season_id, episode, user_id, body, created_at, offset_secs, author_email, reply_to_post_id, edited_at) VALUES
            (1, 52, 2, 'user-1', 'first', '2026-02-01T00:00:00Z', 90, 'alice@example.com', NULL, NULL),
            (2, 52, 2, 'user-2', 'it''s a reply', '2026-02-01T00:01:00Z', NULL, 'carol@example.com', 1, '2026-02-01T00:02:00Z');
        INSERT INTO reactions (post_id, email, emoji, created_at) VALUES (1, 'bob@example.com', '🔥', '2026-02-01T00:03:00Z');
        INSERT INTO reveals (user_id, season_id, episode, created_at) VALUES ('user-2', 52, 2, '2026-02-01T00:00:00Z');
        INSERT INTO watch_sessions (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at) VALUES ('user-1', 52, 2, 120, NULL, '2026-02-01T00:00:00Z');
        INSERT INTO watch_offsets (user_id, season_id, episode, adjust_secs, updated_at) VALUES ('user-1', 52, 2, -30, '2026-02-01T00:00:00Z');
        INSERT INTO episode_statuses (user_id, season_id, episode, status, reason, created_at) VALUES ('user-2', 52, 13, 'skipping', 'reunion', '2026-02-01T00:00:00Z');
        UPDATE user_emails SET feed_seen_at = '2026-03-01T00:00:00Z' WHERE email = 'alice@example.com';
        UPDATE user_emails SET feed_seen_at = '2026-01-01T00:00:00Z' WHERE email = 'bob@example.com';
    """)
    return conn


def tvtalk_db():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    for path in sorted(glob.glob(os.path.join(ROOT, "migrations", "*.sql"))):
        with open(path) as f:
            conn.executescript(f.read())
    conn.executescript(ROSTER)
    # An existing TV Talk note, on Lanterns, that the import must not disturb.
    conn.executescript("""
        INSERT INTO posts (id, season_id, episode, user_id, body, created_at, author_email)
        SELECT 7, seasons.id, 1, 'user-1', 'existing', '2026-01-05T00:00:00Z', 'alice@example.com'
        FROM seasons JOIN shows ON shows.id = seasons.show_id WHERE shows.name = 'Lanterns';
        UPDATE user_emails SET feed_seen_at = '2026-02-15T00:00:00Z' WHERE email = 'bob@example.com';
    """)
    return conn


def survivor_row(conn, number):
    return conn.execute(
        "SELECT seasons.id FROM seasons JOIN shows ON shows.id = seasons.show_id "
        "WHERE shows.name = 'Survivor' AND seasons.number = ?",
        (number,),
    ).fetchone()[0]


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.tv = tvtalk_db()
        self.addCleanup(self.tv.close)
        self.offset = self.tv.execute("SELECT MAX(id) FROM posts").fetchone()[0]
        self.tv.executescript(importer.generate(self.outwatch(), self.offset))

    def outwatch(self):
        conn = outwatch_db()
        self.addCleanup(conn.close)
        return conn

    def test_seasons_upserted_by_number(self):
        rows = self.tv.execute(
            "SELECT seasons.number, seasons.subtitle, seasons.url, seasons.episode_count "
            "FROM seasons JOIN shows ON shows.id = seasons.show_id "
            "WHERE shows.name = 'Survivor' AND seasons.number IN (1, 52) ORDER BY seasons.number"
        ).fetchall()
        self.assertEqual(rows, [
            (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo', 14),
            (52, 'New Era', 'https://en.wikipedia.org/wiki/Survivor_52', 13),
        ])

    def test_watched_and_currently_watching(self):
        self.assertEqual(
            self.tv.execute("SELECT user_id, season_id FROM watched").fetchall(),
            [('user-2', survivor_row(self.tv, 1))],
        )
        self.assertEqual(
            self.tv.execute(
                "SELECT user_id, season_id FROM currently_watching "
                "WHERE show_id = (SELECT id FROM shows WHERE name = 'Survivor')"
            ).fetchall(),
            [('user-1', survivor_row(self.tv, 52))],
        )

    def test_posts_replies_and_reactions_follow_the_offset(self):
        s52 = survivor_row(self.tv, 52)
        posts = self.tv.execute(
            "SELECT id, season_id, episode, body, offset_secs, author_email, reply_to_post_id, edited_at "
            "FROM posts WHERE season_id = ? ORDER BY id", (s52,)
        ).fetchall()
        o = self.offset
        self.assertEqual(posts, [
            (1 + o, s52, 2, 'first', 90, 'alice@example.com', None, None),
            (2 + o, s52, 2, "it's a reply", None, 'carol@example.com', 1 + o, '2026-02-01T00:02:00Z'),
        ])
        self.assertEqual(
            self.tv.execute("SELECT post_id, email, emoji FROM reactions").fetchall(),
            [(1 + o, 'bob@example.com', '🔥')],
        )

    def test_existing_tvtalk_posts_untouched(self):
        self.assertEqual(
            self.tv.execute("SELECT body FROM posts WHERE id = 7").fetchone(), ('existing',)
        )

    def test_episode_scoped_rows_remapped(self):
        s52 = survivor_row(self.tv, 52)
        for table in ("reveals", "watch_sessions", "watch_offsets", "episode_statuses"):
            self.assertEqual(
                self.tv.execute(f"SELECT DISTINCT season_id FROM {table}").fetchall(), [(s52,)], table
            )

    def test_feed_seen_keeps_the_later_mark(self):
        seen = dict(self.tv.execute("SELECT email, feed_seen_at FROM user_emails").fetchall())
        self.assertEqual(seen['alice@example.com'], '2026-03-01T00:00:00Z')
        self.assertEqual(seen['bob@example.com'], '2026-02-15T00:00:00Z')
        self.assertIsNone(seen['carol@example.com'])

    def test_rerun_is_rejected_by_post_ids(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.tv.executescript(importer.generate(self.outwatch(), self.offset))


if __name__ == "__main__":
    unittest.main()
