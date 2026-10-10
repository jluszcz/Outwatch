-- A "user" is a column on the board — a single person or a couple who watch
-- together and share one checkbox column.
CREATE TABLE users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Cloudflare Access authenticates individuals by email. Each login email maps to
-- exactly one board column; a couple's column has two emails pointing at it.
-- `name` is the individual's byline on a note (NULL falls back to the column
-- name); `feed_seen_at` is per person because the feed badge is.
CREATE TABLE user_emails (
    email        TEXT PRIMARY KEY COLLATE NOCASE,
    user_id      TEXT NOT NULL,
    name         TEXT,
    feed_seen_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_user_emails_user ON user_emails (user_id);

-- Shows are added by roster members from the board. NOCASE on the unique name
-- so "lanterns" cannot sit beside "Lanterns" as a second show. `url` is ''
-- rather than NULL for "no link", so the client has one thing to test.
CREATE TABLE shows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    url        TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

-- A season is a (show, number) pair, but every episode-scoped table below keys
-- on the surrogate id: that is what lets posts, reveals, timers, and statuses
-- ignore shows entirely. `number` and `show_id` never change after creation —
-- together they are the season's identity.
CREATE TABLE seasons (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id       INTEGER NOT NULL,
    number        INTEGER NOT NULL,
    subtitle      TEXT NOT NULL DEFAULT '',
    url           TEXT NOT NULL DEFAULT '',
    episode_count INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (show_id, number),
    FOREIGN KEY (show_id) REFERENCES shows (id)
);

-- One row per (column, season) watched. Presence = watched.
CREATE TABLE watched (
    user_id    TEXT NOT NULL,
    season_id  INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, season_id),
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

CREATE INDEX idx_watched_season ON watched (season_id);

-- What each column is partway through, one per show: someone can be mid-way
-- through two shows at once, but not two seasons of the same one. The route
-- keeps season_id inside show_id and unwatched by the column.
CREATE TABLE currently_watching (
    user_id   TEXT    NOT NULL,
    show_id   INTEGER NOT NULL,
    season_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, show_id),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (show_id)   REFERENCES shows (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

-- One row per note. offset_secs is the author's watch time at the moment of
-- writing, frozen and never recomputed; NULL when no live timer was running.
-- author_email is the individual inside a shared column; reply_to_post_id is
-- detached (set NULL) rather than cascaded when its target is deleted.
CREATE TABLE posts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id        INTEGER NOT NULL,
    episode          INTEGER NOT NULL,
    user_id          TEXT    NOT NULL,
    body             TEXT    NOT NULL,
    created_at       TEXT    NOT NULL,
    offset_secs      INTEGER,
    author_email     TEXT REFERENCES user_emails (email),
    reply_to_post_id INTEGER REFERENCES posts (id),
    edited_at        TEXT,
    FOREIGN KEY (season_id) REFERENCES seasons (id),
    FOREIGN KEY (user_id)   REFERENCES users (id)
);

CREATE INDEX idx_posts_board ON posts (season_id, episode, id);

-- GET /api/feed filters on created_at alone, which idx_posts_board cannot serve.
CREATE INDEX idx_posts_created ON posts (created_at);

-- Reactions are per individual, not per column: each partner reacts separately.
CREATE TABLE reactions (
    post_id    INTEGER NOT NULL,
    email      TEXT    NOT NULL COLLATE NOCASE,
    emoji      TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (post_id, email, emoji),
    FOREIGN KEY (post_id) REFERENCES posts (id),
    FOREIGN KEY (email)   REFERENCES user_emails (email)
);

CREATE INDEX idx_reactions_post ON reactions (post_id);

-- Presence = "this column opened this episode's board". One-way: you cannot
-- unsee it.
CREATE TABLE reveals (
    user_id    TEXT    NOT NULL,
    season_id  INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

-- A running or paused watch timer. elapsed_secs banks completed segments;
-- running_since marks the current one and is NULL while paused. Three hours
-- without activity ends the session.
CREATE TABLE watch_sessions (
    user_id          TEXT    NOT NULL,
    season_id        INTEGER NOT NULL,
    episode          INTEGER NOT NULL,
    elapsed_secs     INTEGER NOT NULL DEFAULT 0,
    running_since    TEXT,
    last_activity_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

-- A correction to where a column's timer started for one episode. Its own table
-- because `start` zeroes watch_sessions, and zeroing a correction would un-shift
-- notes it had already moved.
CREATE TABLE watch_offsets (
    user_id     TEXT    NOT NULL,
    season_id   INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    adjust_secs INTEGER NOT NULL,
    updated_at  TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

CREATE INDEX idx_watch_offsets_season ON watch_offsets (season_id);

-- What a column intends for an episode ("skipping: recap"), as opposed to what
-- it has done. Two columns rather than one so a future status that takes no
-- reason is a route change, not a migration.
CREATE TABLE episode_statuses (
    user_id    TEXT    NOT NULL,
    season_id  INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    status     TEXT    NOT NULL,
    reason     TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

CREATE INDEX idx_episode_statuses_season ON episode_statuses (season_id);
