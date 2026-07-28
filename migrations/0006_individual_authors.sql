-- Discussion notes are attributed to the individual who wrote them rather than
-- to the board column they share. Everything else — the watched checkboxes,
-- watch timers, episode reveals, and the spoiler gate — stays column-level: a
-- couple watches together, so they check, time, and unlock together.

-- The individual's display name, shown as a note's byline. NULL means the
-- roster has no individual name for this login, which is the ordinary case for
-- a solo column — its notes fall back to users.name. Real names are loaded from
-- the gitignored roster.sql, never from a migration.
ALTER TABLE user_emails ADD COLUMN name TEXT;

-- Who wrote the note. NULL on every row predating this migration: nothing in
-- the data says which half of a shared column wrote those, so they are
-- attributed by hand from roster.sql rather than guessed at here. A NULL author
-- falls back to the column in both the byline and the delete rule.
ALTER TABLE posts ADD COLUMN author_email TEXT REFERENCES user_emails (email);
