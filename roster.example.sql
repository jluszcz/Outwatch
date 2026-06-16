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
--   * `name` is the column header shown on the board.
--   * a couple shares one column (one users row, two user_emails rows).
--   * emails MUST be lowercase.

INSERT OR IGNORE INTO users (id, name, sort_order) VALUES
    ('user-1', 'Alice',        1),
    ('user-2', 'Bob & Carol',  2),
    ('user-3', 'Dave & Erin',  3);

INSERT OR IGNORE INTO user_emails (email, user_id) VALUES
    ('alice@example.com', 'user-1'),
    ('bob@example.com',   'user-2'),
    ('carol@example.com', 'user-2'),
    ('dave@example.com',  'user-3'),
    ('erin@example.com',  'user-3');
