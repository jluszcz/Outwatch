-- Replies, edits, and reactions on discussion notes.

-- The note being answered. NULL for an ordinary note, and also for a reply
-- whose parent has since been deleted: DELETE /api/posts/:post_id detaches its
-- children rather than leaving a dangling id or a [deleted] tombstone. Always
-- in the same season and episode as the reply itself — the API enforces that at
-- write time, so no read path re-checks it.
ALTER TABLE posts ADD COLUMN reply_to_post_id INTEGER REFERENCES posts (id);

-- When the body was last rewritten, NULL on a note never edited. created_at and
-- offset_secs are never touched by an edit, so a note holds its place on the
-- timeline no matter how often it changes.
ALTER TABLE posts ADD COLUMN edited_at TEXT;

-- One row per (note, person, emoji). Keyed on email rather than user_id because
-- a reaction is a personal response, like a note's byline and unlike a watched
-- checkbox: both halves of a shared column react separately. There is
-- deliberately no user_id column — the email resolves to a column through
-- user_emails, and unlike posts.author_email it is never NULL, so it has no
-- legacy fallback to serve. COLLATE NOCASE matches user_emails (migration 0004),
-- so a stored spelling and a lowercased one are the same key.
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
