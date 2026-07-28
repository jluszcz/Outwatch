# Discussion Replies, Edits, and Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add quote replies, note editing, and four-emoji reactions to the per-episode discussion boards, without widening the spoiler gate.

**Architecture:** Two nullable columns on `posts` (`reply_to_post_id`, `edited_at`) and one new `reactions` table carry the whole feature. A shared `visiblePost()` helper gives the single-post routes the same visibility predicate the discussion read path already applies per episode, so replying and reacting can never touch a note the caller cannot see. On the client, note rendering moves out of `discussion.js` into a new `frontend/post.js`; reply/edit/picker state lives in `EpisodeBoard`, and all three mutations route through the existing `useRefreshGuard` path.

**Tech Stack:** Cloudflare Workers + Hono + Zod 4, D1 (SQLite), Preact + htm bundled by esbuild, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-07-28-discussion-replies-edits-reactions-design.md`

## Global Constraints

- **Never commit real names or email addresses.** Tests, migrations, and examples use fake placeholders only (`user-N` ids, `@example.com`).
- **Before every commit, all four must pass:** `npm run build`, `npm test`, `npm run lint`, `npm run format:check`.
- **Never use `--no-verify`.** If a hook modifies files, restage and run a fresh `git commit` — never amend.
- Work on branch `discussion-replies-edits-reactions` (already created, tracks `origin/main`). Never commit to `main`.
- Edit files under `frontend/`. Never edit `public/script.js` — it is build output.
- The eight-emoji set was cut to four during spec review: **👍 👎 🤣 😮**, defined once in `shared/reactions.js`.
- Reactions are keyed on the individual's **email**; watched/reveals/timers stay keyed on the **column** (`users.id`). Do not mix these up.
- A route must never distinguish "not yours" from "does not exist" — both return `404 { error: 'Unknown post' }`.
- In `styles.css`, any `@media (max-width: 640px)` rule must sit **after** every un-gated base rule it overrides, and every `:hover` rule goes behind `@media (hover: hover)`.

## File Structure

| File | Responsibility |
| --- | --- |
| `migrations/0007_replies_edits_reactions.sql` (create) | The two `posts` columns and the `reactions` table |
| `shared/reactions.js` (create) | `REACTIONS` — the valid emoji set, imported by Worker and browser |
| `src/index.js` (modify) | `visiblePost()`, reply validation, `PATCH`, `PUT …/reactions`, richer discussion serialization, delete cleanup |
| `frontend/post.js` (create) | `PostList`, `Post`, `Quote`, `ReactionBar`, `EmojiPicker`, `EditForm` |
| `frontend/discussion.js` (modify) | `SeasonView` mutations, `EpisodeBoard` state, `PostForm` reply chip |
| `frontend/hooks.js` (modify) | `useAutoSize` — extracted from `PostForm.fit()` |
| `frontend/utils.js` (modify) | `quoteSnippet` |
| `frontend/styles.css` (modify) | Quote block, action row, reaction chips, picker, edit form |
| `test/worker/discussion.test.js` (modify) | Replies, edits, reactions, delete cleanup |
| `test/worker/migrations.test.js` (modify) | Migration 0007 shape |
| `test/frontend/utils.test.js` (modify) | `quoteSnippet` |
| `test/frontend/posts.test.js` (modify) | Reply ordering |
| `CLAUDE.md` (modify) | Schema, routes, frontend notes — updated in the task that changes each |

## Two refinements to the approved spec

Both are small, in the spec's spirit, and are called out so the reviewer can reject them:

1. **`reactions.email` gets `COLLATE NOCASE`.** The spec's DDL used plain `TEXT`. Migration `0004` rebuilt `user_emails` with `COLLATE NOCASE` for exactly this reason, and the reactions primary key compares emails.
2. **`reply_to` carries `mine`.** The spec listed `{ id, author_name, author_index, body }`. Adding `mine` lets the client call the existing `authorAccent()` on the quote unchanged, rather than reimplementing "is this me" for quotes.

---

### Task 1: Migration 0007

**Files:**

- Create: `migrations/0007_replies_edits_reactions.sql`
- Test: `test/worker/migrations.test.js`

**Interfaces:**

- Produces: `posts.reply_to_post_id` (INTEGER, nullable), `posts.edited_at` (TEXT, nullable), table `reactions (post_id, email, emoji, created_at)` with PK `(post_id, email, emoji)`.

- [ ] **Step 1: Write the failing test**

Append to `test/worker/migrations.test.js`:

```js
// Migration 0007. The two posts columns arrive by ALTER TABLE, which rewrites
// the stored CREATE statement, so sqlite_master records whether they applied.
describe('reply, edit, and reaction schema', () => {
    it('adds the reply and edit columns to posts', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'posts'",
        ).first();
        expect(row.sql).toContain('reply_to_post_id INTEGER');
        expect(row.sql).toContain('edited_at TEXT');
    });

    it('creates the reactions table keyed on the individual', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reactions'",
        ).first();
        expect(row.sql).toContain('COLLATE NOCASE');
        expect(row.sql).toContain('PRIMARY KEY (post_id, email, emoji)');
    });

    it('rejects a duplicate reaction from the same person', async () => {
        await env.DB.exec(
            "INSERT OR IGNORE INTO users (id, name, sort_order) VALUES ('user-mig', 'Mig', 9)",
        );
        await env.DB.exec(
            "INSERT OR IGNORE INTO user_emails (email, user_id) VALUES ('mig@example.com', 'user-mig')",
        );
        const inserted = await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at)
             VALUES (1, 1, 'user-mig', 'note', '2026-07-28T00:00:00.000Z')
             RETURNING id`,
        ).first();
        const postId = inserted.id;
        const insert = () =>
            env.DB.prepare(
                `INSERT OR IGNORE INTO reactions (post_id, email, emoji, created_at)
                 VALUES (?, 'mig@example.com', '👍', '2026-07-28T00:00:00.000Z')`,
            )
                .bind(postId)
                .run();
        await insert();
        await insert();
        const { results } = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?',
        )
            .bind(postId)
            .all();
        expect(results[0].n).toBe(1);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: FAIL — `posts` has no `reply_to_post_id`, and there is no `reactions` table.

- [ ] **Step 3: Write the migration**

Create `migrations/0007_replies_edits_reactions.sql`:

```sql
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: PASS

- [ ] **Step 5: Update CLAUDE.md**

In the "Repository Structure" list under `migrations/`, add after the `0006` line:

```markdown
    - `0007_replies_edits_reactions.sql` — adds `posts.reply_to_post_id` and `posts.edited_at`; creates `reactions`
```

In "Database Schema", extend the `posts` bullet with `reply_to_post_id` and `edited_at`, and add a `reactions` bullet:

```markdown
- `reactions` — `(post_id, email, emoji)` PK + `created_at`; presence = that individual put that emoji on that note. Keyed on the email, not the column, so both halves of a shared column react separately
```

- [ ] **Step 6: Run the full gates and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add migrations/0007_replies_edits_reactions.sql test/worker/migrations.test.js CLAUDE.md
git commit -m "feat(db): add reply, edit, and reaction schema"
```

---

### Task 2: Server — replies

**Files:**

- Modify: `src/index.js`
- Test: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `posts.reply_to_post_id` from Task 1.
- Produces:
    - `async function visiblePost(c, postId, me)` → the post row (`{ id, season_id, episode, user_id, body, author_email }`) when the caller may see it, else `null`. Used by Tasks 3 and 4.
    - `POST …/posts` accepts `reply_to_post_id: number | null | undefined`.
    - Each serialized post gains `reply_to: { id, author_name, author_index, mine, body } | { id, locked: true } | null`.
    - `DELETE /api/posts/:post_id` checks ownership with a `SELECT` first, then batches its cleanup.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/discussion.test.js`. `reveal()` and `watch()` are local helpers defined here so later tasks can reuse them:

```js
async function post(email, body, episode = 7, replyTo = undefined) {
    const r = await req('POST', `/api/seasons/45/episodes/${episode}/posts`, {
        body: replyTo === undefined ? { body } : { body, reply_to_post_id: replyTo },
        email,
    });
    return r;
}

async function reveal(email, episode = 7) {
    return req('POST', `/api/seasons/45/episodes/${episode}/reveal`, { email });
}

async function watch(email) {
    return req('POST', '/api/watched', { body: { season_id: 45 }, email });
}

async function discussion(email, episode = 7) {
    const { episodes } = await (await req('GET', '/api/seasons/45/discussion', { email })).json();
    return episodes.find((e) => e.episode === episode);
}

describe('quote replies', () => {
    it('stores the parent and serializes it with its body', async () => {
        const { post: parent } = await (await post('bob@example.com', 'jeff is right')).json();
        await reveal('alice@example.com');
        const r = await post('alice@example.com', 'agreed', 7, parent.id);
        expect(r.status).toBe(201);

        const ep = await discussion('alice@example.com');
        const reply = ep.posts.find((p) => p.body === 'agreed');
        expect(reply.reply_to).toMatchObject({
            id: parent.id,
            author_name: 'Bob',
            body: 'jeff is right',
            mine: false,
        });
    });

    it('returns 404 for a parent in another episode', async () => {
        const { post: parent } = await (await post('alice@example.com', 'ep 6 note', 6)).json();
        const r = await post('alice@example.com', 'reply', 7, parent.id);
        expect(r.status).toBe(404);
    });

    it('returns 404 for a parent the caller cannot see', async () => {
        const { post: parent } = await (await post('bob@example.com', 'secret')).json();
        const r = await post('alice@example.com', 'reply', 7, parent.id);
        expect(r.status).toBe(404);
    });

    it('returns 404 for a parent that does not exist', async () => {
        const r = await post('alice@example.com', 'reply', 7, 999999);
        expect(r.status).toBe(404);
    });

    // The one case the locked form exists for: marking a season watched makes
    // every episode readable without writing a reveals row, so unmarking it
    // re-locks episodes the caller never explicitly revealed — while their own
    // reply, and its now-unreadable parent id, remain.
    it('hides a parent that became unreadable after an unmark', async () => {
        const { post: parent } = await (await post('bob@example.com', 'the blindside')).json();
        await watch('alice@example.com');
        await post('alice@example.com', 'called it', 7, parent.id);
        await req('DELETE', '/api/watched/45', { email: 'alice@example.com' });

        const ep = await discussion('alice@example.com');
        expect(ep.readable).toBe(false);
        const reply = ep.posts.find((p) => p.body === 'called it');
        expect(reply.reply_to).toEqual({ id: parent.id, locked: true });
        expect(JSON.stringify(ep)).not.toContain('the blindside');
    });

    it('leaves a reply intact when its parent is deleted', async () => {
        const { post: parent } = await (await post('alice@example.com', 'first')).json();
        await post('alice@example.com', 'second', 7, parent.id);
        const del = await req('DELETE', `/api/posts/${parent.id}`, { email: 'alice@example.com' });
        expect(del.status).toBe(200);

        const ep = await discussion('alice@example.com');
        const reply = ep.posts.find((p) => p.body === 'second');
        expect(reply).toBeDefined();
        expect(reply.reply_to).toBeNull();
    });

    it('does not let a non-owner delete detach anything', async () => {
        const { post: parent } = await (await post('bob@example.com', 'bob note')).json();
        await reveal('alice@example.com');
        await post('alice@example.com', 'alice reply', 7, parent.id);

        const del = await req('DELETE', `/api/posts/${parent.id}`, { email: 'alice@example.com' });
        expect(del.status).toBe(404);

        const ep = await discussion('alice@example.com');
        const reply = ep.posts.find((p) => p.body === 'alice reply');
        expect(reply.reply_to.body).toBe('bob note');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'quote replies'`
Expected: FAIL — `reply_to` is undefined on every serialized post.

- [ ] **Step 3: Add the schema change and the visibility helper**

In `src/index.js`, replace the `postCreate` schema with a shared body field plus the two shapes:

```js
const postBody = z
    .string()
    .trim()
    .min(1, { message: 'body must not be empty' })
    .max(2000, { message: 'body must be at most 2000 characters' });

const postCreate = z.object({
    body: postBody,
    reply_to_post_id: z
        .number()
        .int()
        .positive({ message: 'reply_to_post_id must be a positive integer' })
        .nullish(),
});
```

Add `visiblePost` next to `resolveEpisode`:

```js
// The single-post form of the spoiler gate. GET /discussion evaluates
// readability per episode; the routes that act on one post by id need the same
// predicate for one row. Returns the post when the caller may see it — the
// board is readable (season watched, or that episode revealed) or it is their
// own column's note — and null otherwise. Callers turn null into the same 404 a
// missing post gets, so these routes never become an oracle for which post ids
// are real.
async function visiblePost(c, postId, me) {
    if (!me) return null;

    const post = await c.env.DB.prepare(
        `SELECT id, season_id, episode, user_id, body, author_email
         FROM posts WHERE id = ?`,
    )
        .bind(postId)
        .first();
    if (!post) return null;

    // Column-level, matching the read path: a partner's note is not a spoiler.
    if (post.user_id === me.id) return post;

    const [watchedRow, revealRow] = await Promise.all([
        c.env.DB.prepare('SELECT 1 FROM watched WHERE user_id = ? AND season_id = ?')
            .bind(me.id, post.season_id)
            .first(),
        c.env.DB.prepare(
            'SELECT 1 FROM reveals WHERE user_id = ? AND season_id = ? AND episode = ?',
        )
            .bind(me.id, post.season_id, post.episode)
            .first(),
    ]);
    return watchedRow || revealRow ? post : null;
}
```

- [ ] **Step 4: Validate and store the parent on POST**

In the `POST …/posts` handler, replace `const { body } = c.req.valid('json');` with:

```js
const { body, reply_to_post_id: replyToId = null } = c.req.valid('json');

// A reply may only point at a note the caller can actually see, in this same
// episode. Missing, wrong-episode, and not-visible all answer 404 alike.
if (replyToId != null) {
    const parent = await visiblePost(c, replyToId, me);
    if (!parent || parent.season_id !== season.id || parent.episode !== episode) {
        return c.json({ error: 'Unknown post' }, 404);
    }
}
```

Then widen the insert:

```js
c.env.DB.prepare(
    `INSERT INTO posts (season_id, episode, user_id, body, created_at, offset_secs, author_email, reply_to_post_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, season_id, episode, user_id, body, created_at, offset_secs, reply_to_post_id`,
).bind(season.id, episode, me.id, body, now, offsetSecs, me.email, replyToId),
```

- [ ] **Step 5: Serialize `reply_to`**

In `src/index.js`, add next to `attribute()`:

```js
// A quote block's source. The parent is always in the same season, so it comes
// from the map already built over the season's posts — no extra query. Three
// forms: absent, visible (with its body), or locked (its id alone). A locked
// parent's body is never serialized, which is the whole point: reply_to_post_id
// is frozen at write time while visibility is recomputed on every read, so the
// two can disagree.
function quoteOf(post, byId, visibleIds, people, me) {
    if (post.reply_to_post_id == null) return null;
    const parent = byId.get(post.reply_to_post_id);
    if (!parent) return null;
    if (!visibleIds.has(parent.id)) return { id: parent.id, locked: true };
    const { author_name, author_index, mine } = attribute(parent, people, me);
    return { id: parent.id, author_name, author_index, mine, body: parent.body };
}
```

In the discussion route, widen the posts `SELECT` to include `reply_to_post_id, edited_at`, and build the id map right after `byEpisode`:

```js
const byId = new Map(posts.map((p) => [p.id, p]));
```

Inside the episode loop, after `const visible = …`:

```js
const visibleIds = new Set(visible.map((p) => p.id));
```

and extend the serialized post with:

```js
edited_at: p.edited_at,
reply_to: quoteOf(p, byId, visibleIds, people, me),
```

- [ ] **Step 6: Rework the delete route**

Replace the body of `app.delete('/api/posts/:post_id', …)` after the `postId` validation with:

```js
// Ownership is checked first, with a select, so a caller who does not own the
// note cannot reach the cleanup statements below and strip its reactions or
// detach its replies.
const owned = await c.env.DB.prepare(
    `SELECT id FROM posts
     WHERE id = ? AND user_id = ? AND (author_email = ? OR author_email IS NULL)`,
)
    .bind(postId, me.id, me.email)
    .first();
if (!owned) return c.json({ error: 'Unknown post' }, 404);

// Order matters whether or not D1 enforces foreign keys: dependants go before
// the row they reference. Children are detached rather than deleted — a reply
// survives its parent as an ordinary note, because delete is the author's
// explicit "unsay it" and a [deleted] ghost would preserve what they removed.
const [, , deleted] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM reactions WHERE post_id = ?').bind(postId),
    c.env.DB.prepare('UPDATE posts SET reply_to_post_id = NULL WHERE reply_to_post_id = ?').bind(
        postId,
    ),
    c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId),
]);
// The row vanished between the select and the batch — report it honestly
// rather than as a success that deleted nothing.
if (deleted.meta.changes === 0) return c.json({ error: 'Unknown post' }, 404);

return c.json({ success: true, post_id: postId });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS — the new `quote replies` block and every pre-existing test.

- [ ] **Step 8: Update CLAUDE.md**

In "API Routes", extend the `POST …/posts` bullet to mention the optional `reply_to_post_id` (same episode, must be visible to the caller, 404 otherwise), extend the `GET …/discussion` bullet with `reply_to` and its three forms, and extend the `DELETE /api/posts/:post_id` bullet with the ownership-check-then-batch behaviour and the fact that replies are detached rather than deleted.

- [ ] **Step 9: Run the full gates and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js CLAUDE.md
git commit -m "feat(api): let a note quote another note in the same episode"
```

---

### Task 3: Server — editing

**Files:**

- Modify: `src/index.js`
- Test: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `postBody` schema and `posts.edited_at` from Tasks 1–2.
- Produces: `PATCH /api/posts/:post_id` with body `{ body }` → `{ success: true, post_id, edited_at }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/discussion.test.js`:

```js
describe('PATCH /api/posts/:post_id', () => {
    it('rewrites the body and stamps edited_at without moving the note', async () => {
        const { post: p } = await (await post('alice@example.com', 'typo hree')).json();
        const r = await req('PATCH', `/api/posts/${p.id}`, {
            body: { body: 'typo here' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);

        const ep = await discussion('alice@example.com');
        const edited = ep.posts.find((x) => x.id === p.id);
        expect(edited.body).toBe('typo here');
        expect(edited.edited_at).not.toBeNull();
        expect(edited.created_at).toBe(p.created_at);
        expect(edited.offset_secs).toBe(p.offset_secs);
    });

    it('is null on edited_at until the note is edited', async () => {
        await post('alice@example.com', 'untouched');
        const ep = await discussion('alice@example.com');
        expect(ep.posts[0].edited_at).toBeNull();
    });

    it('refuses a note written by the other individual in the same column', async () => {
        const { post: p } = await (await post('bob@example.com', 'bob wrote this')).json();
        const r = await req('PATCH', `/api/posts/${p.id}`, {
            body: { body: 'carol rewrote it' },
            email: 'carol@example.com',
        });
        expect(r.status).toBe(404);
    });

    // A note predating individual attribution belongs to the column, exactly as
    // the delete rule has it.
    it('allows the column to edit a note with no recorded author', async () => {
        await env.DB.exec(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at)
             VALUES (45, 7, 'user-bob', 'legacy note', '2026-01-01T00:00:00.000Z')`,
        );
        const row = await env.DB.prepare("SELECT id FROM posts WHERE body = 'legacy note'").first();
        const r = await req('PATCH', `/api/posts/${row.id}`, {
            body: { body: 'legacy note, fixed' },
            email: 'carol@example.com',
        });
        expect(r.status).toBe(200);
    });

    it('returns 400 for an empty body and one over 2000 characters', async () => {
        const { post: p } = await (await post('alice@example.com', 'note')).json();
        for (const body of ['', '   ', 'x'.repeat(2001)]) {
            const r = await req('PATCH', `/api/posts/${p.id}`, {
                body: { body },
                email: 'alice@example.com',
            });
            expect(r.status).toBe(400);
        }
    });

    it('returns 404 for a post that does not exist', async () => {
        const r = await req('PATCH', '/api/posts/999999', {
            body: { body: 'nope' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('shows an edited parent through to a reply that quotes it', async () => {
        const { post: parent } = await (await post('bob@example.com', 'before')).json();
        await reveal('alice@example.com');
        await post('alice@example.com', 'quoting', 7, parent.id);
        await req('PATCH', `/api/posts/${parent.id}`, {
            body: { body: 'after' },
            email: 'bob@example.com',
        });

        const ep = await discussion('alice@example.com');
        const reply = ep.posts.find((x) => x.body === 'quoting');
        expect(reply.reply_to.body).toBe('after');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'PATCH'`
Expected: FAIL — the route does not exist, so the catch-all answers `404 Unknown API endpoint` and the 400 cases fail.

- [ ] **Step 3: Add the schema and the route**

In `src/index.js`, beside `postCreate`:

```js
const postEdit = z.object({ body: postBody });
```

Add the route immediately above `app.delete('/api/posts/:post_id', …)`:

```js
// Editing a note changes its body and nothing else: created_at and offset_secs
// are frozen, so the note holds its place on the timeline however often it is
// rewritten, and reply_to_post_id is frozen so an edit cannot re-point a quote.
// Season-agnostic like the delete route — a post id alone identifies the row.
// Ownership is the same predicate delete uses: the individual who wrote it, or
// the column for a note predating individual attribution. Not-yours and
// not-real answer 404 alike.
app.patch('/api/posts/:post_id', zValidator('json', postEdit, onInvalid), async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const postId = Number(c.req.param('post_id'));
    if (!Number.isInteger(postId) || postId <= 0) {
        return c.json({ error: 'post_id must be a positive integer' }, 400);
    }

    const { body } = c.req.valid('json');
    const editedAt = new Date().toISOString();

    const { meta } = await c.env.DB.prepare(
        `UPDATE posts SET body = ?, edited_at = ?
         WHERE id = ? AND user_id = ? AND (author_email = ? OR author_email IS NULL)`,
    )
        .bind(body, editedAt, postId, me.id, me.email)
        .run();
    if (meta.changes === 0) return c.json({ error: 'Unknown post' }, 404);

    // The client refetches the whole discussion regardless, so this is a
    // receipt rather than a payload.
    return c.json({ success: true, post_id: postId, edited_at: editedAt });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS

- [ ] **Step 5: Update CLAUDE.md**

Add to "API Routes", after the `POST …/posts` bullet:

```markdown
- `PATCH /api/posts/:post_id` — `{ body }`; rewrites one of the caller's own notes and stamps `edited_at`. Same ownership rule as `DELETE` (the individual author, or the column for a note with no recorded `author_email`), and the same 404 for a note that isn't theirs or doesn't exist. `created_at`, `offset_secs`, and `reply_to_post_id` are never touched, so an edit cannot move a note on the timeline
```

- [ ] **Step 6: Run the full gates and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js CLAUDE.md
git commit -m "feat(api): let an author rewrite their own note"
```

---

### Task 4: Server — reactions

**Files:**

- Create: `shared/reactions.js`
- Modify: `src/index.js`
- Test: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `visiblePost()` from Task 2, the `reactions` table from Task 1.
- Produces:
    - `shared/reactions.js` exporting `REACTIONS` — `[{ emoji, label }]`, order significant. Used by Task 8.
    - `PUT /api/posts/:post_id/reactions` with body `{ emoji, on }`.
    - Each serialized post gains `reactions: [{ emoji, count, mine, names }]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/discussion.test.js`:

```js
async function react(email, postId, emoji, on) {
    return req('PUT', `/api/posts/${postId}/reactions`, { body: { emoji, on }, email });
}

describe('PUT /api/posts/:post_id/reactions', () => {
    it('adds a reaction and is idempotent', async () => {
        const { post: p } = await (await post('alice@example.com', 'note')).json();
        expect((await react('alice@example.com', p.id, '👍', true)).status).toBe(200);
        await react('alice@example.com', p.id, '👍', true);

        const ep = await discussion('alice@example.com');
        expect(ep.posts[0].reactions).toEqual([
            { emoji: '👍', count: 1, mine: true, names: ['Alice'] },
        ]);
    });

    it('removes a reaction, and removing an absent one is a no-op', async () => {
        const { post: p } = await (await post('alice@example.com', 'note')).json();
        await react('alice@example.com', p.id, '👍', true);
        await react('alice@example.com', p.id, '👍', false);
        expect((await react('alice@example.com', p.id, '👍', false)).status).toBe(200);

        const ep = await discussion('alice@example.com');
        expect(ep.posts[0].reactions).toEqual([]);
    });

    it('lets one person apply several different emoji, in set order', async () => {
        const { post: p } = await (await post('alice@example.com', 'note')).json();
        await react('alice@example.com', p.id, '😮', true);
        await react('alice@example.com', p.id, '👍', true);

        const ep = await discussion('alice@example.com');
        expect(ep.posts[0].reactions.map((r) => r.emoji)).toEqual(['👍', '😮']);
    });

    // Reactions are the individual's, so the two halves of a shared column count
    // separately — unlike the watched checkbox they sit beside.
    it('counts both halves of a shared column separately', async () => {
        const { post: p } = await (await post('alice@example.com', 'note')).json();
        await reveal('bob@example.com');
        await reveal('carol@example.com');
        await react('bob@example.com', p.id, '🤣', true);
        await react('carol@example.com', p.id, '🤣', true);

        const ep = await discussion('alice@example.com');
        const [chip] = ep.posts[0].reactions;
        expect(chip.count).toBe(2);
        expect(chip.names.sort()).toEqual(['Bob', 'Carol']);
        expect(chip.mine).toBe(false);
    });

    it('allows reacting to your own note', async () => {
        const { post: p } = await (await post('alice@example.com', 'note')).json();
        expect((await react('alice@example.com', p.id, '🤣', true)).status).toBe(200);
    });

    it('returns 400 for an emoji outside the set', async () => {
        const { post: p } = await (await post('alice@example.com', 'note')).json();
        for (const emoji of ['❤️', '🐍', 'x', '']) {
            expect((await react('alice@example.com', p.id, emoji, true)).status).toBe(400);
        }
    });

    it('returns 404 for a post the caller cannot see', async () => {
        const { post: p } = await (await post('bob@example.com', 'hidden')).json();
        expect((await react('alice@example.com', p.id, '👍', true)).status).toBe(404);
    });

    it('returns 404 for a post that does not exist', async () => {
        expect((await react('alice@example.com', 999999, '👍', true)).status).toBe(404);
    });

    it('serializes no reactions for a foreign post on a locked board', async () => {
        const { post: p } = await (await post('bob@example.com', 'locked body')).json();
        await react('bob@example.com', p.id, '👍', true);

        const ep = await discussion('alice@example.com');
        expect(ep.readable).toBe(false);
        expect(ep.posts).toHaveLength(0);
        expect(JSON.stringify(ep)).not.toContain('👍');
    });

    it('takes a post reactions with it when the post is deleted', async () => {
        const { post: p } = await (await post('alice@example.com', 'note')).json();
        await react('alice@example.com', p.id, '👍', true);
        await req('DELETE', `/api/posts/${p.id}`, { email: 'alice@example.com' });

        const { results } = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?',
        )
            .bind(p.id)
            .all();
        expect(results[0].n).toBe(0);
    });

    it('leaves reactions alone when a non-owner delete is refused', async () => {
        const { post: p } = await (await post('bob@example.com', 'bob note')).json();
        await react('bob@example.com', p.id, '👍', true);
        expect((await req('DELETE', `/api/posts/${p.id}`, { email: 'alice@example.com' })).status).toBe(
            404,
        );

        const { results } = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?',
        )
            .bind(p.id)
            .all();
        expect(results[0].n).toBe(1);
    });
});
```

Also add `DELETE FROM reactions` as the **first** statement in the existing `beforeEach` cleanup, before `DELETE FROM posts` — children before parents.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'reactions'`
Expected: FAIL — the route does not exist and `reactions` is undefined on serialized posts.

- [ ] **Step 3: Create the shared emoji set**

Create `shared/reactions.js`:

```js
// The valid reaction emoji, shared by the Worker (which validates against them)
// and the browser bundle (whose picker renders from them) — the two must agree
// or the client offers a button the server rejects.
//
// The array's order is the picker's order and the display order of a note's
// reaction chips. `label` is each picker button's accessible name.
//
// Matching is exact, not normalized. Every emoji here is a single codepoint
// today, but `❤️` is two (U+2764 U+FE0F) — adding it would make a bare `❤` a
// different string and a 400.
export const REACTIONS = [
    { emoji: '👍', label: 'Thumbs up' },
    { emoji: '👎', label: 'Thumbs down' },
    { emoji: '🤣', label: 'Laughing' },
    { emoji: '😮', label: 'Shocked' },
];
```

- [ ] **Step 4: Add the route**

In `src/index.js`, import the set beside the session helper:

```js
import { REACTIONS } from '../shared/reactions.js';
```

Add the schema beside the others:

```js
const reactionUpdate = z.object({
    emoji: z.enum(
        REACTIONS.map((r) => r.emoji),
        { message: 'emoji must be one of the supported reactions' },
    ),
    on: z.boolean({ message: 'on must be true or false' }),
});
```

Add the route above `app.patch('/api/posts/:post_id', …)`:

```js
// A reaction is the individual's, so it is keyed on the caller's verified email
// rather than their column — both halves of a shared column react separately.
// `on` is explicit rather than a toggle, which makes the route idempotent: a
// double tap cannot flip the state twice, and a retry after a dropped response
// is harmless. The emoji travels in the body rather than the path because every
// one of them is an astral character a path param carries only percent-encoded.
app.put('/api/posts/:post_id/reactions', zValidator('json', reactionUpdate, onInvalid), async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const postId = Number(c.req.param('post_id'));
    if (!Number.isInteger(postId) || postId <= 0) {
        return c.json({ error: 'post_id must be a positive integer' }, 400);
    }

    // Same gate, same 404: you cannot react to a note you cannot read.
    const post = await visiblePost(c, postId, me);
    if (!post) return c.json({ error: 'Unknown post' }, 404);

    const { emoji, on } = c.req.valid('json');
    if (on) {
        await c.env.DB.prepare(
            `INSERT OR IGNORE INTO reactions (post_id, email, emoji, created_at)
             VALUES (?, ?, ?, ?)`,
        )
            .bind(postId, me.email, emoji, new Date().toISOString())
            .run();
    } else {
        await c.env.DB.prepare(
            'DELETE FROM reactions WHERE post_id = ? AND email = ? AND emoji = ?',
        )
            .bind(postId, me.email, emoji)
            .run();
    }

    return c.json({ success: true, post_id: postId, emoji, on });
});
```

- [ ] **Step 5: Serialize reactions**

In `src/index.js`, add beside `quoteOf`:

```js
// A note's reactions, in REACTIONS order, omitting any nobody used. Names
// rather than a bare count: on a roster this size "2" says almost nothing and
// "Bob, Carol" says all of it. Only ever called for posts that survived the
// visibility filter, so a locked board carries no counts and no names.
function reactionsOf(postId, byPost, people, me) {
    const rows = byPost.get(postId);
    if (!rows) return [];
    return REACTIONS.map(({ emoji }) => {
        const hits = rows.filter((r) => r.emoji === emoji);
        return {
            emoji,
            count: hits.length,
            mine: Boolean(me) && hits.some((r) => r.email.toLowerCase() === me.email),
            names: hits.map((r) => people.byEmail.get(r.email.toLowerCase())?.name ?? 'Someone'),
        };
    }).filter((r) => r.count > 0);
}
```

Add a sixth query to the discussion route's `Promise.all`, and destructure it as `{ results: reactionRows }`:

```js
// One query for the season's reactions rather than one per note; grouped
// below alongside the posts themselves.
c.env.DB.prepare(
    `SELECT reactions.post_id AS post_id, reactions.email AS email, reactions.emoji AS emoji
     FROM reactions JOIN posts ON posts.id = reactions.post_id
     WHERE posts.season_id = ?`,
)
    .bind(seasonId)
    .all(),
```

Group them beside `byId`:

```js
const reactionsByPost = new Map();
for (const r of reactionRows) {
    if (!reactionsByPost.has(r.post_id)) reactionsByPost.set(r.post_id, []);
    reactionsByPost.get(r.post_id).push(r);
}
```

Extend the serialized post with:

```js
reactions: reactionsOf(p.id, reactionsByPost, people, me),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS

- [ ] **Step 7: Update CLAUDE.md**

Add `shared/reactions.js` to the "Repository Structure" list under `shared/`. Add to "API Routes":

```markdown
- `PUT /api/posts/:post_id/reactions` — `{ emoji, on }`; adds or removes one of the four emoji in `shared/reactions.js` on a note the caller can see. Idempotent in both directions, attributed to the individual's email rather than their column, and 400 for an emoji outside the set. Reacting to your own note is allowed
```

Extend the `GET …/discussion` bullet: each serialized post also carries `reactions` (`[{ emoji, count, mine, names }]`, in set order, omitting unused emoji), attached only to posts that pass the visibility filter, so a locked board carries no counts or names.

- [ ] **Step 8: Run the full gates and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add shared/reactions.js src/index.js test/worker/discussion.test.js CLAUDE.md
git commit -m "feat(api): add four-emoji reactions attributed to the individual"
```

---

### Task 5: Frontend — extract `post.js` and restructure the note

**Files:**

- Create: `frontend/post.js`
- Modify: `frontend/discussion.js`, `frontend/styles.css`

**Interfaces:**

- Produces: `PostList({ placed, meId, onDelete })` exported from `frontend/post.js`, plus the `.post-content` wrapper every later task renders into.

This task is a pure refactor: no behaviour changes, so it has no new tests. Its gate is that the existing suite, the build, and a visual check all still pass.

- [ ] **Step 1: Create `frontend/post.js` with the moved renderer**

```js
import { h } from 'preact';
import htm from 'htm';
import { authorAccent, formatOffsetShort } from './utils.js';

const html = htm.bind(h);

// The accent class for a note — 'mine' | 1..N | null, where null leaves it
// unstriped rather than inventing a colour for an author who left the roster.
export function accentClass(source) {
    const accent = authorAccent(source);
    return accent === 'mine' ? ' post-mine' : accent ? ` post-a${accent}` : '';
}

export function PostList({ placed, meId, onDelete }) {
    if (placed.length === 0) return html`<div class="no-posts">Nothing here yet.</div>`;
    return html`
        <ol class="posts">
            ${placed.map(
                (entry) =>
                    html`<${Post} key=${entry.post.id} entry=${entry} meId=${meId} onDelete=${onDelete} />`,
            )}
        </ol>
    `;
}

// One note. The time, author, and action row sit on the note's first line; the
// quote block, body, and reactions stack inside .post-content, so a plain note
// still reads as a single line on a wide screen while anything richer grows
// downward instead of sideways.
function Post({ entry, meId, onDelete }) {
    const { post, offset, inferred, tail } = entry;
    return html`
        <li class=${'post' + accentClass(post)}>
            <span class="post-time" title=${new Date(post.created_at).toLocaleString()}>
                ${
                    tail
                        ? new Date(post.created_at).toLocaleDateString()
                        : `${inferred ? '~' : ''}${formatOffsetShort(offset)}`
                }
            </span>
            <span class="post-author">${post.mine ? 'You' : post.author_name}</span>
            <div class="post-content">
                <span class="post-body">${post.body}</span>
            </div>
            ${
                meId &&
                post.mine &&
                html`<div class="post-actions">
                    <button
                        class="post-action"
                        title="Delete this note"
                        onClick=${() => onDelete(post.id)}
                    >
                        ×
                    </button>
                </div>`
            }
        </li>
    `;
}
```

- [ ] **Step 2: Remove the old renderer from `discussion.js`**

Delete the `PostList` function from `frontend/discussion.js`. Add the import beside the others:

```js
import { PostList } from './post.js';
```

Remove `authorAccent` from the `./utils.js` import (it now lives in `post.js`), leaving `seasonLabel, orderPosts, formatOffset, formatOffsetShort`.

In `EpisodeBoard`, pass `meId` through:

```js
<${PostList} placed=${placed} meId=${meId} onDelete=${onDelete} />
```

- [ ] **Step 3: Add the content-column and action-row styles**

In `frontend/styles.css`, replace the `.post-delete` rule with:

```css
/* The note's content column: quote block, body, reactions, and the picker,
   stacked. `.post` stays a baseline-aligned row of time / author / this /
   actions, so a plain note still reads as one line on a wide screen while a
   quoted or reacted-to note grows downward rather than sideways. min-width: 0
   lets a long unbroken run wrap instead of stretching the row. */
.post-content {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 0;
    flex: 1;
}

.post-actions {
    margin-left: auto;
    display: flex;
    gap: 0.15rem;
    flex-shrink: 0;
}

.post-action {
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    padding: 0 0.15rem;
    font-size: 0.9rem;
    line-height: 1;
}
```

In the `@media (max-width: 640px)` block, replace the `.post-body` rule with `.post-content`:

```css
    .post-content {
        flex-basis: 100%;
        order: 1;
    }
```

and replace the `.post-delete` rule's selector with `.post-action` (keeping its comment and its 32px sizing). In the `@media (hover: hover)` block, replace `.post-delete:hover` with `.post-action:hover`.

- [ ] **Step 4: Verify nothing changed behaviourally**

Run: `npm test && npm run build && npm run lint && npm run format:check`
Expected: PASS — this task adds no tests; the existing suite must stay green.

Then run `npm run dev`, open a season with notes, and confirm a note still renders as `time · author · body · ×` on one line at desktop width, and stacks with the body on its own line below 640px.

- [ ] **Step 5: Update CLAUDE.md**

Add `frontend/post.js` to the "Repository Structure" list, described as the note renderer (`PostList` and its children), and note that `discussion.js` keeps `SeasonView`, `EpisodeBoard`, `WatchTimer`, and `PostForm`.

- [ ] **Step 6: Commit**

```bash
git add frontend/post.js frontend/discussion.js frontend/styles.css CLAUDE.md
git commit -m "refactor(frontend): move note rendering into post.js"
```

---

### Task 6: Frontend — replies

**Files:**

- Modify: `frontend/utils.js`, `frontend/post.js`, `frontend/discussion.js`, `frontend/styles.css`
- Test: `test/frontend/utils.test.js`, `test/frontend/posts.test.js`

**Interfaces:**

- Consumes: `reply_to` on each serialized post (Task 2), `PostList` (Task 5).
- Produces:
    - `quoteSnippet(body, max = 60)` in `frontend/utils.js`.
    - `PostList` gains `onReply`.
    - `PostForm` gains `inputRef`, `replyTo`, `onCancelReply`.
    - `SeasonView`'s `addPost(episode, body, replyToId)`.

- [ ] **Step 1: Write the failing tests**

Add `quoteSnippet` to the **existing** `../../frontend/utils.js` import at the top of `test/frontend/utils.test.js` rather than adding a second import line, then append:

```js
describe('quoteSnippet', () => {
    it('leaves a short single-line body alone', () => {
        expect(quoteSnippet('short note')).toBe('short note');
    });

    it('collapses newlines and runs of whitespace to single spaces', () => {
        expect(quoteSnippet('first line\n\nsecond   line')).toBe('first line second line');
    });

    it('trims surrounding whitespace', () => {
        expect(quoteSnippet('  padded  ')).toBe('padded');
    });

    it('truncates a long body with an ellipsis', () => {
        const snippet = quoteSnippet('x'.repeat(200));
        expect(snippet).toHaveLength(61);
        expect(snippet.endsWith('…')).toBe(true);
    });

    it('does not add an ellipsis at exactly the limit', () => {
        expect(quoteSnippet('x'.repeat(60))).toBe('x'.repeat(60));
    });
});
```

Append to `test/frontend/posts.test.js` (adjust the import line if `orderPosts` is already imported there):

```js
// A reply is an ordinary note on the timeline: it sorts by its own offset, not
// next to the note it answers. This pins the not-threaded decision.
it('orders a reply by its own offset, not beside its parent', () => {
    const posts = [
        { id: 1, user_id: 'u1', offset_secs: 10, created_at: '2026-01-01T00:00:00Z' },
        { id: 2, user_id: 'u2', offset_secs: 900, created_at: '2026-01-01T00:20:00Z', reply_to_post_id: 1 },
        { id: 3, user_id: 'u1', offset_secs: 60, created_at: '2026-01-01T00:05:00Z' },
    ];
    expect(orderPosts(posts).map((p) => p.post.id)).toEqual([1, 3, 2]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/frontend/`
Expected: FAIL — `quoteSnippet` is not exported. The ordering test should already pass, which is the point: it guards behaviour rather than adding it.

- [ ] **Step 3: Add `quoteSnippet`**

Append to `frontend/utils.js`:

```js
// A note reduced to one line for the reply chip: newlines and runs of
// whitespace collapse to single spaces so a multi-line note cannot make the
// compose box grow, and anything past `max` is cut with an ellipsis.
export function quoteSnippet(body, max = 60) {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
```

- [ ] **Step 4: Render the quote block**

In `frontend/post.js`, add the component:

```js
// The quoted note above a reply. Three forms, matching what the server sends:
// nothing at all, a locked stub, or the parent's live text — live because the
// reply stores an id rather than a copy, so an edit to the parent shows through
// here. Takes the quoted author's accent, not the replier's.
function Quote({ quote }) {
    if (quote.locked) {
        return html`<div class="post-quote post-quote-locked">
            🔒 hidden until you open this episode
        </div>`;
    }
    return html`
        <div class=${'post-quote' + accentClass(quote)}>
            <span class="post-quote-author">${quote.mine ? 'You' : quote.author_name}</span>
            <span class="post-quote-body">${quote.body}</span>
        </div>
    `;
}
```

Thread `onReply` through `PostList` and `Post`, render the quote as the first child of `.post-content`, and give every note a reply button:

```js
<div class="post-content">
    ${post.reply_to && html`<${Quote} quote=${post.reply_to} />`}
    <span class="post-body">${post.body}</span>
</div>
${
    meId &&
    html`<div class="post-actions">
        <button class="post-action" title="Reply to this note" onClick=${() => onReply(post)}>
            ↰
        </button>
        ${
            post.mine &&
            html`<button
                class="post-action"
                title="Delete this note"
                onClick=${() => onDelete(post.id)}
            >
                ×
            </button>`
        }
    </div>`
}
```

Note the action row is now gated on `meId` alone rather than `meId && post.mine` — a viewer not on the roster still gets no controls at all.

- [ ] **Step 5: Add the compose chip and thread the reply id**

In `frontend/discussion.js`, change `addPost` in `SeasonView`:

```js
const addPost = (episode, body, replyToId) =>
    mutate(() =>
        api(`/api/seasons/${seasonId}/episodes/${episode}/posts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body, reply_to_post_id: replyToId }),
        }),
    );
```

In `EpisodeBoard`, add the state and handlers, and import `quoteSnippet` from `./utils.js`:

```js
// Episode-scoped, so the chip and the note it points at cannot drift apart, and
// so one board's half-written reply does not follow you to another.
const [replyTo, setReplyTo] = useState(null);
// Owned here rather than inside PostForm so tapping Reply can focus the box.
const inputRef = useRef(null);

const startReply = (post) => {
    setReplyTo({
        id: post.id,
        author_name: post.mine ? 'You' : post.author_name,
        snippet: quoteSnippet(post.body),
    });
    // Raises the keyboard on a phone with the chip already in place.
    inputRef.current?.focus();
};

const submitPost = async (body) => {
    const posted = await onPost(ep.episode, body, replyTo?.id ?? null);
    if (posted) setReplyTo(null);
    return posted;
};
```

Pass them down:

```js
<${PostList} placed=${placed} meId=${meId} onReply=${startReply} onDelete=${onDelete} />
…
${
    meId &&
    html`<${PostForm}
        inputRef=${inputRef}
        replyTo=${replyTo}
        onCancelReply=${() => setReplyTo(null)}
        onPost=${submitPost}
    />`
}
```

In `PostForm`, take the ref from props instead of creating one — replace `const inputRef = useRef(null);` with the `inputRef` parameter — and render the chip above the textarea:

```js
${
    replyTo &&
    html`<div class="reply-chip">
        <span class="reply-chip-text">↰ ${replyTo.author_name}: ${replyTo.snippet}</span>
        <button
            type="button"
            class="post-action"
            title="Cancel reply"
            onClick=${onCancelReply}
        >
            ×
        </button>
    </div>`
}
```

`.post-form` keeps its single class — the chip is a full-width flex item that wraps onto its own line, so no conditional class is needed.

- [ ] **Step 6: Style the quote block and chip**

Add to `frontend/styles.css`, after the `.post-content` rules:

```css
/* Reuses the .post-mine / .post-aN accent classes for its left border, so a
   quote carries the colour of the person being quoted rather than the person
   quoting them. */
.post-quote {
    border-left: 3px solid var(--border);
    padding-left: 0.5rem;
    color: var(--text-muted);
    font-size: 0.85rem;
}

.post-quote-author {
    display: block;
    font-weight: 600;
}

.post-quote-body {
    display: block;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.post-quote-locked {
    font-style: italic;
}

/* Sits inside .post-form, above the textarea. The snippet is already one line
   (quoteSnippet), so this only has to keep an over-long one from stretching
   the form. */
.reply-chip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    background: var(--surface-subtle);
    border-radius: 0.4rem;
    padding: 0.25rem 0.5rem;
    margin-bottom: 0.35rem;
}

.reply-chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

`.post-form` is a flex row, so rather than restructuring the markup, let the chip take a full line of its own by amending the existing `.post-form` rule and giving the chip a 100% basis:

```css
/* Added to the existing .post-form rule */
.post-form {
    flex-wrap: wrap;
}

/* Added to the .reply-chip rule above */
.reply-chip {
    flex-basis: 100%;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Verify in the app**

Run `npm run dev`. Reply to another person's note; confirm the chip appears, the textarea takes focus, the posted note shows the quote block in the quoted author's colour, and the chip clears. Confirm the reply sits in offset order, not under its parent.

- [ ] **Step 9: Update CLAUDE.md and commit**

In the "Frontend" notes, record that replies render as a quote block in timeline order rather than threaded, that `replyTo` is episode-scoped state in `EpisodeBoard`, and that the quote takes the quoted author's accent.

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/ test/frontend/ CLAUDE.md
git commit -m "feat(frontend): quote-reply to a note from its episode board"
```

---

### Task 7: Frontend — editing

**Files:**

- Modify: `frontend/hooks.js`, `frontend/post.js`, `frontend/discussion.js`, `frontend/styles.css`

**Interfaces:**

- Consumes: `PATCH /api/posts/:post_id` (Task 3), `PostList` (Tasks 5–6).
- Produces:
    - `useAutoSize(ref, value)` in `frontend/hooks.js`.
    - `PostList` gains `editingId`, `onStartEdit`, `onCancelEdit`, `onSaveEdit`.
    - `SeasonView`'s `editPost(postId, body)`.

No new automated tests: the extracted hook and the edit form are DOM behaviour, and this project has no DOM suite. The gate is the existing suite staying green plus the manual check in Step 6.

- [ ] **Step 1: Extract `useAutoSize`**

Add to `frontend/hooks.js` (moving the comments verbatim from `PostForm.fit`):

```js
// A textarea does not size itself to its content, so the height is driven from
// scrollHeight. Resetting to 'auto' first is what lets the box shrink again
// after a delete — scrollHeight never reports less than the height already set.
//
// The same text rewraps onto a different number of lines when the box gets
// narrower or wider, so the height is recomputed on a rotation or a window
// resize too, not only when the text changes. The box's width is a function of
// the viewport alone, so the window event is enough and a ResizeObserver (which
// would also have to avoid re-firing on the height changes made here) buys
// nothing.
export function useAutoSize(ref, value) {
    const fit = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        const style = getComputedStyle(el);
        // scrollHeight leaves out the border, which box-sizing: border-box
        // counts inside the height, so skipping this clips the last line.
        const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        el.style.height = `${el.scrollHeight + border}px`;
    }, [ref]);

    useEffect(fit, [value, fit]);

    useEffect(() => {
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
    }, [fit]);
}
```

In `frontend/discussion.js`, delete `PostForm`'s `fit` callback and both of its `useEffect`s, and call `useAutoSize(inputRef, body)` instead. Add `useAutoSize` to the `./hooks.js` import.

- [ ] **Step 2: Add the edit form**

In `frontend/post.js`, import `useState`, `useRef`, `useEffect` from `preact/hooks` and `useAutoSize` from `./hooks.js`, then add:

```js
// Editing happens where the note sits, so the surrounding conversation stays
// visible while you rewrite. The textarea deliberately stays enabled while
// saving, for the same reason PostForm's does: disabling a focused textarea
// blurs it, which on a phone tears down the keyboard mid-save and does not
// bring it back. `busy` gates the submit path instead.
function EditForm({ post, onSave, onCancel }) {
    const [body, setBody] = useState(post.body);
    const [busy, setBusy] = useState(false);
    const ref = useRef(null);
    useAutoSize(ref, body);

    useEffect(() => ref.current?.focus(), []);

    const save = async (e) => {
        e.preventDefault();
        const trimmed = body.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            await onSave(post.id, trimmed);
        } finally {
            setBusy(false);
        }
    };

    // Matching PostForm's keys, plus Escape to back out.
    const keyDown = (e) => {
        if (e.key === 'Escape') {
            onCancel();
            return;
        }
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        save(e);
    };

    return html`
        <form class="post-edit" onSubmit=${save}>
            <textarea
                ref=${ref}
                class="post-input"
                rows="1"
                maxlength="2000"
                value=${body}
                onInput=${(e) => setBody(e.target.value)}
                onKeyDown=${keyDown}
            ></textarea>
            <div class="post-edit-actions">
                <button type="button" class="timer-btn subtle" onClick=${onCancel}>Cancel</button>
                <button
                    class="post-submit"
                    type="submit"
                    aria-busy=${busy}
                    disabled=${busy || !body.trim()}
                >
                    ${busy ? html`<span class="spinner" aria-hidden="true"></span>Saving…` : 'Save'}
                </button>
            </div>
        </form>
    `;
}
```

In `Post`, swap the body for the form while editing, show the edited marker, and add the ✎ button beside ×:

```js
<div class="post-content">
    ${post.reply_to && html`<${Quote} quote=${post.reply_to} />`}
    ${
        editing
            ? html`<${EditForm} post=${post} onSave=${onSaveEdit} onCancel=${onCancelEdit} />`
            : html`<span class="post-body">${post.body}</span>`
    }
</div>
```

The marker goes beside the author, before `.post-content`:

```js
${
    post.edited_at &&
    html`<span class="post-edited" title=${new Date(post.edited_at).toLocaleString()}>
        · edited
    </span>`
}
```

And in the action row, before the delete button, hidden while that note is being edited:

```js
${
    post.mine &&
    !editing &&
    html`<button class="post-action" title="Edit this note" onClick=${() => onStartEdit(post.id)}>
        ✎
    </button>`
}
```

- [ ] **Step 3: Wire the mutation**

In `SeasonView`:

```js
const editPost = (postId, body) =>
    mutate(() =>
        api(`/api/posts/${postId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        }),
    );
```

Pass `onEdit=${editPost}` to `EpisodeBoard`. In `EpisodeBoard`:

```js
const [editingId, setEditingId] = useState(null);

const saveEdit = async (postId, body) => {
    const saved = await onEdit(postId, body);
    // Stay in the editor on failure: the banner explains why, and the rewritten
    // text is still in the box rather than discarded.
    if (saved) setEditingId(null);
};
```

Pass `editingId`, `onStartEdit=${setEditingId}`, `onCancelEdit=${() => setEditingId(null)}`, and `onSaveEdit=${saveEdit}` to `PostList`, which threads them to `Post` with `editing=${editingId === post.id}`.

- [ ] **Step 4: Style it**

Add to `frontend/styles.css` beside the other post rules:

```css
.post-edited {
    color: var(--text-faint);
    font-size: 0.75rem;
}

.post-edit {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.post-edit-actions {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
}
```

The `@media (max-width: 640px)` block's `.post-input` rules already cover the edit box, since it reuses that class — including the 16px minimum that keeps Safari from zooming in on focus.

- [ ] **Step 5: Run the gates**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: PASS

- [ ] **Step 6: Verify in the app**

Run `npm run dev`. Edit one of your own notes: confirm the box focuses, Enter saves, Escape cancels, Shift+Enter adds a line, the note keeps its position in the timeline, `· edited` appears afterwards, and the ✎ button is absent on other people's notes. Confirm at a phone width that the box does not zoom the page on focus.

- [ ] **Step 7: Update CLAUDE.md and commit**

Record `useAutoSize` in the `hooks.js` line of "Repository Structure", and add a Frontend note that editing is inline, keeps the note's timeline position, and shares the auto-size hook with the compose box.

```bash
git add frontend/ CLAUDE.md
git commit -m "feat(frontend): edit a note in place"
```

---

### Task 8: Frontend — reactions

**Files:**

- Modify: `frontend/post.js`, `frontend/discussion.js`, `frontend/styles.css`

**Interfaces:**

- Consumes: `REACTIONS` (Task 4), `reactions` on each post (Task 4), `PostList` (Tasks 5–7).
- Produces: `SeasonView`'s `setReaction(postId, emoji, on)`; `PostList` gains `pickerFor`, `onTogglePicker`, `onReact`.

No new automated tests, for the same reason as Task 7 — the logic that could be unit-tested (grouping, ordering, `mine`) lives on the server and is covered by Task 4.

- [ ] **Step 1: Add the bar and the picker**

In `frontend/post.js`, import the set:

```js
import { REACTIONS } from '../shared/reactions.js';
```

Add both components:

```js
// A note's existing reactions. The server sends them in set order with the
// counts and names already resolved, so this only draws them. `mine` fills the
// chip in and is what tapping it toggles.
function ReactionBar({ post, onReact }) {
    return html`
        <div class="reaction-bar">
            ${post.reactions.map(
                (r) => html`
                    <button
                        key=${r.emoji}
                        class=${'reaction-chip' + (r.mine ? ' mine' : '')}
                        aria-pressed=${r.mine}
                        title=${r.names.join(', ')}
                        onClick=${() => onReact(post.id, r.emoji, !r.mine)}
                    >
                        <span aria-hidden="true">${r.emoji}</span>${r.count}
                    </button>
                `,
            )}
        </div>
    `;
}

// Inline below the note rather than an absolutely positioned popover: nothing
// to clip inside a scrolling board, and the 44px targets fall out of the grid.
function EmojiPicker({ post, onReact }) {
    const chosen = new Set(post.reactions.filter((r) => r.mine).map((r) => r.emoji));
    return html`
        <div class="emoji-picker">
            ${REACTIONS.map(
                ({ emoji, label }) => html`
                    <button
                        key=${emoji}
                        class="emoji-btn"
                        aria-label=${label}
                        aria-pressed=${chosen.has(emoji)}
                        onClick=${() => onReact(post.id, emoji, !chosen.has(emoji))}
                    >
                        ${emoji}
                    </button>
                `,
            )}
        </div>
    `;
}
```

Render both at the end of `.post-content`:

```js
${post.reactions.length > 0 && html`<${ReactionBar} post=${post} onReact=${onReact} />`}
${pickerOpen && html`<${EmojiPicker} post=${post} onReact=${onReact} />`}
```

and add the picker button to the action row, first, before ✎ and ×:

```js
<button
    class="post-action"
    title="React to this note"
    aria-expanded=${pickerOpen}
    onClick=${() => onTogglePicker(post.id)}
>
    ☺+
</button>
```

The reply button stays first in the row; the order is `↰ ☺+ ✎ ×`.

- [ ] **Step 2: Wire the mutation**

In `SeasonView`:

```js
const setReaction = (postId, emoji, on) =>
    mutate(() =>
        api(`/api/posts/${postId}/reactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emoji, on }),
        }),
    );
```

Pass `onReact=${setReaction}` to `EpisodeBoard`. In `EpisodeBoard`:

```js
const [pickerFor, setPickerFor] = useState(null);

// Choosing an emoji closes the picker, whether it added or removed one.
const react = (postId, emoji, on) => {
    setPickerFor(null);
    return onReact(postId, emoji, on);
};
```

Pass `pickerFor`, `onTogglePicker=${(id) => setPickerFor((cur) => (cur === id ? null : id))}`, and `onReact=${react}` to `PostList`, threading `pickerOpen=${pickerFor === post.id}` to each `Post`.

- [ ] **Step 3: Style them**

Add to `frontend/styles.css` beside the other post rules:

```css
.reaction-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
}

.reaction-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: none;
    color: var(--text-subtle);
    font-size: 0.8rem;
    padding: 0.1rem 0.45rem;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
}

.reaction-chip.mine {
    border-color: var(--blue);
    color: var(--blue);
}

/* repeat(4, auto) puts the current set on one row; a fifth emoji wraps onto a
   second without any other change. */
.emoji-picker {
    display: grid;
    grid-template-columns: repeat(4, auto);
    justify-content: start;
    gap: 0.25rem;
}

.emoji-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    cursor: pointer;
    font-size: 1.1rem;
    padding: 0.15rem 0.35rem;
    line-height: 1.2;
}
```

In the `@media (max-width: 640px)` block, add 44px targets:

```css
    .emoji-btn {
        min-width: 44px;
        min-height: 44px;
    }

    .reaction-chip {
        min-height: 32px;
    }
```

In the `@media (hover: hover)` block:

```css
    .reaction-chip:hover,
    .emoji-btn:hover {
        background: var(--surface-hover);
    }
```

- [ ] **Step 4: Run the gates**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: PASS

- [ ] **Step 5: Verify in the app**

Run `npm run dev`. On another person's note: open the picker, add 👍, confirm the chip appears filled with your name in its tooltip and the picker closes; tap the chip to remove it; add two different emoji and confirm both chips show in set order. Confirm the picker's buttons are 44px at a phone width and that no `:hover` style latches after a tap on a touch device.

- [ ] **Step 6: Update CLAUDE.md and commit**

Add a Frontend note covering the reaction bar and the inline picker, that reactions are per-individual, and that the emoji set lives in `shared/reactions.js` so the Worker and the picker cannot disagree.

```bash
git add frontend/ CLAUDE.md
git commit -m "feat(frontend): react to a note with one of four emoji"
```

---

## Wrap-up

After Task 8, before opening a PR:

- [ ] Run the whole gate set once more: `npm run build && npm test && npm run lint && npm run format:check`
- [ ] Apply the migration locally and click through the feature end to end: `npx wrangler d1 migrations apply <database> --local`
- [ ] Re-read `CLAUDE.md`'s schema, API, and Frontend sections against the finished code — eight tasks each touched it, so this is where drift shows up
- [ ] Delete nothing from `docs/superpowers/specs/` — the spec stays as the record of why
