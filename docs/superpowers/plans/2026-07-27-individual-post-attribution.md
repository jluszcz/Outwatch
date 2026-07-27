# Individual Post Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute a discussion note to the individual who wrote it — the half of a shared board column identified by their Cloudflare Access email — instead of to the column.

**Architecture:** Two nullable columns carry the whole feature: `user_emails.name` (the individual's display name, filled only in the gitignored `roster.sql`) and `posts.author_email` (who wrote the note). The Worker resolves a note's author at read time and serializes `author_name`, `author_index`, and `mine` — never the email itself. The frontend stops resolving names from the board roster, which lets the season view drop its second request.

**Tech Stack:** Cloudflare Workers + Hono, D1 (SQLite), Preact + htm, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-07-27-individual-post-attribution-design.md`

## Global Constraints

- **Never commit real names or email addresses.** Committed files use fake placeholders only: generic `user-N` ids, made-up names, `@example.com` emails. The real roster lives only in `roster.sql`, which is gitignored.
- Everything outside discussion notes stays column-level: the watched checkboxes, `currently_watching_season_id`, watch timers, episode reveals, and the spoiler gate. Do not key any of them on the individual.
- Emails are never serialized to the client. `/api/board`'s `me` stays `{ id, name }`.
- Work on the existing branch `individual-post-attribution`. Do not commit to `main`.
- Before every commit run `npm run build`, `npm test`, `npm run lint`, and `npm run format:check` and confirm all four pass.
- Never use `--no-verify`. If a hook modifies files, restage and run a fresh `git commit` — never amend.
- Edit frontend sources under `frontend/`. Never edit `public/script.js`; it is build output.

---

### Task 1: Migration and roster template

Adds the two columns and updates the gitignored roster's committed template.

**Files:**

- Create: `migrations/0006_individual_authors.sql`
- Modify: `roster.example.sql`
- Test: `test/worker/migrations.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `user_emails.name` (TEXT, nullable) and `posts.author_email` (TEXT, nullable, `REFERENCES user_emails(email)`). Every later task depends on both.

- [ ] **Step 1: Write the failing test**

Append this `describe` block to the end of `test/worker/migrations.test.js`. It reads `sqlite_master` rather than `PRAGMA table_info`, matching the existing test in that file.

```js
// The two columns individual attribution rests on. Both are added by ALTER
// TABLE, which rewrites the stored CREATE statement, so sqlite_master is a
// faithful record of whether migration 0006 actually applied.
describe('individual author columns', () => {
    it('adds a per-person name and a post author', async () => {
        const { results } = await env.DB.prepare(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name IN ('posts', 'user_emails')`,
        ).all();
        const sqlFor = Object.fromEntries(results.map((r) => [r.name, r.sql]));
        expect(sqlFor.user_emails).toContain('name TEXT');
        expect(sqlFor.posts).toContain('author_email TEXT');
    });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: FAIL — `expected '...' to contain 'name TEXT'`.

- [ ] **Step 3: Write the migration**

Create `migrations/0006_individual_authors.sql`:

```sql
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
```

SQLite permits a `REFERENCES` clause on `ADD COLUMN` precisely because the default is NULL; do not add a `NOT NULL` or a non-NULL default.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: PASS.

- [ ] **Step 5: Update the roster template**

In `roster.example.sql`, replace the `user_emails` INSERT with an upsert that also carries names. The upsert matters: the real `roster.sql` has already been applied, and `INSERT OR IGNORE` would silently skip every existing row and leave every `name` NULL.

```sql
INSERT INTO user_emails (email, user_id, name) VALUES
    ('alice@example.com', 'user-1', NULL),
    ('bob@example.com',   'user-2', 'Bob'),
    ('carol@example.com', 'user-2', 'Carol'),
    ('dave@example.com',  'user-3', 'Dave'),
    ('erin@example.com',  'user-3', 'Erin')
ON CONFLICT (email) DO UPDATE SET user_id = excluded.user_id, name = excluded.name;
```

Add to the `Notes:` comment block at the top of the file:

```
--   * `name` is the individual's display name on a discussion note. Leave it
--     NULL for a one-person column — its notes fall back to the column name.
--     Set it for each half of a shared column, which is the whole point: it is
--     what turns a note bylined "Bob & Carol" into one bylined "Carol".
--   * this file upserts rather than ignores, so editing a name here and
--     re-applying updates the existing row instead of quietly doing nothing.
```

Then append the one-time backfill block to the end of the file:

```sql
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
```

- [ ] **Step 6: Run the full checks**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 7: Commit**

```bash
git add migrations/0006_individual_authors.sql roster.example.sql test/worker/migrations.test.js
git commit -m "feat(db): add a per-person name and a post author column" -m "Two nullable columns carry individual attribution: user_emails.name is the individual's byline, and posts.author_email records which login wrote a note. Both are NULL-safe so existing rows and solo columns need no backfill to keep working. The roster template upserts now, since INSERT OR IGNORE would skip the rows already applied and leave every name NULL."
```

---

### Task 2: Store the author on new notes

The write path. `callerUser()` starts carrying the verified email, and `POST .../posts` stamps it.

**Files:**

- Modify: `src/index.js:79-89` (`callerUser`), `src/index.js:271-304` (post route)
- Test: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `posts.author_email` from Task 1.
- Produces: `callerUser(c)` now resolves to `{ id, name, email }` — `email` is the verified, lowercased Access email. Tasks 3 and 4 both rely on it. The POST response body is unchanged and still contains no email.

- [ ] **Step 1: Write the failing tests**

Add to `test/worker/discussion.test.js`, inside the existing `describe('POST /api/seasons/:season_id/episodes/:episode/posts')` block. The fixture already has a `Bob & Carol` column with `bob@example.com` and `carol@example.com`.

```js
it('records which half of a shared column wrote the note', async () => {
    await req('POST', '/api/seasons/45/episodes/7/posts', {
        body: { body: 'she is cooked' },
        email: 'carol@example.com',
    });

    const row = await env.DB.prepare('SELECT user_id, author_email FROM posts').first();
    expect(row).toEqual({ user_id: 'user-bob', author_email: 'carol@example.com' });
});

it('does not echo the author email back to the client', async () => {
    const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
        body: { body: 'called it' },
        email: 'carol@example.com',
    });
    const { post } = await r.json();
    expect(post).not.toHaveProperty('author_email');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'records which half'`
Expected: FAIL — `author_email` is `null`.

- [ ] **Step 3: Carry the email through `callerUser`**

In `src/index.js`, replace the body of `callerUser` (currently lines 79-89) with:

```js
async function callerUser(c) {
    const email = await callerEmail(c);
    if (!email) return null;
    const column = await c.env.DB.prepare(
        `SELECT users.id, users.name
         FROM user_emails JOIN users ON users.id = user_emails.user_id
         WHERE user_emails.email = ?`,
    )
        .bind(email)
        .first();
    // The row identifies the column; the email identifies the person inside it.
    // A shared column has two logins, and discussion notes need to tell them
    // apart — so the email rides along rather than being dropped here. It is
    // never serialized: routes that echo the caller pick `id` and `name`
    // explicitly.
    return column && { ...column, email };
}
```

- [ ] **Step 4: Stamp the author on the insert**

In the `POST /api/seasons/:season_id/episodes/:episode/posts` route, change the insert inside `c.env.DB.batch([...])` to:

```js
c.env.DB.prepare(
    `INSERT INTO posts (season_id, episode, user_id, body, created_at, offset_secs, author_email)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, season_id, episode, user_id, body, created_at, offset_secs`,
).bind(season.id, episode, me.id, body, now, offsetSecs, me.email),
```

The `RETURNING` list deliberately omits `author_email` — the response is sent to the client.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS, whole file.

- [ ] **Step 6: Run the full checks**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 7: Commit**

```bash
git add src/index.js test/worker/discussion.test.js
git commit -m "feat(api): stamp a note with the login that wrote it" -m "callerUser resolved an email to a column and then discarded it, so both halves of a shared column posted as the household. It now carries the verified email alongside the column, and a new note records it. The email is not returned to the client: RETURNING lists its columns explicitly."
```

---

### Task 3: Serialize the individual on read

The read path. Each post gains `author_name`, `author_index`, and `mine`, and an episode's `authors` names individuals.

**Files:**

- Modify: `src/index.js:310-410` (discussion route), plus a new `rosterPeople` helper and an `attribute` helper above it
- Test: `test/worker/discussion.test.js` (including the existing locked-board test at line 171, which asserts the old `authors` shape)

**Interfaces:**

- Consumes: `callerUser(c) -> { id, name, email }` from Task 2; `posts.author_email` and `user_emails.name` from Task 1.
- Produces: the discussion response's post shape `{ id, user_id, body, created_at, offset_secs, author_name, author_index, mine }` and episode `authors: [{ name, mine }]`. Task 5 consumes both.

- [ ] **Step 1: Update the test fixture with per-person names**

In `test/worker/discussion.test.js`, replace the `user_emails` insert in `beforeEach` with one that names the shared column's two people and deliberately leaves the solo column unnamed, so the fallback is exercised by every test in the file:

```js
await env.DB.exec(
    'INSERT INTO user_emails (email, user_id, name) VALUES ' +
        "('alice@example.com', 'user-alice', NULL), " +
        "('bob@example.com', 'user-bob', 'Bob'), " +
        "('carol@example.com', 'user-bob', 'Carol')",
);
```

- [ ] **Step 2: Update the existing locked-board assertion**

`authors` stops being an array of user ids, which one existing test asserts directly. In the test named `hides other people’s bodies on a locked board but reports count and authors`, replace this line:

```js
expect(ep7.authors.sort()).toEqual(['user-alice', 'user-bob']);
```

with one that expects the new shape. `bob` wrote the first note, `alice` the third, and the list follows note order, so `Bob` comes first. `Alice` is `mine: true` — she is the caller — and her byline falls back to the column name because the fixture gives her no individual name:

```js
expect(ep7.authors).toEqual([
    { name: 'Bob', mine: false },
    { name: 'Alice', mine: true },
]);
```

- [ ] **Step 3: Write the failing tests**

Add a new `describe` block to `test/worker/discussion.test.js`, after the existing `GET /api/seasons/:season_id/discussion` block. The file already defines the `post(email, episode, body)` and `discussion(email)` helpers used here.

```js
describe('note attribution', () => {
    // The whole point of the feature: two logins, one column, two bylines.
    it('names each half of a shared column separately', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await post('carol@example.com', 7, 'she is cooked');
        // Reading requires the episode be open — alice has not watched season 45.
        await req('POST', '/api/seasons/45/episodes/7/reveal', { email: 'alice@example.com' });

        const { episodes } = await (await discussion('alice@example.com')).json();
        const names = episodes.find((e) => e.episode === 7).posts.map((p) => p.author_name);
        expect(names).toEqual(['Bob', 'Carol']);
    });

    it('gives the two people distinct accent slots', async () => {
        await post('bob@example.com', 7, 'one');
        await post('carol@example.com', 7, 'two');
        await req('POST', '/api/seasons/45/episodes/7/reveal', { email: 'alice@example.com' });

        const { episodes } = await (await discussion('alice@example.com')).json();
        const [first, second] = episodes.find((e) => e.episode === 7).posts;
        expect(first.author_index).not.toBe(second.author_index);
    });

    // Viewer-independent: a person's colour must not shift depending on who is
    // looking, which is the one thing an index computed per-request could get
    // wrong.
    it('gives a person the same slot whoever is asking', async () => {
        await post('carol@example.com', 7, 'two');
        await req('POST', '/api/seasons/45/episodes/7/reveal', { email: 'alice@example.com' });

        const seenBy = async (email) => {
            const { episodes } = await (await discussion(email)).json();
            return episodes.find((e) => e.episode === 7).posts[0].author_index;
        };
        expect(await seenBy('alice@example.com')).toBe(await seenBy('bob@example.com'));
    });

    it('falls back to the column name when the roster has no individual name', async () => {
        await post('alice@example.com', 7, 'called it');

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).posts[0].author_name).toBe('Alice');
    });

    it('marks only your own notes as yours, not your partner’s', async () => {
        await post('bob@example.com', 7, 'mine');
        await post('carol@example.com', 7, 'theirs');

        const { episodes } = await (await discussion('bob@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).posts.map((p) => p.mine)).toEqual([
            true,
            false,
        ]);
    });

    // Un-attributed notes predate the feature. They belong to the column, so
    // both partners still own them — matching what the delete route allows.
    it('treats a note with no author as the whole column’s', async () => {
        await post('bob@example.com', 7, 'from before');
        await env.DB.exec('UPDATE posts SET author_email = NULL');

        const { episodes } = await (await discussion('carol@example.com')).json();
        const [only] = episodes.find((e) => e.episode === 7).posts;
        expect(only).toMatchObject({ author_name: 'Bob & Carol', author_index: null, mine: true });
    });

    it('leaves an author who is no longer on the roster unplaceable', async () => {
        await post('carol@example.com', 7, 'goodbye');
        await env.DB.exec("UPDATE posts SET author_email = 'ghost@example.com'");

        const { episodes } = await (await discussion('bob@example.com')).json();
        const [only] = episodes.find((e) => e.episode === 7).posts;
        expect(only).toMatchObject({ author_name: 'Bob & Carol', author_index: null, mine: false });
    });

    it('names individuals in a locked episode’s author list', async () => {
        await post('carol@example.com', 7, 'she is cooked');

        const { episodes } = await (await discussion('alice@example.com')).json();
        const ep = episodes.find((e) => e.episode === 7);
        expect(ep.readable).toBe(false);
        expect(ep.authors).toEqual([{ name: 'Carol', mine: false }]);
    });

    it('lists an author once however many notes they wrote', async () => {
        await post('carol@example.com', 7, 'one');
        await post('carol@example.com', 7, 'two');

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).authors).toHaveLength(1);
    });

    // The spoiler gate stays column-level: a couple watches together, so a
    // partner's note is not a spoiler even on an episode you have not opened.
    it('still shows a partner’s notes on a locked board', async () => {
        await post('carol@example.com', 7, 'she is cooked');

        const { episodes } = await (await discussion('bob@example.com')).json();
        const ep = episodes.find((e) => e.episode === 7);
        expect(ep.readable).toBe(false);
        expect(ep.posts).toHaveLength(1);
    });

    it('never serializes an email', async () => {
        await post('carol@example.com', 7, 'she is cooked');

        const body = await (await discussion('carol@example.com')).text();
        expect(body).not.toContain('@example.com');
    });
});
```

- [ ] **Step 4: Run the tests and verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'note attribution'`
Expected: FAIL — `author_name` is `undefined`.

- [ ] **Step 5: Add the roster and attribution helpers**

In `src/index.js`, add both helpers immediately above the `GET /api/seasons/:season_id/discussion` route (after the `currentOffsetSecs` helper):

```js
// The roster seen as individuals rather than as columns: one entry per login,
// ordered so it does not depend on who is asking. That ordering is what makes
// an author's accent slot stable — a person keeps the same colour across
// reloads and across everyone's screens. `name` falls back to the column's own
// name, which is what a solo column and a not-yet-named roster entry get.
async function rosterPeople(c) {
    const { results } = await c.env.DB.prepare(
        `SELECT user_emails.email AS email, user_emails.name AS person_name,
                users.id AS user_id, users.name AS user_name
         FROM user_emails JOIN users ON users.id = user_emails.user_id
         ORDER BY users.sort_order ASC, users.name ASC, user_emails.email ASC`,
    ).all();

    const byEmail = new Map();
    const columnName = new Map();
    results.forEach((row, index) => {
        // user_emails.email is COLLATE NOCASE, so the stored spelling may differ
        // from the lowercased one written onto a post. Key on the lowered form.
        byEmail.set(row.email.toLowerCase(), { index, name: row.person_name || row.user_name });
        columnName.set(row.user_id, row.user_name);
    });
    return { byEmail, columnName };
}

// A note's author. The individual when the note carries an email the roster
// still knows, the column otherwise — which covers every note written before
// authorship was recorded and anyone since removed from the roster. `mine`
// mirrors exactly what DELETE /api/posts/:post_id permits, so the delete button
// the client draws from it is never a button the server would refuse.
function attribute(post, people, me) {
    const email = post.author_email ? post.author_email.toLowerCase() : null;
    const person = email ? people.byEmail.get(email) : null;
    return {
        author_name: person?.name ?? people.columnName.get(post.user_id) ?? 'Someone',
        author_index: person ? person.index : null,
        mine: Boolean(me) && post.user_id === me.id && (email === null || email === me.email),
    };
}
```

- [ ] **Step 6: Select the author and fetch the roster in the discussion route**

In the `GET /api/seasons/:season_id/discussion` route, add `author_email` to the posts query and `rosterPeople(c)` to the `Promise.all`. The destructuring gains a fifth binding:

```js
const [{ results: posts }, watchedRow, { results: reveals }, { results: sessions }, people] =
    await Promise.all([
        c.env.DB.prepare(
            `SELECT id, episode, user_id, body, created_at, offset_secs, author_email
             FROM posts WHERE season_id = ? ORDER BY episode ASC, id ASC`,
        )
            .bind(seasonId)
            .all(),
```

Leave the other three entries of the `Promise.all` exactly as they are, and add `rosterPeople(c),` as the last entry, after the `sessions` query.

- [ ] **Step 7: Serialize the attribution**

Inside the `for (let episode = 1; ...)` loop, replace the `authors` line with a dedupe over the author key, and spread `attribute` into each serialized post. The `visible` filter stays on `user_id` — the spoiler gate is column-level.

```js
// Authors are named even on a locked board: the main board already shows who
// has watched which season, so this reveals nothing new — and it tells you
// whether opening the board is worth it. Deduped on the author key rather than
// the display name, so two people who share a first name still list twice.
const authors = [];
const seenAuthors = new Set();
for (const p of all) {
    const key = p.author_email ? p.author_email.toLowerCase() : p.user_id;
    if (seenAuthors.has(key)) continue;
    seenAuthors.add(key);
    const { author_name, mine } = attribute(p, people, me);
    authors.push({ name: author_name, mine });
}

// The one line that matters. On a locked board only the caller's own column's
// posts survive; nobody else's body reaches the response. Column-level, not
// per-person: a couple watches together, so a partner's note is not a spoiler.
const visible = readable ? all : all.filter((p) => me && p.user_id === me.id);
```

And in the `episodes.push({...})` call, replace the `posts` mapping with:

```js
posts: visible.map((p) => ({
    id: p.id,
    user_id: p.user_id,
    body: p.body,
    created_at: p.created_at,
    offset_secs: p.offset_secs,
    ...attribute(p, people, me),
})),
```

`user_id` stays on the wire: `orderPosts` groups by it to infer offsets for an author who never ran a timer, and timers are still column-level, so that grouping remains the right one.

- [ ] **Step 8: Run the tests and verify they pass**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS, whole file.

- [ ] **Step 9: Run the full checks**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 10: Commit**

```bash
git add src/index.js test/worker/discussion.test.js
git commit -m "feat(api): serialize a note's individual author" -m "Each post now carries author_name, a viewer-independent author_index for its accent colour, and a server-computed mine flag; an episode's authors list names individuals. The author falls back to the column for a note written before authorship was recorded and for a login no longer on the roster. The spoiler gate stays column-level — a partner's note is not a spoiler."
```

---

### Task 4: Own-note delete

A note can only be deleted by the person who wrote it. Un-attributed notes stay column-deletable.

**Files:**

- Modify: `src/index.js:438-453` (delete route)
- Test: `test/worker/discussion.test.js:299-303` (an existing test asserts the opposite and must change)

**Interfaces:**

- Consumes: `callerUser(c) -> { id, name, email }` from Task 2; `posts.author_email` from Task 1.
- Produces: no new interface. The route's status codes are unchanged — 200, 400, 403, 404.

- [ ] **Step 1: Replace the outdated test and add its successor**

In `test/worker/discussion.test.js`, inside `describe('DELETE /api/posts/:post_id')`, delete the existing test named `lets either partner of a shared column delete the column’s note` — its premise is exactly what this task reverses — and add these three in its place:

```js
it('refuses to delete a note your partner wrote', async () => {
    const { post: theirs } = await (await post('bob@example.com', 7, 'ours')).json();
    const r = await req('DELETE', `/api/posts/${theirs.id}`, { email: 'carol@example.com' });
    expect(r.status).toBe(404);

    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM posts').first();
    expect(row.count).toBe(1);
});

it('lets you delete your own note from a shared column', async () => {
    const { post: mine } = await (await post('carol@example.com', 7, 'mine')).json();
    const r = await req('DELETE', `/api/posts/${mine.id}`, { email: 'carol@example.com' });
    expect(r.status).toBe(200);
});

// An un-attributed note predates individual authorship. It belongs to the
// column, so either partner may delete it rather than it being stranded.
it('lets either partner delete a note with no recorded author', async () => {
    const { post: old } = await (await post('bob@example.com', 7, 'from before')).json();
    await env.DB.exec('UPDATE posts SET author_email = NULL');

    const r = await req('DELETE', `/api/posts/${old.id}`, { email: 'carol@example.com' });
    expect(r.status).toBe(200);
});
```

- [ ] **Step 2: Run the tests and verify the first one fails**

Run: `npx vitest run test/worker/discussion.test.js -t 'refuses to delete a note your partner wrote'`
Expected: FAIL — got 200, expected 404.

- [ ] **Step 3: Narrow the delete**

In `src/index.js`, replace the delete statement and the comment above the route with:

```js
// Season-agnostic: a post id alone identifies the row, so this doesn't go
// through resolveEpisode. Ownership is the individual, not the column — your
// partner's note is not yours to delete — except for a note with no recorded
// author, which predates individual attribution and so belongs to the column.
// Deleting a note you do not own and deleting one that never existed return the
// same 404: a distinct "forbidden" would turn this route into an oracle for
// which post ids are real.
app.delete('/api/posts/:post_id', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const postId = Number(c.req.param('post_id'));
    if (!Number.isInteger(postId) || postId <= 0) {
        return c.json({ error: 'post_id must be a positive integer' }, 400);
    }

    const { meta } = await c.env.DB.prepare(
        `DELETE FROM posts
         WHERE id = ? AND user_id = ? AND (author_email = ? OR author_email IS NULL)`,
    )
        .bind(postId, me.id, me.email)
        .run();
    if (meta.changes === 0) return c.json({ error: 'Unknown post' }, 404);

    return c.json({ success: true, post_id: postId });
});
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS, whole file.

- [ ] **Step 5: Run the full checks**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.js test/worker/discussion.test.js
git commit -m "feat(api): scope note deletion to the person who wrote it" -m "Deletion was column-scoped, so either half of a shared column could remove the other's notes. It now matches on the author's login as well. A note with no recorded author predates attribution and stays deletable by the column rather than being stranded. Not-yours and does-not-exist still return the same 404."
```

---

### Task 5: Render the individual

The frontend stops resolving names from the board roster, which removes the season view's second request.

**Files:**

- Modify: `frontend/utils.js:21-37` (`authorAccent`), `frontend/discussion.js` (`SeasonView`, `EpisodeBoard`, `PostList`)
- Test: `test/frontend/utils.test.js:94-121`

**Interfaces:**

- Consumes: the post shape `{ mine, author_index, author_name }` and `authors: [{ name, mine }]` from Task 3.
- Produces: `authorAccent(post) -> 'mine' | 1..5 | null`. One argument, not three.

- [ ] **Step 1: Rewrite the failing tests**

In `test/frontend/utils.test.js`, replace the whole `describe('authorAccent')` block with:

```js
describe('authorAccent', () => {
    it("marks the caller's own notes", () => {
        expect(authorAccent({ mine: true, author_index: 2 })).toBe('mine');
    });

    it('keys everyone else off the slot the server assigned', () => {
        expect(authorAccent({ mine: false, author_index: 0 })).toBe(1);
        expect(authorAccent({ mine: false, author_index: 2 })).toBe(3);
    });

    it('gives each half of a shared column its own slot', () => {
        expect(authorAccent({ mine: false, author_index: 1 })).not.toBe(
            authorAccent({ mine: false, author_index: 2 }),
        );
    });

    it('wraps around once the roster outgrows the palette', () => {
        expect(authorAccent({ mine: false, author_index: 5 })).toBe(1);
    });

    it('returns null for an author the server could not place', () => {
        expect(authorAccent({ mine: false, author_index: null })).toBe(null);
    });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/frontend/utils.test.js -t authorAccent`
Expected: FAIL — `authorAccent` reads a userId and a roster, so it returns `null`.

- [ ] **Step 3: Rewrite `authorAccent`**

In `frontend/utils.js`, replace `authorAccent` and its comment with:

```js
// Which accent a note's left stripe should use. 'mine' for the caller's own
// notes, which take the same blue their board column already uses; otherwise a
// 1-based slot from the author's position in the roster of individuals. The
// server assigns that position in an order that does not depend on the viewer,
// so a person keeps the same colour across reloads and across everyone's
// screens — only "yours" changes depending on who is looking. null when the
// server could not place the author, which leaves the note unstriped rather
// than inventing a colour for them.
export function authorAccent(post) {
    if (post.mine) return 'mine';
    if (post.author_index == null) return null;
    return (post.author_index % ACCENT_SLOTS) + 1;
}
```

Leave the `ACCENT_SLOTS` constant and its comment above it unchanged.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/frontend/utils.test.js`
Expected: PASS, whole file.

- [ ] **Step 5: Drop the season view's second request**

In `frontend/discussion.js`, replace `fetchDiscussion` (and the comment above it) with:

```js
    // One request: the discussion response names each note's author itself, so
    // there is no roster to fetch and merge here.
    const fetchDiscussion = useCallback(
        () => api(`/api/seasons/${seasonId}/discussion`),
        [seasonId],
    );
```

Remove the now-unused `nameOf` and `accentOf` definitions further down (the two lines starting `const nameOf =` and `const accentOf =`). Leave the `./utils.js` import list alone: `authorAccent` is still imported, and `PostList` takes it over in the next step.

In the `EpisodeBoard` element inside `SeasonView`'s returned template, delete the `nameOf=${nameOf}` and `accentOf=${accentOf}` props. Keep every other prop as it is.

In the `mutate` callback's comment, the sentence `fetchDiscussion() re-merges \`users\`, so no separate preservation of \`prev.users\` is needed here.` is now false — replace that sentence with `fetchDiscussion() returns the whole view, so there is nothing to preserve across a refresh.`

- [ ] **Step 6: Render the author from the post**

In `frontend/discussion.js`, change `EpisodeBoard`'s signature to drop `nameOf` and `accentOf`:

```js
function EpisodeBoard({ ep, meId, serverSkewMs, onReveal, onPost, onDelete, onTimer }) {
```

Replace its `others` line with one that reads the new author shape:

```js
    const others = ep.authors.filter((a) => !a.mine).map((a) => a.name);
```

Delete the `nameOf=${nameOf}` and `accentOf=${accentOf}` props from the `PostList` element inside `EpisodeBoard`, and change `PostList` itself to:

```js
function PostList({ placed, onDelete }) {
    if (placed.length === 0) return html`<div class="no-posts">Nothing here yet.</div>`;
    return html`
        <ol class="posts">
            ${placed.map(({ post, offset, inferred, tail }) => {
                // 'mine' | 1..N | null — null leaves the note unstriped rather
                // than inventing a colour for an author who left the roster.
                const accent = authorAccent(post);
                const accentClass =
                    accent === 'mine' ? ' post-mine' : accent ? ` post-a${accent}` : '';
                return html`
                    <li key=${post.id} class=${'post' + accentClass}>
                        <span class="post-time" title=${new Date(post.created_at).toLocaleString()}>
                            ${
                                tail
                                    ? new Date(post.created_at).toLocaleDateString()
                                    : `${inferred ? '~' : ''}${formatOffsetShort(offset)}`
                            }
                        </span>
                        <span class="post-author">${post.mine ? 'You' : post.author_name}</span>
                        <span class="post-body">${post.body}</span>
                        ${
                            post.mine &&
                            html`<button
                                class="post-delete"
                                title="Delete this note"
                                onClick=${() => onDelete(post.id)}
                            >
                                ×
                            </button>`
                        }
                    </li>
                `;
            })}
        </ol>
    `;
}
```

`meId` stays a prop of `EpisodeBoard` — the watch timer and the post form are still gated on whether the caller is on the roster at all.

- [ ] **Step 7: Verify the bundle and the suite**

Run: `npm run build && npm test`
Expected: both pass. The build failing here almost certainly means a stale reference to `nameOf` or `accentOf` survived.

- [ ] **Step 8: Run the remaining checks**

Run: `npm run lint && npm run format:check`
Expected: both pass. ESLint will flag any leftover unused binding.

- [ ] **Step 9: Commit**

```bash
git add frontend/utils.js frontend/discussion.js test/frontend/utils.test.js
git commit -m "feat(ui): byline and stripe a note by its individual author" -m "A note now shows the person who wrote it, gets its own accent stripe, and offers its delete button only to its author — all read off the fields the server supplies rather than matched against the board roster. That was the only reason the season view fetched /api/board alongside the discussion, so it is now a single request and nameOf/accentOf are gone."
```

---

### Task 6: Documentation

`README.md` and `CLAUDE.md` both describe the identity model, the schema, and the API. Both are now wrong in several places.

**Files:**

- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**

- Consumes: everything from Tasks 1-5.
- Produces: nothing.

- [ ] **Step 1: Update `README.md`**

Read the file first and make these edits in place:

- The features list (around line 14-15) currently says couples share a column and either partner's login can toggle it. Add a line: `- Discussion notes are bylined to the individual who wrote them, so a shared column speaks with two voices`.
- The roster section (around line 99-106) describes `users` and `user_emails`. Note that `user_emails.name` is the individual's byline, that it is optional and falls back to the column name, and that `roster.example.sql` upserts so re-applying updates a changed name.
- The `user_emails` schema table (around line 189-194) needs a `name` row: `| \`name\` | TEXT | Display name on a discussion note; NULL falls back to the column name |`.
- The `posts` schema table needs an `author_email` row: `| \`author_email\` | TEXT | References \`user_emails.email\`; who wrote the note. NULL on notes predating individual attribution |`.
- The API section's description of `GET /api/seasons/:season_id/discussion` must list the new per-post fields (`author_name`, `author_index`, `mine`) and the new `authors` shape, and state that emails are still never serialized.
- The API section's description of `DELETE /api/posts/:post_id` must say deletion is scoped to the individual author, with a note that an un-attributed note stays deletable by the column.
- Wherever the identity model is described (around line 259), record that the column is the unit for everything except discussion note authorship.

- [ ] **Step 2: Update `CLAUDE.md`**

- The `migrations/` file list gains: `- \`0006_individual_authors.sql\` — adds \`user_emails.name\` and \`posts.author_email\``.
- The "Authentication & identity" section says all mutations attribute to the caller's own `users.id`. Extend it: the verified email is also carried on `callerUser()` and recorded on a note, so a shared column's two logins are distinguishable in discussions — and note that this is the only place the individual matters.
- The "Database Schema" section's `user_emails` and `posts` entries need the new columns described.
- The "API Routes" section needs the discussion response's new post fields, the new `authors` shape, and the narrowed delete rule.
- The "Frontend" section says `SeasonView` fetches `/api/board` alongside the discussion to resolve names — it no longer does. Replace that with: the discussion response names its own authors, so the season view is a single request, and `authorAccent` reads the post's `mine`/`author_index` instead of searching the roster.
- The `frontend/utils.js` file description lists its exports; it still exports `authorAccent`, but note the signature is now a post, not a `(userId, meId, users)` triple, if that list is specific enough to be wrong otherwise.

- [ ] **Step 3: Run the full checks**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: record individual note attribution" -m "The identity model, both schema tables, the discussion and delete routes, and the season view's request count all changed. Both docs described the old behaviour."
```

---

### Task 7: Apply the roster and verify by hand

The real names and the backfill live only in the gitignored `roster.sql`, so this task changes no tracked file. It is the one that makes the feature visible.

**Files:**

- Modify: `roster.sql` (gitignored — never stage it)

**Interfaces:**

- Consumes: the schema from Task 1 and the running app from Tasks 2-5.
- Produces: nothing.

- [ ] **Step 1: Update the real roster**

Mirror the changes made to `roster.example.sql` in Task 1 into `roster.sql`, with real names and emails: switch the `user_emails` insert to the `ON CONFLICT (email) DO UPDATE` form with a `name` per email, and append the backfill `UPDATE posts ...` block with one statement per column. Confirm `git status` still shows `roster.sql` as untracked/ignored before going further.

- [ ] **Step 2: Apply migrations and the roster locally**

```bash
npx wrangler d1 migrations apply outwatch --local
npx wrangler d1 execute outwatch --local --file=roster.sql
```

- [ ] **Step 3: Check it by hand**

Run `npm run dev`, open a season's discussion with `.dev.vars`' `DEV_USER_EMAIL` set to one half of a shared column, and confirm: your own notes read "You" and keep the blue stripe; your partner's notes carry their name and a different stripe; the delete `×` appears only on your own; and a locked episode's summary names the individual. Then switch `DEV_USER_EMAIL` to the partner and confirm the two views are mirror images — the same person keeps the same stripe colour from both sides.

- [ ] **Step 4: Deploy and apply remotely**

Only after the branch is merged:

```bash
npx wrangler d1 migrations apply outwatch --remote
npx wrangler d1 execute outwatch --remote --file=roster.sql
npm run deploy
```

Apply the migration before deploying: the new Worker writes `posts.author_email` on every note and would fail against the old schema.

---

## Notes for the implementer

- `orderPosts` is untouched. It groups by `user_id` to infer offsets for an author who never ran a timer, and timers stay column-level, so that grouping is still correct. Do not switch it to the author.
- The locked-board `visible` filter also stays on `user_id`. A partner's note is not a spoiler, because the couple watches together.
- `test/frontend/posts.test.js` covers `orderPosts` and should need no changes. If it breaks, something in Task 5 went further than intended.
