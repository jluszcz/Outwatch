-- Rebuild user_emails so email matching is case-insensitive at the schema level.
-- The worker lowercases the Access email before lookup, but a mixed-case entry in
-- roster.sql would silently never match — the person would just see the read-only
-- notice. COLLATE NOCASE makes that impossible to get wrong. SQLite cannot alter
-- a column's collation in place, so recreate the table and copy the rows over.
CREATE TABLE user_emails_new (
    email   TEXT PRIMARY KEY COLLATE NOCASE,
    user_id TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
);

-- OR IGNORE: if two rows differ only by case, the second is dropped. That is
-- only lossy if a misconfigured roster mapped the two spellings to *different*
-- users — under NOCASE they could never both match anyway, so dropping one is
-- acceptable for a <5-person roster.
INSERT OR IGNORE INTO user_emails_new (email, user_id)
SELECT lower(email), user_id FROM user_emails;

DROP TABLE user_emails;

ALTER TABLE user_emails_new RENAME TO user_emails;

CREATE INDEX idx_user_emails_user ON user_emails (user_id);
