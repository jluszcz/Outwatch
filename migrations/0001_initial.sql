-- A "user" is a column on the board — a single person or a couple who watch
-- together and share one checkbox column.
CREATE TABLE users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Cloudflare Access authenticates individuals by email. Each login email maps to
-- exactly one board column; a couple's column simply has two emails pointing at it.
CREATE TABLE user_emails (
    email   TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_user_emails_user ON user_emails (user_id);

-- Survivor seasons. id IS the season number; subtitle may be empty (seasons 41-49).
CREATE TABLE seasons (
    id            INTEGER PRIMARY KEY,
    subtitle      TEXT NOT NULL DEFAULT '',
    wikipedia_url TEXT NOT NULL
);

-- One row per (user, season) the user has watched. Presence = watched.
CREATE TABLE watched (
    user_id    TEXT NOT NULL,
    season_id  INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, season_id),
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

CREATE INDEX idx_watched_season ON watched (season_id);
