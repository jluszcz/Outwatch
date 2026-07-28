-- Template for the board roster: who the columns are and which login emails may
-- act as each one. The real version lives in roster.sql (gitignored) so that real
-- names and email addresses never enter source control — see the README
-- ("The roster").
--
-- Copy this file to roster.sql, replace the fake names/emails with the real ones
-- (keep the generic user-N ids), then apply it to BOTH local and production D1:
--   npx wrangler d1 execute outwatch --local  --file=roster.sql
--   npx wrangler d1 execute outwatch --remote --file=roster.sql
--
-- Notes:
--   * user ids are deliberately generic (user-1, user-2, …) so committed files
--     reveal nothing about who the real people are.
--   * `users.name` is the column header shown on the board.
--   * a couple shares one column (one users row, two user_emails rows).
--   * email case is not significant — user_emails.email is COLLATE NOCASE, and
--     the Worker lowercases the Access identity before looking it up.
--   * `user_emails.name` is the individual's display name on a discussion note.
--     Leave it NULL for a one-person column — its notes fall back to the
--     column name. Set it for each half of a shared column, which is the whole
--     point: it is what turns a note bylined "Bob & Carol" into one bylined
--     "Carol".
--   * both blocks below upsert rather than ignore — users on conflict (id), and
--     user_emails on conflict (email) — so editing a column name, a byline, or
--     an email and re-applying updates the existing rows instead of quietly
--     doing nothing.

INSERT INTO users (id, name, sort_order) VALUES
    ('user-1', 'Alice',        1),
    ('user-2', 'Bob & Carol',  2),
    ('user-3', 'Dave & Erin',  3)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;

INSERT INTO user_emails (email, user_id, name) VALUES
    ('alice@example.com', 'user-1', NULL),
    ('bob@example.com',   'user-2', 'Bob'),
    ('carol@example.com', 'user-2', 'Carol'),
    ('dave@example.com',  'user-3', 'Dave'),
    ('erin@example.com',  'user-3', 'Erin')
ON CONFLICT (email) DO UPDATE SET user_id = excluded.user_id, name = excluded.name;

-- One-time attribution of notes written before individual authorship existed.
-- Nothing in the data records which half of a shared column wrote them, so each
-- column's old notes go to one partner; some will be wrong, and afterwards only
-- that partner can delete them. Solo columns need a line too — their bylines are
-- already right via the fallback, but without an author_email their notes have
-- no accent stripe. Guarded on IS NULL, so re-applying this file later matches
-- nothing: every note written from now on carries its author.
UPDATE posts SET author_email = 'alice@example.com'
 WHERE user_id = 'user-1' AND author_email IS NULL;
UPDATE posts SET author_email = 'bob@example.com'
 WHERE user_id = 'user-2' AND author_email IS NULL;
UPDATE posts SET author_email = 'dave@example.com'
 WHERE user_id = 'user-3' AND author_email IS NULL;
