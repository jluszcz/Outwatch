-- What one board column intends for one episode, as opposed to what it has
-- already done. `watched` records a finished season and `posts` record having
-- been there; neither can say "Episode 8 is a recap and I am not coming."
-- Without that, silence on an episode reads as "not there yet" when it means
-- "not coming at all."
--
-- Keyed on user_id rather than an email, matching reveals, watch_sessions and
-- watch_offsets. This is the split the rest of the schema draws: authorship and
-- reactions are per individual, everything about watching is per column. A
-- couple shares a screen, so they skip the recap together.
--
-- Two enum columns rather than one. `status` has exactly one legal value today,
-- which is why this is not a reveals-style presence table: a second status
-- later is a change to a string set in the route rather than a migration. It
-- also carries real meaning against `reason` — a reason applies to `skipping`
-- and would not apply to a future status — so the route validates the pair
-- rather than the two fields independently. Absence of a row is the only
-- representation of "no status."
--
-- `created_at` is when the skip was first declared, and the route's upsert
-- deliberately leaves it alone when only the reason changes.
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

-- The discussion read loads every user's statuses for a season at once,
-- filtering on the primary key's second column, so the implicit PK index cannot
-- serve it. Same reason idx_watch_offsets_season exists.
CREATE INDEX idx_episode_statuses_season ON episode_statuses (season_id);
