-- Per-episode discussion boards. Episodes are a validated integer rather than a
-- table: they carry no attribute beyond the number, so a row per episode would
-- hold no information.
ALTER TABLE seasons ADD COLUMN episode_count INTEGER NOT NULL DEFAULT 0;

-- Episode counts as listed in each season's Wikipedia episode table, excluding
-- the reunion special. A two-hour premiere counts as the one episode listed.
-- Source: en.wikipedia.org/wiki/List_of_Survivor_(American_TV_series)_episodes
UPDATE seasons SET episode_count = 13 WHERE id = 1;
UPDATE seasons SET episode_count = 15 WHERE id = 2;
UPDATE seasons SET episode_count = 14 WHERE id = 3;
UPDATE seasons SET episode_count = 14 WHERE id = 4;
UPDATE seasons SET episode_count = 14 WHERE id = 5;
UPDATE seasons SET episode_count = 14 WHERE id = 6;
UPDATE seasons SET episode_count = 14 WHERE id = 7;
UPDATE seasons SET episode_count = 16 WHERE id = 8;
UPDATE seasons SET episode_count = 14 WHERE id = 9;
UPDATE seasons SET episode_count = 14 WHERE id = 10;
UPDATE seasons SET episode_count = 14 WHERE id = 11;
UPDATE seasons SET episode_count = 15 WHERE id = 12;
UPDATE seasons SET episode_count = 15 WHERE id = 13;
UPDATE seasons SET episode_count = 14 WHERE id = 14;
UPDATE seasons SET episode_count = 14 WHERE id = 15;
UPDATE seasons SET episode_count = 14 WHERE id = 16;
UPDATE seasons SET episode_count = 13 WHERE id = 17;
UPDATE seasons SET episode_count = 14 WHERE id = 18;
UPDATE seasons SET episode_count = 15 WHERE id = 19;
UPDATE seasons SET episode_count = 14 WHERE id = 20;
UPDATE seasons SET episode_count = 15 WHERE id = 21;
UPDATE seasons SET episode_count = 14 WHERE id = 22;
UPDATE seasons SET episode_count = 15 WHERE id = 23;
UPDATE seasons SET episode_count = 14 WHERE id = 24;
UPDATE seasons SET episode_count = 14 WHERE id = 25;
UPDATE seasons SET episode_count = 14 WHERE id = 26;
UPDATE seasons SET episode_count = 14 WHERE id = 27;
UPDATE seasons SET episode_count = 13 WHERE id = 28;
UPDATE seasons SET episode_count = 14 WHERE id = 29;
UPDATE seasons SET episode_count = 14 WHERE id = 30;
UPDATE seasons SET episode_count = 14 WHERE id = 31;
UPDATE seasons SET episode_count = 14 WHERE id = 32;
UPDATE seasons SET episode_count = 13 WHERE id = 33;
UPDATE seasons SET episode_count = 12 WHERE id = 34;
UPDATE seasons SET episode_count = 13 WHERE id = 35;
UPDATE seasons SET episode_count = 13 WHERE id = 36;
UPDATE seasons SET episode_count = 13 WHERE id = 37;
UPDATE seasons SET episode_count = 13 WHERE id = 38;
UPDATE seasons SET episode_count = 13 WHERE id = 39;
UPDATE seasons SET episode_count = 14 WHERE id = 40;
UPDATE seasons SET episode_count = 13 WHERE id = 41;
UPDATE seasons SET episode_count = 13 WHERE id = 42;
UPDATE seasons SET episode_count = 13 WHERE id = 43;
UPDATE seasons SET episode_count = 13 WHERE id = 44;
UPDATE seasons SET episode_count = 13 WHERE id = 45;
UPDATE seasons SET episode_count = 13 WHERE id = 46;
UPDATE seasons SET episode_count = 14 WHERE id = 47;
UPDATE seasons SET episode_count = 13 WHERE id = 48;
UPDATE seasons SET episode_count = 13 WHERE id = 49;
UPDATE seasons SET episode_count = 13 WHERE id = 50;

-- One row per note. offset_secs is the caller's accumulated watch time at the
-- moment of writing, frozen here and never recomputed; NULL when no live timer
-- was running.
CREATE TABLE posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id   INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    offset_secs INTEGER,
    FOREIGN KEY (season_id) REFERENCES seasons (id),
    FOREIGN KEY (user_id)   REFERENCES users (id)
);

CREATE INDEX idx_posts_board ON posts (season_id, episode, id);

-- Presence = "this user opened this episode's board for reading". One-way:
-- there is no re-lock, because you cannot unsee it anyway.
CREATE TABLE reveals (
    user_id    TEXT    NOT NULL,
    season_id  INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

-- A running or paused watch timer. elapsed_secs banks time from completed
-- segments; running_since marks the current one and is NULL while paused.
-- last_activity_at is touched by start, pause, resume, and posting — three
-- hours of silence ends the session.
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
