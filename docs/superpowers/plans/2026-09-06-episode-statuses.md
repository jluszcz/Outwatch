# Episode Statuses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person mark an episode as one they are deliberately skipping, with a reason of `recap` or `reunion`, and show that to everyone else on the season's discussion page.

**Architecture:** A new `episode_statuses` table keyed on `(user_id, season_id, episode)` — the same per-column, per-episode shape `reveals` and `watch_offsets` already use. One new write route, `PUT /api/seasons/:season_id/episodes/:episode/status`, taking an absolute value rather than toggling. `GET /api/seasons/:season_id/discussion` grows a `statuses` array per episode, outside the spoiler gate because a status is not content. The frontend shows it as a text chip in the collapsed episode header and sets it from a small menu in the `.episode-actions` row.

**Tech Stack:** Cloudflare Workers, Hono, `@hono/zod-validator` + zod, D1 (SQLite), Preact + htm, lucide-preact, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-09-06-episode-statuses-design.md`

## Global Constraints

- **Never commit real names or emails.** Use only the standard placeholder cast: `Alice` (solo column), `Bob & Carol` and `Dave & Erin` (shared columns), emails `alice@example.com` etc. The worker test suite's `beforeEach` already seeds `user-alice` / `Alice` and `user-bob` / `Bob & Carol`.
- **Before every commit run all four checks and confirm they pass:** `npm run build`, `npm test`, `npm run lint`, `npm run format:check`. A commit that fails any of them must not be made. Run `npm run format` to fix formatting.
- **Never bypass the pre-commit hooks** with `--no-verify`.
- **Never commit to `main`.** All work happens on the `episode-statuses` branch, which already exists and already carries the spec commits.
- Edit files under `frontend/`, never `public/script.js` — that is build output and is gitignored.
- Documentation describes the code as it is. No "changed to…", "previously…", "kept for backwards compatibility".
- The only legal `status` value is `'skipping'`. The only legal `reason` values are `'recap'` and `'reunion'`.
- Root `CLAUDE.md`'s **API Routes** section is the API's only reference — a route change is not done until that section describes it.

---

### Task 1: The `episode_statuses` table

**Files:**
- Create: `migrations/0011_episode_statuses.sql`
- Modify: `test/worker/migrations.test.js` (append a new `describe` at the end)
- Modify: `test/worker/discussion.test.js:31-40` (the `beforeEach` cleanup block)
- Modify: `CLAUDE.md` (the Database Schema bullet list)

**Interfaces:**
- Consumes: nothing.
- Produces: the table `episode_statuses (user_id TEXT, season_id INTEGER, episode INTEGER, status TEXT, reason TEXT, created_at TEXT)` with primary key `(user_id, season_id, episode)` and index `idx_episode_statuses_season`. Tasks 2 and 3 read and write it.

Migrations are applied automatically in tests by `test/apply-migrations.js`, which `vitest.config.mjs` wires in — there is no manual step.

- [ ] **Step 1: Write the failing test**

Append to `test/worker/migrations.test.js`:

```js
// A skip is a per-column, per-episode row, the same shape reveals and
// watch_offsets take. The index is what the discussion read leans on: it loads
// every user's statuses for one season, filtering on the primary key's second
// column, which the implicit PK index cannot serve.
describe('episode statuses', () => {
    it('creates the table with a status and a reason', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episode_statuses'",
        ).first();
        expect(row).not.toBeNull();
        expect(row.sql).toContain('status');
        expect(row.sql).toContain('reason');
    });

    it('indexes the table by season', async () => {
        const row = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_episode_statuses_season'",
        ).first();
        expect(row).not.toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: FAIL — both new tests get `null` back from `sqlite_master`, so `expect(row).not.toBeNull()` fails.

- [ ] **Step 3: Write the migration**

Create `migrations/0011_episode_statuses.sql`:

```sql
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
```

- [ ] **Step 4: Add the table to the worker suite's cleanup**

In `test/worker/discussion.test.js`, the `beforeEach` deletes children before parents. Add the new table's line immediately after `stubJwksEndpoint()` and before `DELETE FROM reactions`:

```js
    await env.DB.exec('DELETE FROM episode_statuses');
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/worker/`
Expected: PASS, including the two new migration tests.

- [ ] **Step 6: Document the table**

In `CLAUDE.md`, under **Database Schema**, add this bullet after the `reactions` bullet (the last one in the list):

```markdown
- `episode_statuses` — `(user_id, season_id, episode)` PK, `status`, `reason`, `created_at` (added in `0011`); what a column intends for one episode, as opposed to what it has already done. `status` has one legal value today, `'skipping'`, and `reason` is required alongside it (`'recap'` or `'reunion'`); the route validates the *pair* rather than the two fields independently, since a future second status would take no reason. Absence of a row is the only representation of "no status". Keyed on the column, like everything else about watching. `created_at` is when the skip was first declared and survives a change of reason
```

- [ ] **Step 7: Run the full check suite**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 8: Commit**

```bash
git add migrations/0011_episode_statuses.sql test/worker/migrations.test.js test/worker/discussion.test.js CLAUDE.md
git commit -m "feat(db): add episode_statuses table

A board column can now record what it intends for an episode, not only what
it has already watched or said. Keyed on the column like every other
watching-shaped row; status and reason are validated as a pair by the route,
which is why status is a column rather than row presence."
```

---

### Task 2: `PUT /api/seasons/:season_id/episodes/:episode/status`

**Files:**
- Modify: `src/index.js` — add a zod schema beside `offsetAdjust` (around line 57), and the route immediately before `app.all('/api/*', …)` (around line 1201)
- Test: `test/worker/discussion.test.js` (append a new `describe` at the end)
- Modify: `CLAUDE.md` (the API Routes bullet list)

**Interfaces:**
- Consumes: `episode_statuses` from Task 1; the existing `callerAndEpisode(c)` helper, which returns `[me, resolved]` where `me` is `{ id, name, email }` or `null` and `resolved` is either `{ error, status }` or `{ season, episode }`; the existing `onInvalid` zod error formatter.
- Produces: the route. Task 5's `setStatus` calls it with body `{ status, reason }`. Response body on success: `{ success: true, season_id, episode, status, reason }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/discussion.test.js`:

```js
describe('PUT /api/seasons/:season_id/episodes/:episode/status', () => {
    const setStatus = (body, email = 'alice@example.com') =>
        req('PUT', '/api/seasons/45/episodes/8/status', { body, email });

    const storedFor = (userId) =>
        env.DB.prepare(
            'SELECT status, reason, created_at FROM episode_statuses WHERE user_id = ? AND season_id = 45 AND episode = 8',
        )
            .bind(userId)
            .first();

    it('records a skip with its reason', async () => {
        const r = await setStatus({ status: 'skipping', reason: 'recap' });
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({
            success: true,
            season_id: 45,
            episode: 8,
            status: 'skipping',
            reason: 'recap',
        });
        expect(await storedFor('user-alice')).toMatchObject({
            status: 'skipping',
            reason: 'recap',
        });
    });

    it('is idempotent', async () => {
        await setStatus({ status: 'skipping', reason: 'recap' });
        const r = await setStatus({ status: 'skipping', reason: 'recap' });
        expect(r.status).toBe(200);
        const { results } = await env.DB.prepare(
            'SELECT user_id FROM episode_statuses WHERE season_id = 45 AND episode = 8',
        ).all();
        expect(results).toHaveLength(1);
    });

    // The whole point of taking an absolute value: changing your mind about why
    // is one request, not an unskip followed by a re-skip.
    it('changes the reason in place, keeping created_at', async () => {
        await setStatus({ status: 'skipping', reason: 'recap' });
        const before = await storedFor('user-alice');
        await setStatus({ status: 'skipping', reason: 'reunion' });
        const after = await storedFor('user-alice');
        expect(after.reason).toBe('reunion');
        expect(after.created_at).toBe(before.created_at);
    });

    it('clears the status with a null status', async () => {
        await setStatus({ status: 'skipping', reason: 'recap' });
        const r = await setStatus({ status: null });
        expect(r.status).toBe(200);
        expect(await storedFor('user-alice')).toBeNull();
    });

    it('is idempotent when clearing a status that is not there', async () => {
        const r = await setStatus({ status: null });
        expect(r.status).toBe(200);
        expect(await storedFor('user-alice')).toBeNull();
    });

    it('rejects an unrecognised status', async () => {
        const r = await setStatus({ status: 'watched', reason: 'recap' });
        expect(r.status).toBe(400);
    });

    it('rejects an unrecognised reason', async () => {
        const r = await setStatus({ status: 'skipping', reason: 'boring' });
        expect(r.status).toBe(400);
    });

    it('rejects a skip with no reason', async () => {
        const r = await setStatus({ status: 'skipping' });
        expect(r.status).toBe(400);
    });

    it('rejects a reason with no status', async () => {
        const r = await setStatus({ status: null, reason: 'recap' });
        expect(r.status).toBe(400);
    });

    it('rejects a caller who is not on the roster', async () => {
        const r = await setStatus(
            { status: 'skipping', reason: 'recap' },
            'stranger@example.com',
        );
        expect(r.status).toBe(403);
    });

    // Caller before episode, so a stranger cannot map the seasons.
    it('rejects a stranger before it checks the episode', async () => {
        const r = await req('PUT', '/api/seasons/45/episodes/99/status', {
            body: { status: 'skipping', reason: 'recap' },
            email: 'stranger@example.com',
        });
        expect(r.status).toBe(403);
    });

    it('404s an episode the season does not have', async () => {
        const r = await req('PUT', '/api/seasons/45/episodes/99/status', {
            body: { status: 'skipping', reason: 'recap' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('404s a season that does not exist', async () => {
        const r = await req('PUT', '/api/seasons/999/episodes/1/status', {
            body: { status: 'skipping', reason: 'recap' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    // Neither gate applies: you decide to skip an episode before watching it.
    it('needs neither a reveal nor a live timer session', async () => {
        const r = await setStatus({ status: 'skipping', reason: 'recap' });
        expect(r.status).toBe(200);
    });

    // A shared column is one skip, not two: both logins write the same row.
    it('treats a shared column as one skipper', async () => {
        await setStatus({ status: 'skipping', reason: 'recap' }, 'bob@example.com');
        await setStatus({ status: 'skipping', reason: 'reunion' }, 'carol@example.com');
        const { results } = await env.DB.prepare(
            'SELECT user_id, reason FROM episode_statuses WHERE season_id = 45 AND episode = 8',
        ).all();
        expect(results).toEqual([{ user_id: 'user-bob', reason: 'reunion' }]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'episodes/:episode/status'`
Expected: FAIL — the route does not exist, so every case gets the `app.all('/api/*')` 404 with `{ error: 'Unknown API endpoint' }`.

- [ ] **Step 3: Add the zod schema**

In `src/index.js`, immediately after the `offsetAdjust` schema (it ends around line 65, just before the first `app.` call), add:

```js
// Validated as a pair rather than as two independent fields: a reason belongs to
// a skip, so `status: null` must come without one and `status: 'skipping'` must
// come with one. A future second status would take no reason at all, which is
// what the `status` column is for.
const episodeStatus = z
    .object({
        status: z
            .enum(['skipping'], { message: 'status must be "skipping" or null' })
            .nullable(),
        reason: z
            .enum(['recap', 'reunion'], { message: 'reason must be "recap" or "reunion"' })
            .nullish(),
    })
    .refine((data) => (data.status === null) === (data.reason == null), {
        message: 'a skipping status needs a reason, and a reason needs a skipping status',
        path: ['reason'],
    });
```

- [ ] **Step 4: Add the route**

In `src/index.js`, immediately before `app.all('/api/*', …)` (around line 1202), add:

```js
// What the caller intends for one episode, as opposed to what they have already
// watched or said. One status today — skipping — and it carries a required
// reason, so the other people watching read a silent episode as deliberate
// rather than as nobody having got there yet.
//
// Absolute rather than a toggle, the same reason PUT .../reactions takes an
// explicit `on`: a retried or duplicated request lands on the same state instead
// of flipping back out of it. It is also what lets the reason change in place —
// recap to reunion is one request, not an unskip followed by a re-skip.
//
// Requires a real episode and roster membership, but deliberately neither a
// reveal nor a live session: deciding to skip an episode is something you do
// before watching it, so gating on either would be backwards.
app.put(
    '/api/seasons/:season_id/episodes/:episode/status',
    zValidator('json', episodeStatus, onInvalid),
    async (c) => {
        const [me, resolved] = await callerAndEpisode(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { status, reason = null } = c.req.valid('json');
        const key = [me.id, season.id, episode];

        if (status === null) {
            // "No status" gets one representation rather than two.
            await c.env.DB.prepare(
                'DELETE FROM episode_statuses WHERE user_id = ? AND season_id = ? AND episode = ?',
            )
                .bind(...key)
                .run();
        } else {
            // created_at is deliberately not in the DO UPDATE list: it records
            // when the skip was declared, and changing your mind about why is
            // not a new declaration.
            await c.env.DB.prepare(
                `INSERT INTO episode_statuses
                     (user_id, season_id, episode, status, reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (user_id, season_id, episode) DO UPDATE SET
                     status = excluded.status,
                     reason = excluded.reason`,
            )
                .bind(...key, status, reason, new Date().toISOString())
                .run();
        }

        return c.json({ success: true, season_id: season.id, episode, status, reason });
    },
);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/worker/`
Expected: PASS, all cases in the new `describe` included.

- [ ] **Step 6: Document the route**

In `CLAUDE.md`, under **API Routes**, add this bullet immediately after the `PUT /api/seasons/:season_id/episodes/:episode/offset` bullet and before the "**Known limit, accepted rather than solved:**" paragraph:

```markdown
- `PUT /api/seasons/:season_id/episodes/:episode/status` — `{ status, reason }`; sets what the caller intends for one episode, as opposed to what they have already watched or said. Either `status: null` (deletes the row, and `reason` must be absent) or `status: "skipping"` with `reason` one of `"recap"` / `"reunion"`. The two are validated as a pair rather than independently — an unrecognised value, a skip with no reason, and a reason with no skip are all 400s — because a reason belongs to a skip, and a future second status would take none. Absolute rather than a toggle, the same reason the reactions route takes an explicit `on`: a retried request lands on the same state instead of flipping back, and changing `recap` to `reunion` is one request rather than an unskip followed by a re-skip. `created_at` records when the skip was first declared and is left alone when only the reason changes. Requires a real episode and roster membership, but deliberately neither a reveal nor a live session — deciding to skip an episode happens before watching it, so gating on either would be backwards. Keyed on the column, so both halves of a shared column write the same row
```

- [ ] **Step 7: Run the full check suite**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 8: Commit**

```bash
git add src/index.js test/worker/discussion.test.js CLAUDE.md
git commit -m "feat(api): set an episode status

PUT .../status takes an absolute { status, reason } rather than toggling, so a
retry lands on the same state and a change of reason is one request. The pair
is validated together: a reason belongs to a skip."
```

---

### Task 3: `statuses` on the discussion payload

**Files:**
- Modify: `src/index.js:551-603` (the `Promise.all` in `GET /api/seasons/:season_id/discussion`), `:605-628` (the grouping just below it), and `:663-689` (the `episodes.push` object)
- Test: `test/worker/discussion.test.js` (append a new `describe` at the end)
- Modify: `CLAUDE.md` (the `GET /api/seasons/:season_id/discussion` bullet)

**Interfaces:**
- Consumes: `episode_statuses` from Task 1; the existing `rosterPeople(c)` helper, which returns `{ byEmail, columnName }` where `columnName` is a `Map` from `users.id` to the column's display name, built in `users.sort_order` order.
- Produces: `episodes[].statuses`, an array of `{ user_id, name, status, reason }` in roster order. Tasks 4 and 5 consume it.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/discussion.test.js`:

```js
describe('GET /api/seasons/:season_id/discussion — statuses', () => {
    const setStatus = (episode, body, email) =>
        req('PUT', `/api/seasons/45/episodes/${episode}/status`, { body, email });

    const episodeOf = async (data, episode) =>
        data.episodes.find((e) => e.episode === episode);

    it('is an empty array when nobody has a status', async () => {
        const data = await (
            await req('GET', '/api/seasons/45/discussion', { email: 'alice@example.com' })
        ).json();
        expect((await episodeOf(data, 8)).statuses).toEqual([]);
    });

    it('carries everyone the caller can see, in roster order', async () => {
        await setStatus(8, { status: 'skipping', reason: 'reunion' }, 'bob@example.com');
        await setStatus(8, { status: 'skipping', reason: 'recap' }, 'alice@example.com');

        const data = await (
            await req('GET', '/api/seasons/45/discussion', { email: 'alice@example.com' })
        ).json();
        expect((await episodeOf(data, 8)).statuses).toEqual([
            { user_id: 'user-alice', name: 'Alice', status: 'skipping', reason: 'recap' },
            { user_id: 'user-bob', name: 'Bob & Carol', status: 'skipping', reason: 'reunion' },
        ]);
    });

    it('scopes statuses to their own episode', async () => {
        await setStatus(8, { status: 'skipping', reason: 'recap' }, 'alice@example.com');
        const data = await (
            await req('GET', '/api/seasons/45/discussion', { email: 'alice@example.com' })
        ).json();
        expect((await episodeOf(data, 8)).statuses).toHaveLength(1);
        expect((await episodeOf(data, 9)).statuses).toEqual([]);
    });

    it('scopes statuses to their own season', async () => {
        await setStatus(8, { status: 'skipping', reason: 'recap' }, 'alice@example.com');
        const data = await (
            await req('GET', '/api/seasons/46/discussion', { email: 'alice@example.com' })
        ).json();
        expect((await episodeOf(data, 8)).statuses).toEqual([]);
    });

    // A status is not content. It shows on a locked board for the same reason
    // the authors list does: knowing someone is skipping an episode says
    // nothing about what happens in it.
    it('shows other people’s statuses on a locked board', async () => {
        await setStatus(8, { status: 'skipping', reason: 'recap' }, 'bob@example.com');
        const data = await (
            await req('GET', '/api/seasons/45/discussion', { email: 'alice@example.com' })
        ).json();
        const ep = await episodeOf(data, 8);
        expect(ep.readable).toBe(false);
        expect(ep.statuses).toEqual([
            { user_id: 'user-bob', name: 'Bob & Carol', status: 'skipping', reason: 'recap' },
        ]);
    });

    it('never serializes an email', async () => {
        await setStatus(8, { status: 'skipping', reason: 'recap' }, 'bob@example.com');
        const body = await (
            await req('GET', '/api/seasons/45/discussion', { email: 'alice@example.com' })
        ).text();
        expect(body).not.toContain('bob@example.com');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'discussion — statuses'`
Expected: FAIL — `statuses` is `undefined` on every episode, so `toEqual([])` fails.

- [ ] **Step 3: Load the statuses**

In `src/index.js`, in the `GET /api/seasons/:season_id/discussion` handler:

Add `{ results: statusRows },` to the destructured array, after `{ results: offsets },`:

```js
    const [
        { results: posts },
        watchedRow,
        { results: reveals },
        { results: sessions },
        people,
        { results: reactionRows },
        { results: offsets },
        { results: statusRows },
    ] = await Promise.all([
```

Add the matching query as the last element of the `Promise.all` array, after the `watch_offsets` query and before the closing `]);`:

```js
        // Everyone's, not just the caller's: a status is not content, so it is
        // not behind the spoiler gate. One query for the season, grouped below.
        c.env.DB.prepare(
            'SELECT user_id, episode, status, reason FROM episode_statuses WHERE season_id = ?',
        )
            .bind(seasonId)
            .all(),
```

- [ ] **Step 4: Group them in roster order**

In the same handler, immediately after the `reactionsByPost` loop (which ends with `reactionsByPost.get(r.post_id).push(r);` and its closing brace) and before `const episodes = [];`, add:

```js
    const statusesByEpisode = new Map();
    for (const s of statusRows) {
        if (!statusesByEpisode.has(s.episode)) statusesByEpisode.set(s.episode, []);
        statusesByEpisode.get(s.episode).push(s);
    }

    // Roster order, so the chip lists people the same way on everyone's screen —
    // rosterPeople builds columnName in users.sort_order. A row whose column has
    // since left the roster drops out rather than rendering nameless, matching
    // how attribute() handles an author the roster no longer knows.
    const rosterOrder = [...people.columnName.keys()];
    const statusesFor = (episode) => {
        const rows = statusesByEpisode.get(episode) ?? [];
        return rosterOrder
            .map((userId) => rows.find((r) => r.user_id === userId))
            .filter(Boolean)
            .map((r) => ({
                user_id: r.user_id,
                name: people.columnName.get(r.user_id),
                status: r.status,
                reason: r.reason,
            }));
    };
```

- [ ] **Step 5: Put them on the payload**

In the same handler's `episodes.push({ … })`, add the field immediately after `authors,`:

```js
            statuses: statusesFor(episode),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/worker/`
Expected: PASS.

- [ ] **Step 7: Document the field**

In `CLAUDE.md`, in the `GET /api/seasons/:season_id/discussion` bullet, change the opening clause listing what each episode carries so that it names `statuses`. The clause currently reads:

```
each episode carries `episode`, `readable`, `count`, `authors` (now `[{ name, mine }]`, one per distinct individual rather than per user id), gated `posts`, the caller's timer `session`, and the caller's own `adjust_secs`
```

Make it read:

```
each episode carries `episode`, `readable`, `count`, `authors` (now `[{ name, mine }]`, one per distinct individual rather than per user id), `statuses` (`[{ user_id, name, status, reason }]`, everyone's stated intention for that episode in roster order, empty when nobody has one — **deliberately outside the spoiler gate**, for the same reason `authors` is: knowing someone is skipping an episode says nothing about what happens in it. A column since removed from the roster drops out rather than rendering nameless), gated `posts`, the caller's timer `session`, and the caller's own `adjust_secs`
```

- [ ] **Step 8: Run the full check suite**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 9: Commit**

```bash
git add src/index.js test/worker/discussion.test.js CLAUDE.md
git commit -m "feat(api): serialize episode statuses on the discussion read

Everyone's, in roster order, and outside the spoiler gate — a status is not
content, so it shows on a locked board for the same reason the authors list
does."
```

---

### Task 4: `skipLabel` in `utils.js`

**Files:**
- Modify: `frontend/utils.js` (append at the end of the file)
- Test: `test/frontend/utils.test.js` (append a new `describe` at the end)

**Interfaces:**
- Consumes: the `statuses` array shape from Task 3 — `[{ user_id, name, status, reason }]`.
- Produces: `skipLabel(statuses, meId)` → `string`. Task 5 renders its return value directly; an empty string means render nothing.

- [ ] **Step 1: Write the failing tests**

Append to `test/frontend/utils.test.js` (add `skipLabel` to the existing `import { … } from '../../frontend/utils.js';` at the top of that file):

```js
describe('skipLabel', () => {
    const alice = { user_id: 'user-alice', name: 'Alice', status: 'skipping' };
    const bob = { user_id: 'user-bob', name: 'Bob & Carol', status: 'skipping' };

    it('is empty when nobody is skipping', () => {
        expect(skipLabel([], 'user-alice')).toBe('');
    });

    it('is empty when statuses is missing', () => {
        expect(skipLabel(undefined, 'user-alice')).toBe('');
    });

    it('names the caller as You', () => {
        expect(skipLabel([{ ...alice, reason: 'recap' }], 'user-alice')).toBe(
            'Skipping recap: You',
        );
    });

    it('collapses to one reason when everyone agrees', () => {
        expect(
            skipLabel([{ ...alice, reason: 'recap' }, { ...bob, reason: 'recap' }], 'user-alice'),
        ).toBe('Skipping recap: You, Bob & Carol');
    });

    // The rarer branch, and so the one most likely to rot unnoticed.
    it('names a reason per person when they disagree', () => {
        expect(
            skipLabel(
                [{ ...alice, reason: 'recap' }, { ...bob, reason: 'reunion' }],
                'user-alice',
            ),
        ).toBe('Skipping: You (recap), Bob & Carol (reunion)');
    });

    it('puts the caller first regardless of roster order', () => {
        expect(
            skipLabel([{ ...bob, reason: 'recap' }, { ...alice, reason: 'recap' }], 'user-alice'),
        ).toBe('Skipping recap: You, Bob & Carol');
    });

    it('uses names when the caller is not skipping', () => {
        expect(skipLabel([{ ...bob, reason: 'reunion' }], 'user-alice')).toBe(
            'Skipping reunion: Bob & Carol',
        );
    });

    // A reader who is not on the roster has no id to match, and every name stands.
    it('handles a null caller id', () => {
        expect(skipLabel([{ ...bob, reason: 'recap' }], null)).toBe(
            'Skipping recap: Bob & Carol',
        );
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/frontend/utils.test.js -t skipLabel`
Expected: FAIL — `skipLabel is not a function` (the import resolves to `undefined`).

- [ ] **Step 3: Write the implementation**

Append to `frontend/utils.js`:

```js
// The episode header's summary of who is skipping and why. Collapses to one
// reason when everyone skipping agrees — the usual case, since a recap is a
// recap for everybody — and falls back to a reason per name when they don't. A
// single rule that always printed the reason per name would be correct but
// repetitive in the case that actually happens; a single rule that only ever
// collapsed would be wrong in the case that occasionally does.
//
// "You" leads, and the rest keep the roster order the server sent, so the line
// reads the same way on everyone's screen apart from which name is theirs.
// Returns '' rather than null so the caller can test it as a string.
export function skipLabel(statuses, meId) {
    const skips = (statuses ?? []).filter((s) => s.status === 'skipping');
    if (skips.length === 0) return '';

    const ordered = [
        ...skips.filter((s) => s.user_id === meId),
        ...skips.filter((s) => s.user_id !== meId),
    ];
    const nameOf = (s) => (s.user_id === meId ? 'You' : s.name);

    const reasons = new Set(ordered.map((s) => s.reason));
    if (reasons.size === 1) {
        return `Skipping ${ordered[0].reason}: ${ordered.map(nameOf).join(', ')}`;
    }
    return `Skipping: ${ordered.map((s) => `${nameOf(s)} (${s.reason})`).join(', ')}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/frontend/utils.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full check suite**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/utils.js test/frontend/utils.test.js
git commit -m "feat(frontend): add skipLabel

Collapses to one reason when everyone skipping an episode agrees, and names a
reason per person when they do not. The mixed branch is the rarer one, so it
gets its own tests rather than riding on the common case."
```

---

### Task 5: The chip and the menu

**Files:**
- Modify: `frontend/icons.js:3-14` (the lucide import) and `:29-41` (the `ICONS` map)
- Modify: `frontend/discussion.js` — the `import { … } from './utils.js'` line, `SeasonView`'s mutation helpers (near `setOffsetAdjust`, around line 194), the `<${EpisodeBoard} …>` props (around line 260), and `EpisodeBoard` (its signature, its state, its `summary` block, its header meta, and its `.episode-actions` row); add a new `SkipControl` component after `EpisodeBoard`
- Modify: `frontend/styles.css` — append the new rules after the `.reveal-btn` block (around line 1219), and add `.skip-btn` to the 44px touch-target block (around line 1782) and to the `:active` group (around line 2174)
- Modify: `frontend/CLAUDE.md` (near the `.episode-actions` bullets, around line 205)
- Modify: `README.md` (the **Discussion Boards** bullet list, around line 47)

**Interfaces:**
- Consumes: `skipLabel(statuses, meId)` from Task 4; `episodes[].statuses` from Task 3; the route from Task 2; the existing `mutate(fn, opts)` helper in `SeasonView` and the existing `Icon` component.
- Produces: nothing later tasks depend on — this is the last implementation task.

- [ ] **Step 1: Add the icon**

In `frontend/icons.js`, add `SkipForward,` to the named import from `lucide-preact`, in alphabetical position between `Reply,` and `Sun,`:

```js
import {
    Bell,
    ChevronLeft,
    Info,
    MessageCircle,
    MoreHorizontal,
    Moon,
    Pencil,
    Reply,
    SkipForward,
    Sun,
    Trash2,
    X,
} from 'lucide-preact';
```

and add the entry to `ICONS`, after `info: Info,`:

```js
    skipForward: SkipForward,
```

- [ ] **Step 2: Add the mutation to `SeasonView`**

In `frontend/discussion.js`, add `skipLabel` to the existing import from `./utils.js`.

Then add this helper immediately after `setTimerSkip` (which ends around line 219) and before `if (loading) return …`:

```js
    // Absolute, matching the route: a retried PUT lands on the same state rather
    // than toggling back out of it, and changing the reason is one request.
    const setStatus = (episode, status, reason) =>
        mutate(() =>
            api(`/api/seasons/${seasonId}/episodes/${episode}/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, reason }),
            }),
        );
```

and pass it down in the `<${EpisodeBoard} …>` element, after `onSkip=${setTimerSkip}`:

```js
                            onStatus=${setStatus}
```

- [ ] **Step 3: Take the prop and add the menu state in `EpisodeBoard`**

Add `onStatus,` to `EpisodeBoard`'s destructured props, after `onSkip,`.

Add this state alongside `menuFor` (after the `const [menuFor, setMenuFor] = useState(null);` line and its comment):

```js
    // Whether the skip menu is open. Episode-scoped for the same reason menuFor
    // is — one open menu per board, by construction — and local rather than in
    // SkipControl so tapping a different episode's control cannot leave two open.
    const [skipMenuOpen, setSkipMenuOpen] = useState(false);
```

- [ ] **Step 4: Render the chip in the header**

In `EpisodeBoard`, immediately after the `const others = …` line, add:

```js
    const skips = skipLabel(ep.statuses, meId);
    const mySkip = ep.statuses?.find((s) => s.user_id === meId) ?? null;
```

Then change the `.episode-meta` span. It currently reads:

```js
                <span class="episode-meta">
                    ${ep.readable ? '' : '🔒 '}${summary}${
                        others.length ? ` · ${others.join(', ')}` : ''
                    }
                </span>
```

Make it read:

```js
                <span class="episode-meta">
                    ${ep.readable ? '' : '🔒 '}${summary}${
                        others.length ? ` · ${others.join(', ')}` : ''
                    }${skips && html` · <span class="episode-skips">${skips}</span>`}
                </span>
```

- [ ] **Step 5: Render the control in the actions row**

In `EpisodeBoard`'s `.episode-actions` div, add the control between the reveal button and the `WatchTimer`, so the row reads reveal, skip, timer:

```js
                                    ${
                                        meId &&
                                        html`<${SkipControl}
                                            mine=${mySkip}
                                            open=${skipMenuOpen}
                                            onToggle=${() => setSkipMenuOpen((v) => !v)}
                                            onChoose=${(status, reason) => {
                                                setSkipMenuOpen(false);
                                                return onStatus(ep.episode, status, reason);
                                            }}
                                        />`
                                    }
```

- [ ] **Step 6: Add the `SkipControl` component**

In `frontend/discussion.js`, add this immediately after `EpisodeBoard`'s closing brace and before the `WatchTimer` comment block:

```js
// The two reasons the menu offers, paired with their display text. A list
// rather than two hand-written buttons so adding a third is one line here and
// nothing in the markup.
const SKIP_REASONS = [
    ['recap', 'Recap'],
    ['reunion', 'Reunion'],
];

// The actions-row control for a skip. A menu rather than a toggle, because a
// skip carries a required reason: there is no single-tap state to toggle into.
//
// "Not skipping" is its own item rather than a second tap on the active reason,
// so changing your mind about *why* and changing your mind about *whether* are
// never the same gesture — picking the reason already in effect just closes the
// menu, spending no request. The scrim is what makes a tap anywhere off the
// menu dismiss it, matching the note menu in post.js.
function SkipControl({ mine, open, onToggle, onChoose }) {
    return html`
        <div class="skip">
            <button
                class=${'skip-btn' + (mine ? ' on' : '')}
                aria-expanded=${open}
                onClick=${onToggle}
            >
                <${Icon} name="skipForward" />
                <span>${mine ? `Skipping ${mine.reason}` : 'Skip'}</span>
            </button>
            ${
                open &&
                html`
                    <div class="skip-scrim" onClick=${onToggle}></div>
                    <div class="skip-menu" role="group" aria-label="Skip this episode">
                        ${SKIP_REASONS.map(
                            ([value, text]) =>
                                html`<button
                                    key=${value}
                                    class="skip-menu-item"
                                    aria-pressed=${mine?.reason === value}
                                    onClick=${() =>
                                        mine?.reason === value
                                            ? onToggle()
                                            : onChoose('skipping', value)}
                                >
                                    ${text}
                                </button>`,
                        )}
                        ${
                            mine &&
                            html`<button
                                class="skip-menu-item skip-menu-item-clear"
                                onClick=${() => onChoose(null, null)}
                            >
                                Not skipping
                            </button>`
                        }
                    </div>
                `
            }
        </div>
    `;
}
```

- [ ] **Step 7: Add the styles**

In `frontend/styles.css`, add these rules immediately after the `.reveal-btn` block:

```css
/* The chip inside .episode-meta. Full-strength text against the muted counts
   around it, because a stated intention is a different kind of fact from a
   note count — it was typed by a person rather than derived. */
.episode-skips {
    color: var(--text);
}

/* The positioning context the menu anchors to, so it opens under the button
   rather than under the whole actions row. */
.skip {
    position: relative;
    display: inline-flex;
}

/* Sized and weighted as .timer-btn's peer, not .reveal-btn's: revealing is the
   row's one consequential, irreversible action and keeps the filled treatment
   to itself. font-family: inherit because a <button> does not take the page's
   font on its own. */
.skip-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-height: var(--control-height);
    padding: 0.25rem 0.6rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-subtle);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
}

/* Filled once a skip is set, so the row shows the state without the menu open —
   the same accent .timer-chip.running takes for the same reason. */
.skip-btn.on {
    background: var(--surface-accent);
    color: var(--text);
}

/* Transparent and full-viewport: a tap anywhere off the menu dismisses it,
   which is what lets the menu itself carry no close button. */
.skip-scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
}

/* Left-aligned to its button rather than right-aligned like .post-menu: this
   control sits at the left of the actions row, so it opens inward from there. */
.skip-menu {
    position: absolute;
    top: 100%;
    left: 0;
    margin-block: 0.25rem;
    z-index: 21;
    min-width: 9rem;
    display: flex;
    flex-direction: column;
    padding: 0.35rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px var(--shadow);
}

.skip-menu-item {
    width: 100%;
    background: none;
    border: none;
    border-radius: 0.35rem;
    color: var(--text-subtle);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85rem;
    text-align: left;
    padding: 0.4rem 0.5rem;
}

.skip-menu-item[aria-pressed='true'] {
    background: var(--surface-accent);
    color: var(--text);
}

/* Ruled off above: clearing the skip is a different kind of choice from
   picking why, and the rule is what stops a mis-tap from crossing between them. */
.skip-menu-item-clear {
    margin-top: 0.35rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.5rem;
}
```

In the touch-target block (the one containing `.reveal-btn, .post-submit, .timer-chip, .timer-btn { min-height: 44px; }`), add `.skip-btn,` to the selector list:

```css
    .reveal-btn,
    .post-submit,
    .skip-btn,
    .timer-chip,
    .timer-btn {
        min-height: 44px;
    }
```

In the `:active` group (the one containing `.reveal-btn:active, .post-submit:active, …`), add `.skip-menu-item:active,` after `.post-menu-close:active,`:

```css
.reveal-btn:active,
.post-submit:active,
.post-menu-item:active,
.post-menu-close:active,
.skip-menu-item:active,
.theme-btn:active {
    background: var(--surface-hover);
}
```

- [ ] **Step 8: Run the full check suite**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass. The build is what proves `SkipForward` resolves from `lucide-preact` and the htm templates parse.

- [ ] **Step 9: Look at it**

Run: `npm run dev`

Open a season, expand an episode, and confirm: the Skip button sits between "Show discussion" and the timer; the menu opens under it and dismisses on a tap outside; picking Recap fills the button and puts `Skipping recap: You` in the collapsed header; picking Reunion changes it in place without an intermediate un-skipped state; "Not skipping" appears only once a status is set and clears it. Stop the dev server when done.

- [ ] **Step 10: Document the frontend**

In `frontend/CLAUDE.md`, add this bullet immediately after the bullet describing the reveal button and the watch timer sharing `.episode-actions` (around line 205-213):

```markdown
- The skip control (`SkipControl` in `discussion.js`) sits between the reveal
  button and the timer in that same row. It is a menu rather than a toggle
  because a skip carries a required reason, so there is no single state to
  toggle into: the items are the reasons, plus "Not skipping" once a status
  exists. Picking the reason already in effect just closes the menu and spends
  no request — clearing is its own item, so changing your mind about *why* and
  about *whether* are never the same gesture. Open/closed state lives in
  `EpisodeBoard` beside `menuFor`, not inside `SkipControl`, so one board can
  never have two menus open. The header chip is `skipLabel` (`utils.js`), which
  collapses to one reason when everyone skipping agrees and names a reason per
  person when they don't. Statuses are **not** spoiler-gated — the server sends
  everyone's even on a locked board, for the same reason it sends the authors
  list — so the chip renders whether or not the board is readable.
```

In `README.md`, add this bullet to the **Discussion Boards** list, immediately after the watch-timer bullet and before the "Replies, reactions, and edits" bullet:

```markdown
- **Say what you're skipping.** Mark an episode as one you're not going to
  watch — a recap or a reunion — and everyone else sees it on the season page,
  whether or not they've opened that board. It's a note about your intentions
  and nothing more: it doesn't open the board, doesn't count as watched, and
  doesn't show up in the what's-new feed.
```

- [ ] **Step 11: Run the full check suite again**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

- [ ] **Step 12: Commit**

```bash
git add frontend/icons.js frontend/discussion.js frontend/styles.css frontend/CLAUDE.md README.md
git commit -m "feat(frontend): show and set an episode skip

A chip in the collapsed episode header says who is skipping and why, and a
menu in the actions row sets it. Clearing is its own item rather than a second
tap on the active reason, so changing why and changing whether are never the
same gesture."
```

---

## Done

At this point: `npm run build`, `npm test`, `npm run lint` and `npm run format:check` all pass; the branch `episode-statuses` carries the spec, the migration, the two API changes, the label helper, and the UI. Open a PR against `main`.

To exercise it against the local D1, `npm run dev` and use the UI — there is no seed data for statuses, and `scripts/insert-test-post.py` does not write them.
