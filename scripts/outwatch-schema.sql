-- Outwatch's schema as its own migrations 0001–0012 left it, before it moved onto
-- TV Talk's database. Frozen for scripts/import-to-tvtalk.py and its test, which read
-- an export of the old outwatch database. Not applied anywhere.
CREATE TABLE users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
, currently_watching_season_id INTEGER REFERENCES seasons(id));
CREATE TABLE seasons (
    id            INTEGER PRIMARY KEY,
    subtitle      TEXT NOT NULL DEFAULT '',
    wikipedia_url TEXT NOT NULL
, episode_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE watched (
    user_id    TEXT NOT NULL,
    season_id  INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, season_id),
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);
CREATE INDEX idx_watched_season ON watched (season_id);
CREATE TABLE "user_emails" (
    email   TEXT PRIMARY KEY COLLATE NOCASE,
    user_id TEXT NOT NULL, name TEXT, feed_seen_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE INDEX idx_user_emails_user ON user_emails (user_id);
CREATE TABLE posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id   INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    offset_secs INTEGER, author_email TEXT REFERENCES user_emails (email), reply_to_post_id INTEGER REFERENCES posts (id), edited_at TEXT,
    FOREIGN KEY (season_id) REFERENCES seasons (id),
    FOREIGN KEY (user_id)   REFERENCES users (id)
);
CREATE INDEX idx_posts_board ON posts (season_id, episode, id);
CREATE TABLE reveals (
    user_id    TEXT    NOT NULL,
    season_id  INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);
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
CREATE INDEX idx_posts_created ON posts (created_at);
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
