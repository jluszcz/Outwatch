-- A correction to one person's watch-timer zero point for one episode, in
-- seconds. Everyone watches separately, so timers never drift as a rate — they
-- drift because one person hit start before the "previously on" and another
-- skipped the recap outright. That is a constant shift, and a constant shift
-- needs exactly one number.
--
-- Deliberately NOT a column on watch_sessions. `start` zeroes that row — it is
-- the "I'm beginning this episode" action — and zeroing a correction would
-- silently un-shift the notes it had already moved. The correction has to
-- outlive the session that produced it, and it has to be writable when no
-- session exists at all: noticing your notes are misplaced usually happens
-- while reading the board days later.
--
-- Applied on read (see GET /api/seasons/:season_id/discussion), never baked
-- into posts.offset_secs, which keeps meaning what the writer's timer actually
-- read. That is what makes a correction revisable and a bad nudge undoable.
--
-- Keyed on user_id rather than an email, matching watch_sessions: a couple
-- shares a column, a screen, and therefore a timer. This is the same split the
-- rest of the schema draws — authorship and reactions are per individual,
-- everything about watching is per column.
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

-- The read path queries by season, filtering on the primary key's second
-- column, so the implicit PK index cannot serve it. The discussion read loads
-- every user's corrections for a season at once.
CREATE INDEX idx_watch_offsets_season ON watch_offsets (season_id);
