# Timer Sync and Reply Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a watcher retroactively correct a watch timer that started at the wrong point in an episode, and stop a reply from ever rendering above the note it answers.

**Architecture:** One revisable `adjust_secs` per `(user, season, episode)` in a new `watch_offsets` table, applied on read — `posts.offset_secs` keeps meaning "what the timer read at write time," so a correction is undoable and shifts notes already posted. Separately, `orderPosts` gains a lexicographic sort key and clamps each reply's key to its parent's, which is a pure client-side change.

**Tech Stack:** Cloudflare Workers + Hono + zod, D1 (SQLite) migrations, Preact + htm frontend bundled by esbuild, Vitest (`@cloudflare/vitest-pool-workers` for the Worker suites, plain Vitest for the frontend ones).

Design spec: `docs/superpowers/specs/2026-08-01-timer-sync-and-reply-ordering-design.md`

## Global Constraints

- **Never commit real names or email addresses.** Tests and fixtures use `user-N` ids, made-up names, and `@example.com` addresses only.
- **Before every commit run all four checks and confirm they pass:** `npm run build`, `npm test`, `npm run lint`, `npm run format:check`. A commit that fails any of them must not be made. Run `npm run format` to fix formatting.
- **Never use `--no-verify`.** Two pre-commit hooks run locally and neither may be bypassed.
- Do not edit `public/script.js` — it is build output. Edit files under `frontend/`.
- Rules both the Worker and the browser must compute identically live in `shared/`.
- All mutations attribute to the caller's own `users.id`, resolved by `callerUser(c)`. There is no client-supplied user id.
- Maximum absolute adjustment is **3600 seconds**, exported as `MAX_OFFSET_ADJUST_SECS` from `shared/session.js` so the client clamp and the server validation cannot disagree.
- Adjustment steps in the UI are **15s and 60s**.
- Comments in this codebase explain _why_, not _what_. Match that density and tone.

## File Structure

**Create:**

- `migrations/0008_watch_offsets.sql` — the `watch_offsets` table.

**Modify:**

- `shared/session.js` — `sessionOffsetSecs` gains an `adjustSecs` parameter; adds `MAX_OFFSET_ADJUST_SECS`.
- `src/index.js` — new `offsetAdjust` zod schema; new `PUT /api/seasons/:season_id/episodes/:episode/offset` route; the discussion read path loads adjustments and applies them.
- `frontend/utils.js` — `orderPosts` gains reply clamping and a `clamped` flag; new `formatAdjust`.
- `frontend/post.js` — new exported `postTimeText` / `postTimeTitle`, used by `Post`.
- `frontend/discussion.js` — `SeasonView` gains an `setOffsetAdjust` mutation; `EpisodeBoard` threads it; `WatchTimer` gains the `±` toggle and the adjust row.
- `frontend/styles.css` — `.timer-stack`, `.timer-adjust`, `.timer-adjust-total`, and mobile wrapping.
- `test/worker/migrations.test.js`, `test/worker/discussion.test.js`, `test/frontend/session.test.js`, `test/frontend/posts.test.js`, `test/frontend/utils.test.js`, `test/frontend/post.test.js` — tests.
- `README.md`, `CLAUDE.md`, `frontend/CLAUDE.md` — docs.

Tasks 1–4 are the server half and are strictly ordered. Task 5–6 (reply ordering) are independent of 1–4 and can be done in either order relative to them. Task 7 depends on 1–4. Task 8 is last.

---

### Task 1: The `watch_offsets` table

**Files:**

- Create: `migrations/0008_watch_offsets.sql`
- Test: `test/worker/migrations.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: table `watch_offsets (user_id TEXT, season_id INTEGER, episode INTEGER, adjust_secs INTEGER, updated_at TEXT)`, primary key `(user_id, season_id, episode)`.

- [ ] **Step 1: Write the failing test**

Append to `test/worker/migrations.test.js`:

```js
// The correction deliberately lives outside watch_sessions: `start` zeroes that
// row, and zeroing a correction would silently un-shift notes it had already
// moved. Its own table is what makes it outlive the session that produced it.
describe('watch offset corrections', () => {
    it('has a watch_offsets table keyed per user, season, and episode', async () => {
        const { results } = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'watch_offsets'",
        ).all();
        expect(results).toHaveLength(1);
        expect(results[0].sql).toContain('adjust_secs');
        expect(results[0].sql).toContain('PRIMARY KEY (user_id, season_id, episode)');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: FAIL — `expect(results).toHaveLength(1)` gets 0, because no such table exists.

- [ ] **Step 3: Write the migration**

Create `migrations/0008_watch_offsets.sql`:

```sql
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: PASS. The Vitest pool applies `migrations/` automatically (`vitest.config.mjs` → `readD1Migrations`), so no manual `wrangler d1 migrations apply` is needed for tests.

- [ ] **Step 5: Run the full check suite and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add migrations/0008_watch_offsets.sql test/worker/migrations.test.js
git commit -m "feat: add watch_offsets, a per-episode watch-timer correction"
```

---

### Task 2: `sessionOffsetSecs` applies an adjustment

**Files:**

- Modify: `shared/session.js`
- Test: `test/frontend/session.test.js`

**Interfaces:**

- Consumes: Task 1's table (conceptually only — this task touches no SQL).
- Produces:
    - `sessionOffsetSecs(session, nowMs, adjustSecs = 0) → number | null`
    - `MAX_OFFSET_ADJUST_SECS = 3600`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('sessionOffsetSecs', ...)` block in `test/frontend/session.test.js`:

```js
it('adds a correction to the running total', () => {
    const session = { elapsed_secs: 600, running_since: null, last_activity_at: iso(0) };
    expect(sessionOffsetSecs(session, at(60), 45)).toBe(645);
    expect(sessionOffsetSecs(session, at(60), -45)).toBe(555);
});

it('defaults the correction to zero when omitted', () => {
    const session = { elapsed_secs: 600, running_since: null, last_activity_at: iso(0) };
    expect(sessionOffsetSecs(session, at(60))).toBe(600);
});

// A correction is a statement about the episode's zero point, not about when
// the app was last touched, so it cannot revive a session that has gone stale.
it('is still null for a stale session however large the correction', () => {
    const session = { elapsed_secs: 600, running_since: null, last_activity_at: iso(0) };
    expect(sessionOffsetSecs(session, at(SESSION_IDLE_LIMIT_SECS + 1), 3600)).toBeNull();
});

// A correction backwards can push an early note below zero. That is left to
// sort truthfully; formatOffset and formatOffsetShort clamp the display.
it('allows a correction to push the total negative', () => {
    const session = { elapsed_secs: 10, running_since: null, last_activity_at: iso(0) };
    expect(sessionOffsetSecs(session, at(0), -60)).toBe(-50);
});
```

Add a second `describe` block at the end of the file:

```js
describe('MAX_OFFSET_ADJUST_SECS', () => {
    // Shared so the client clamp and the server's 400 cannot disagree.
    it('is an hour, far past any plausible zero-point error', () => {
        expect(MAX_OFFSET_ADJUST_SECS).toBe(3600);
    });
});
```

Update the import at the top of the file to:

```js
import {
    sessionOffsetSecs,
    SESSION_IDLE_LIMIT_SECS,
    MAX_OFFSET_ADJUST_SECS,
} from '../../shared/session.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/frontend/session.test.js`
Expected: FAIL — `MAX_OFFSET_ADJUST_SECS` is undefined, and the adjustment tests return the uncorrected totals (600, not 645).

- [ ] **Step 3: Implement**

In `shared/session.js`, add the constant below `SESSION_IDLE_LIMIT_SECS`:

```js
// The largest correction anyone may apply to an episode's zero point, in
// seconds either direction. An hour is already far past any plausible mistake
// about where an episode started; beyond it the caller has a bug, and failing
// loudly beats storing it. Lives here rather than in the Worker so the UI's
// clamp and the API's 400 are the same number.
export const MAX_OFFSET_ADJUST_SECS = 3600;
```

Change the signature and the return of `sessionOffsetSecs`:

```js
// Accumulated watch time right now, or null when there is no live session.
// `nowMs` is a millisecond epoch so callers can pass the server clock rather
// than a possibly-skewed local one.
//
// `adjustSecs` is the reader's correction for this episode (see
// migration 0008): timers drift by a constant shift, so a correction is a
// constant added at the end. It deliberately does not participate in the
// staleness check above — a correction says where the episode started, not
// when the app was last touched, so it can never revive a dead session. It is
// also deliberately not clamped at zero: a backwards correction can push an
// early note negative, which sorts truthfully while formatOffset and
// formatOffsetShort clamp what is shown.
export function sessionOffsetSecs(session, nowMs, adjustSecs = 0) {
    if (!session) return null;

    const idleSecs = (nowMs - Date.parse(session.last_activity_at)) / 1000;
    if (idleSecs > SESSION_IDLE_LIMIT_SECS) return null;

    // Paused sessions bank their total in elapsed_secs and contribute no
    // running segment. Clamp the segment at zero so a skewed clock cannot wind
    // the timer backwards.
    const runningSecs = session.running_since
        ? Math.max(0, (nowMs - Date.parse(session.running_since)) / 1000)
        : 0;

    return Math.round(session.elapsed_secs + runningSecs) + adjustSecs;
}
```

Leave every existing caller alone. `postOffset` in `src/index.js` and the timer route both call it with two arguments, and must keep doing so — the writer stamps the **raw** reading and the reader adds the correction. Passing the adjustment at write time would bake it in and defeat the whole design.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/frontend/session.test.js`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 5: Run the full check suite and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add shared/session.js test/frontend/session.test.js
git commit -m "feat: let sessionOffsetSecs apply a per-episode correction"
```

---

### Task 3: `PUT /api/seasons/:season_id/episodes/:episode/offset`

**Files:**

- Modify: `src/index.js` (schema block near line 54; route immediately after the timer route, before `app.all('/api/*', ...)`)
- Test: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `MAX_OFFSET_ADJUST_SECS` from `shared/session.js` (Task 2); `watch_offsets` (Task 1); the existing `callerUser(c)` and `resolveEpisode(c)` helpers.
- Produces: `PUT /api/seasons/:season_id/episodes/:episode/offset` taking `{ adjust_secs: number }` and answering `{ success: true, season_id, episode, adjust_secs }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/discussion.test.js`:

```js
const storedAdjust = (userId, seasonId, episode) =>
    env.DB.prepare(
        'SELECT adjust_secs FROM watch_offsets WHERE user_id = ? AND season_id = ? AND episode = ?',
    )
        .bind(userId, seasonId, episode)
        .first();

describe('PUT /api/seasons/:season_id/episodes/:episode/offset', () => {
    it('stores a correction for the caller', async () => {
        const r = await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ season_id: 45, episode: 7, adjust_secs: 45 });
        expect(await storedAdjust('user-alice', 45, 7)).toMatchObject({ adjust_secs: 45 });
    });

    // Absolute, not a delta — the client always computes the new total from
    // what the server last reported, so a retry cannot accumulate.
    it('is idempotent: the same value twice leaves one row and one value', async () => {
        for (let i = 0; i < 2; i++) {
            await req('PUT', '/api/seasons/45/episodes/7/offset', {
                body: { adjust_secs: -30 },
                email: 'alice@example.com',
            });
        }
        const { results } = await env.DB.prepare('SELECT adjust_secs FROM watch_offsets').all();
        expect(results).toEqual([{ adjust_secs: -30 }]);
    });

    it('replaces an existing correction rather than adding to it', async () => {
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 60 },
            email: 'alice@example.com',
        });
        expect(await storedAdjust('user-alice', 45, 7)).toMatchObject({ adjust_secs: 60 });
    });

    // "No correction" gets one representation rather than two.
    it('removes the row when the correction is zeroed', async () => {
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        const r = await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 0 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
        expect(await storedAdjust('user-alice', 45, 7)).toBeNull();
    });

    it('scopes a correction to the one episode it names', async () => {
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        expect(await storedAdjust('user-alice', 45, 8)).toBeNull();
    });

    it('attributes to the caller, not a client-supplied id', async () => {
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45, user_id: 'user-bob' },
            email: 'alice@example.com',
        });
        expect(await storedAdjust('user-bob', 45, 7)).toBeNull();
        expect(await storedAdjust('user-alice', 45, 7)).toMatchObject({ adjust_secs: 45 });
    });

    // The case the whole feature exists for: you notice your notes are
    // misplaced days later, with no timer running.
    it('accepts a correction with no live session', async () => {
        const r = await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: -60 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(200);
    });

    it('rejects a correction beyond an hour in either direction', async () => {
        for (const adjust_secs of [3601, -3601]) {
            const r = await req('PUT', '/api/seasons/45/episodes/7/offset', {
                body: { adjust_secs },
                email: 'alice@example.com',
            });
            expect(r.status).toBe(400);
        }
    });

    it('rejects a non-integer correction', async () => {
        const r = await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 12.5 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('404s an episode the season does not have', async () => {
        const r = await req('PUT', '/api/seasons/45/episodes/99/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('403s a caller who is not on the roster', async () => {
        const r = await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'nobody@example.com',
        });
        expect(r.status).toBe(403);
    });

    // The regression the separate table exists to prevent.
    it('survives a timer restart, which zeroes the session', async () => {
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        await req('POST', '/api/seasons/45/episodes/7/timer', {
            body: { action: 'start' },
            email: 'alice@example.com',
        });
        expect(await storedAdjust('user-alice', 45, 7)).toMatchObject({ adjust_secs: 45 });
    });
});
```

Add `watch_offsets` to the `beforeEach` cleanup at the top of the file, before `DELETE FROM watch_sessions` (children before parents):

```js
await env.DB.exec('DELETE FROM watch_offsets');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'episodes/:episode/offset'`
Expected: FAIL — every case gets 404 from the `app.all('/api/*')` catch-all, since the route does not exist.

- [ ] **Step 3: Implement**

In `src/index.js`, extend the `shared/session.js` import:

```js
import { sessionOffsetSecs, MAX_OFFSET_ADJUST_SECS } from '../shared/session.js';
```

Add the schema after `timerAction` (around line 35):

```js
const offsetAdjust = z.object({
    adjust_secs: z
        .number()
        .int({ message: 'adjust_secs must be a whole number of seconds' })
        .min(-MAX_OFFSET_ADJUST_SECS, {
            message: `adjust_secs must be within ${MAX_OFFSET_ADJUST_SECS} seconds of zero`,
        })
        .max(MAX_OFFSET_ADJUST_SECS, {
            message: `adjust_secs must be within ${MAX_OFFSET_ADJUST_SECS} seconds of zero`,
        }),
});
```

Add the route immediately after the timer route closes (after its `);` around line 907) and before `app.all('/api/*', ...)`:

```js
// Correct where this episode started for you. Timers drift because people press
// start at different points relative to the show — before the "previously on",
// after the cold open, or not at all because they skipped the recap — so the
// error is a constant shift and one number fixes it.
//
// The value is absolute rather than a delta, for the reason the reactions route
// takes an explicit `on` instead of toggling: the client computes the new total
// from what the server last reported, so a double-tap, a retry, or a slow
// network cannot accumulate a correction nobody asked for.
//
// Its own route rather than a fourth timer action: it writes no session, and it
// has to work when none exists. Noticing your notes sit in the wrong place
// happens while reading the board, long after the timer went stale.
app.put(
    '/api/seasons/:season_id/episodes/:episode/offset',
    zValidator('json', offsetAdjust, onInvalid),
    async (c) => {
        const me = await callerUser(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

        const resolved = await resolveEpisode(c);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { adjust_secs } = c.req.valid('json');
        const key = [me.id, season.id, episode];

        if (adjust_secs === 0) {
            // "No correction" gets one representation rather than two.
            await c.env.DB.prepare(
                'DELETE FROM watch_offsets WHERE user_id = ? AND season_id = ? AND episode = ?',
            )
                .bind(...key)
                .run();
        } else {
            await c.env.DB.prepare(
                `INSERT INTO watch_offsets
                     (user_id, season_id, episode, adjust_secs, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (user_id, season_id, episode) DO UPDATE SET
                     adjust_secs = excluded.adjust_secs,
                     updated_at = excluded.updated_at`,
            )
                .bind(...key, adjust_secs, new Date().toISOString())
                .run();
        }

        return c.json({ success: true, season_id: season.id, episode, adjust_secs });
    },
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Run the full check suite and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js
git commit -m "feat: add a route for correcting an episode's watch-timer zero"
```

---

### Task 4: The discussion read path applies corrections

**Files:**

- Modify: `src/index.js` (the `GET /api/seasons/:season_id/discussion` handler, roughly lines 480–623)
- Test: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `watch_offsets` (Task 1), the route from Task 3 for setup in tests.
- Produces:
    - Each serialized post's `offset_secs` is `stored offset + that post's author's adjustment for that episode`, or `null` when the stored offset is `null`.
    - Each episode object carries `adjust_secs` (a number, `0` when there is no correction or no caller) alongside `session`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/discussion.test.js`. These use the Task 3 route for setup, so they read as the feature does:

```js
describe('watch-offset corrections in the discussion', () => {
    const postAt = (email, offsetSecs, body) =>
        env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at, offset_secs, author_email)
             VALUES (45, 7, ?, ?, '2026-07-20T21:00:00.000Z', ?, ?)`,
        )
            .bind(
                email === 'alice@example.com' ? 'user-alice' : 'user-bob',
                body,
                offsetSecs,
                email,
            )
            .run();

    const episodeSeven = async (email) => {
        const r = await req('GET', '/api/seasons/45/discussion', { email });
        const { episodes } = await r.json();
        return episodes.find((e) => e.episode === 7);
    };

    beforeEach(async () => {
        // Both watch the season, so every episode is readable and nothing is
        // filtered out from under these assertions.
        await env.DB.exec(
            'INSERT INTO watched (user_id, season_id, created_at) VALUES ' +
                "('user-alice', 45, '2026-07-01T00:00:00.000Z'), " +
                "('user-bob', 45, '2026-07-01T00:00:00.000Z')",
        );
    });

    it("shifts a post by its own author's correction", async () => {
        await postAt('alice@example.com', 600, 'alice note');
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        const ep = await episodeSeven('alice@example.com');
        expect(ep.posts[0].offset_secs).toBe(645);
    });

    // A post is shifted by its writer's correction, not the reader's — the
    // correction is a fact about how that person watched.
    it("leaves another author's posts alone", async () => {
        await postAt('alice@example.com', 600, 'alice note');
        await postAt('bob@example.com', 600, 'bob note');
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        const ep = await episodeSeven('bob@example.com');
        const byBody = Object.fromEntries(ep.posts.map((p) => [p.body, p.offset_secs]));
        expect(byBody).toEqual({ 'alice note': 645, 'bob note': 600 });
    });

    it('applies only to the episode the correction names', async () => {
        await postAt('alice@example.com', 600, 'episode seven note');
        await env.DB.exec(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at, offset_secs, author_email)
             VALUES (45, 8, 'user-alice', 'episode eight note', '2026-07-20T22:00:00.000Z', 600, 'alice@example.com')`,
        );
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        const r = await req('GET', '/api/seasons/45/discussion', { email: 'alice@example.com' });
        const { episodes } = await r.json();
        expect(episodes.find((e) => e.episode === 7).posts[0].offset_secs).toBe(645);
        expect(episodes.find((e) => e.episode === 8).posts[0].offset_secs).toBe(600);
    });

    // Nothing to shift: no timer was running when this note was written.
    it('leaves an untimed post null', async () => {
        await postAt('alice@example.com', null, 'untimed note');
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });
        const ep = await episodeSeven('alice@example.com');
        expect(ep.posts[0].offset_secs).toBeNull();
    });

    // The live chip ticks locally, so it needs the same number the posts got.
    it("carries the caller's own correction on the episode", async () => {
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: -30 },
            email: 'alice@example.com',
        });
        expect((await episodeSeven('alice@example.com')).adjust_secs).toBe(-30);
        expect((await episodeSeven('bob@example.com')).adjust_secs).toBe(0);
    });

    it('reports zero for an episode with no correction', async () => {
        expect((await episodeSeven('alice@example.com')).adjust_secs).toBe(0);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/worker/discussion.test.js -t 'watch-offset corrections'`
Expected: FAIL — offsets come back unshifted (600, not 645) and `adjust_secs` is `undefined`.

- [ ] **Step 3: Implement**

In the `GET /api/seasons/:season_id/discussion` handler, add a seventh entry to the destructured array and to the `Promise.all`:

```js
const [
    { results: posts },
    watchedRow,
    { results: reveals },
    { results: sessions },
    people,
    { results: reactionRows },
    { results: offsets },
] = await Promise.all([
    // ...every existing entry unchanged...
    // Every user's corrections, not just the caller's: a post is shifted by the
    // correction of whoever wrote it. One query for the season, grouped below.
    c.env.DB.prepare('SELECT user_id, episode, adjust_secs FROM watch_offsets WHERE season_id = ?')
        .bind(seasonId)
        .all(),
]);
```

Below `const sessionByEpisode = ...`, add the lookup:

```js
// A watch-timer correction (migration 0008) is applied here rather than stored
// into posts.offset_secs, which keeps meaning what the writer's timer actually
// read. Applying on read is what lets a correction be revised, and what makes
// it reach the notes that revealed the drift in the first place.
const adjustByKey = new Map(offsets.map((o) => [`${o.user_id}:${o.episode}`, o.adjust_secs]));
const adjustFor = (userId, episode) => adjustByKey.get(`${userId}:${episode}`) ?? 0;
```

In the `posts: visible.map(...)` projection, replace the `offset_secs` line:

```js
offset_secs:
    p.offset_secs == null ? null : p.offset_secs + adjustFor(p.user_id, episode),
```

And add `adjust_secs` to the pushed episode object, next to `session`:

```js
// The caller's own correction, for the live chip — it ticks locally, so it
// has to add the same number the posts above already got.
adjust_secs: me ? adjustFor(me.id, episode) : 0,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Run the full check suite and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js
git commit -m "feat: apply watch-timer corrections when serving a discussion"
```

---

### Task 5: A reply never sorts before its parent

**Files:**

- Modify: `frontend/utils.js` (`orderPosts`, roughly lines 143–171)
- Test: `test/frontend/posts.test.js`

**Interfaces:**

- Consumes: nothing from Tasks 1–4.
- Produces: `orderPosts(posts)` returns entries `{ post, offset, inferred, tail, created, clamped }`. `clamped` is `true` only when the reply rule actually moved that entry. The parent is looked up through `post.reply_to.id` — the shape the discussion API serializes — **not** `post.reply_to_post_id`, which the client never receives.

- [ ] **Step 1: Write the failing tests**

Add to `test/frontend/posts.test.js`. First extend the fixtures at the top of the file:

```js
const replying = (id, user_id, offset_secs, created_at, parentId) => ({
    ...timed(id, user_id, offset_secs, created_at),
    reply_to: { id: parentId, author_name: 'Someone', author_index: 0, mine: false, body: 'x' },
});
```

Then add these cases inside `describe('orderPosts', ...)`:

```js
// Two people whose timers disagree can stamp a reply earlier than the note it
// answers, which put the quote block above the note it quotes.
it('pulls a reply down to sit directly after an earlier-stamped parent', () => {
    const posts = [
        timed(1, 'alice', 900, '2026-07-20T21:15:00.000Z'),
        replying(2, 'bob', 300, '2026-07-23T06:05:00.000Z', 1),
        timed(3, 'alice', 1200, '2026-07-20T21:20:00.000Z'),
    ];
    const placed = orderPosts(posts);
    expect(placed.map((p) => p.post.id)).toEqual([1, 2, 3]);
    expect(placed[1].clamped).toBe(true);
});

it('resolves a chain of replies, each stamped before the last', () => {
    const posts = [
        timed(1, 'alice', 900, '2026-07-20T21:15:00.000Z'),
        replying(2, 'bob', 600, '2026-07-23T06:10:00.000Z', 1),
        replying(3, 'carol', 300, '2026-07-24T06:05:00.000Z', 2),
    ];
    expect(orderPosts(posts).map((p) => p.post.id)).toEqual([1, 2, 3]);
});

// Nothing to do with drift: a stray untimed note from a timed author sits in
// the tail, and a timed reply to it must follow it down there.
it('follows a tail parent into the tail', () => {
    const posts = [
        timed(1, 'alice', 900, '2026-07-20T21:15:00.000Z'),
        untimed(2, 'alice', '2026-07-22T21:10:00.000Z'),
        replying(3, 'bob', 300, '2026-07-23T06:05:00.000Z', 2),
    ];
    const placed = orderPosts(posts);
    expect(placed.map((p) => p.post.id)).toEqual([1, 2, 3]);
    expect(placed[2].clamped).toBe(true);
});

it('leaves a reply that already follows its parent unclamped', () => {
    const posts = [
        timed(1, 'alice', 300, '2026-07-20T21:05:00.000Z'),
        replying(2, 'bob', 900, '2026-07-23T06:15:00.000Z', 1),
    ];
    const placed = orderPosts(posts);
    expect(placed.map((p) => p.post.id)).toEqual([1, 2]);
    expect(placed[1].clamped).toBe(false);
});

// A locked parent is not rendered at all, so there is no ordering to violate;
// a deleted one leaves reply_to null. Both leave the reply where it fell.
it('leaves a reply alone when the parent is not in the list', () => {
    const locked = {
        ...timed(2, 'bob', 300, '2026-07-23T06:05:00.000Z'),
        reply_to: { id: 99, locked: true },
    };
    const posts = [timed(1, 'alice', 900, '2026-07-20T21:15:00.000Z'), locked];
    const placed = orderPosts(posts);
    expect(placed.map((p) => p.post.id)).toEqual([2, 1]);
    expect(placed[0].clamped).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/frontend/posts.test.js -t orderPosts`
Expected: FAIL — the first case orders `[2, 1, 3]`, and `clamped` is `undefined` everywhere.

- [ ] **Step 3: Implement**

Replace the tail of `orderPosts` in `frontend/utils.js`. Keep the `timedAuthors` and `zeroByAuthor` computation exactly as it is; change the `placed` mapping to seed `clamped: false`, and replace the `.sort(...)` with the clamping pass below.

Add above `orderPosts`:

```js
// A placement's sort key: tail notes last, then watch offset, then wall-clock
// time, then post id. Compared lexicographically, this is the ordering the
// timeline has always used, with the id appended — which is what makes the
// reply clamp below land a reply *after* its parent rather than before, since
// a parent's id is always smaller than its reply's.
function sortKey(entry) {
    // Tail entries carry a null offset and are ordered among themselves by
    // wall-clock time, so they must compare equal on this component.
    return [entry.tail ? 1 : 0, entry.tail ? 0 : entry.offset, entry.created, entry.post.id];
}

function compareKeys(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}
```

Then, inside `orderPosts`, after `const placed = posts.map(...)`:

```js
// A reply must never render above the note it answers. It is placed by its
// own watch offset like any other note — replies are not threaded — but two
// people whose timers disagree can stamp a reply earlier than its parent,
// and a note whose author's session went stale lands in the tail while a
// reply to it does not. Both put the quote block above the note it quotes.
//
// The fix is to clamp a reply's sort key to its parent's already-clamped
// key, keeping its own id in the last slot so it lands immediately after.
// Resolved by memoized recursion so a chain of replies settles in one pass.
const byId = new Map(placed.map((entry) => [entry.post.id, entry]));
const keys = new Map();
const resolving = new Set();

const clampedKey = (entry) => {
    const id = entry.post.id;
    const cached = keys.get(id);
    if (cached) return cached;

    let key = sortKey(entry);
    // A cycle cannot be written — a parent has to exist before it can be
    // replied to, so ids strictly increase down a chain — but the guard
    // keeps a corrupt response from recursing forever.
    if (!resolving.has(id)) {
        resolving.add(id);
        // reply_to, not reply_to_post_id: the server serializes the parent
        // as an object, and its locked form carries an id whose post is
        // deliberately absent from this list — a miss here is the correct
        // outcome, since an unrendered parent has no order to violate.
        const parent = entry.post.reply_to && byId.get(entry.post.reply_to.id);
        if (parent) {
            const parentKey = clampedKey(parent);
            if (compareKeys(key, parentKey) < 0) {
                key = [parentKey[0], parentKey[1], parentKey[2], id];
                entry.clamped = true;
            }
        }
        resolving.delete(id);
    }

    keys.set(id, key);
    return key;
};

// Resolved up front rather than inside the comparator, so `clamped` is
// settled on every entry before anything reads it.
for (const entry of placed) clampedKey(entry);

return placed.sort((a, b) => compareKeys(keys.get(a.post.id), keys.get(b.post.id)));
```

And in the `placed` mapping, add `clamped: false` to all three returned objects, so the property always exists:

```js
const placed = posts.map((post) => {
    const created = Date.parse(post.created_at);
    if (post.offset_secs != null) {
        return {
            post,
            offset: post.offset_secs,
            inferred: false,
            tail: false,
            created,
            clamped: false,
        };
    }
    if (timedAuthors.has(post.user_id)) {
        return { post, offset: null, inferred: false, tail: true, created, clamped: false };
    }
    const offset = Math.round((created - zeroByAuthor.get(post.user_id)) / 1000);
    return { post, offset, inferred: true, tail: false, created, clamped: false };
});
```

Update `orderPosts`'s doc comment to mention `clamped` in the returned shape.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/frontend/posts.test.js`
Expected: PASS — including the pre-existing `orders a reply by its own offset, not beside its parent`, which stays green because that reply is already after its parent.

- [ ] **Step 5: Run the full check suite and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/utils.js test/frontend/posts.test.js
git commit -m "fix: never sort a reply above the note it answers"
```

---

### Task 6: A clamped reply shows no time chip

**Files:**

- Modify: `frontend/post.js` (`Post`, roughly lines 423–433)
- Test: `test/frontend/post.test.js`

**Interfaces:**

- Consumes: `clamped` on a placement (Task 5); `formatOffsetShort` from `frontend/utils.js`.
- Produces: `postTimeText(entry) → string` and `postTimeTitle(entry) → string`, both exported from `frontend/post.js`.

- [ ] **Step 1: Write the failing tests**

Add to `test/frontend/post.test.js`, and extend the import to `import { accentClass, postTimeText, postTimeTitle } from '../../frontend/post.js';`:

```js
const entry = (over = {}) => ({
    post: { id: 1, created_at: '2026-07-20T21:10:00.000Z' },
    offset: 600,
    inferred: false,
    tail: false,
    clamped: false,
    ...over,
});

describe('postTimeText', () => {
    it('shows a timed note as its offset', () => {
        expect(postTimeText(entry())).toBe('10m');
    });

    it('marks an inferred offset with a tilde', () => {
        expect(postTimeText(entry({ inferred: true }))).toBe('~10m');
    });

    it('shows a tail note as its calendar date', () => {
        expect(postTimeText(entry({ tail: true, offset: null }))).toBe(
            new Date('2026-07-20T21:10:00.000Z').toLocaleDateString(),
        );
    });

    // A clamped reply was pulled below its parent, so its own stamp now reads
    // lower than the note above it. Blank beats a number that reads backwards;
    // the span still renders, so the alignment gutter survives.
    it('shows nothing for a reply that was pulled below its parent', () => {
        expect(postTimeText(entry({ clamped: true }))).toBe('');
    });
});

describe('postTimeTitle', () => {
    it('is the wall-clock time for an ordinary note', () => {
        expect(postTimeTitle(entry())).toBe(new Date('2026-07-20T21:10:00.000Z').toLocaleString());
    });

    // The chip is blank, so the stamp it would have shown moves into the title
    // rather than being lost.
    it('adds the suppressed stamp for a clamped reply', () => {
        expect(postTimeTitle(entry({ clamped: true }))).toContain('10m');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/frontend/post.test.js`
Expected: FAIL — `postTimeText is not a function`.

- [ ] **Step 3: Implement**

In `frontend/post.js`, extend the utils import to include `formatOffsetShort` (already imported) and add these two exports beside `accentClass`:

```js
// What a note's time chip reads. A clamped reply is blank: it was pulled below
// its parent (see orderPosts), so its own stamp now reads lower than the note
// directly above it, and a number that runs backwards down the column is worse
// than no number. The span is still rendered by Post, so the fixed-width gutter
// that lines every body up is untouched — this is a blank chip, not a missing
// one.
export function postTimeText(entry) {
    if (entry.clamped) return '';
    if (entry.tail) return new Date(entry.post.created_at).toLocaleDateString();
    return `${entry.inferred ? '~' : ''}${formatOffsetShort(entry.offset)}`;
}

// The chip's tooltip. A clamped reply's suppressed stamp moves in here rather
// than being lost outright: it is one hover away without being asserted in a
// column it would contradict.
export function postTimeTitle(entry) {
    const when = new Date(entry.post.created_at).toLocaleString();
    if (!entry.clamped || entry.offset == null) return when;
    return `${when} · stamped ${formatOffsetShort(entry.offset)}`;
}
```

Then replace the `.post-time` span in `Post`. `offset`, `inferred`, and `tail` are now read only by the two helpers above, and nothing else in `Post` touches them, so the destructure on line 423 narrows to:

```js
const { post } = entry;
```

and the span becomes:

```js
<span class="post-time" title=${postTimeTitle(entry)}>${postTimeText(entry)}</span>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/frontend/post.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full check suite and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/post.js test/frontend/post.test.js
git commit -m "feat: blank the time chip on a reply pulled below its parent"
```

---

### Task 7: The `±` adjust control

**Files:**

- Modify: `frontend/utils.js` (add `formatAdjust`), `frontend/discussion.js` (`SeasonView`, `EpisodeBoard`, `WatchTimer`), `frontend/styles.css`
- Test: `test/frontend/utils.test.js`

**Interfaces:**

- Consumes: `adjust_secs` on each episode (Task 4); the route from Task 3; `MAX_OFFSET_ADJUST_SECS` and the three-argument `sessionOffsetSecs` (Task 2).
- Produces: `formatAdjust(secs) → string` exported from `frontend/utils.js`.

- [ ] **Step 1: Write the failing test**

Add to `test/frontend/utils.test.js` (import `formatAdjust` alongside the existing imports):

```js
describe('formatAdjust', () => {
    it('shows no correction as a plus-minus zero', () => {
        expect(formatAdjust(0)).toBe('±0:00');
    });

    it('signs a forward correction', () => {
        expect(formatAdjust(45)).toBe('+0:45');
        expect(formatAdjust(75)).toBe('+1:15');
    });

    // U+2212, matching the −1m / −15s buttons rather than a hyphen.
    it('signs a backward correction with a real minus', () => {
        expect(formatAdjust(-45)).toBe('−0:45');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/frontend/utils.test.js -t formatAdjust`
Expected: FAIL — `formatAdjust is not a function`.

- [ ] **Step 3: Implement `formatAdjust`**

In `frontend/utils.js`, after `formatOffsetShort`:

```js
// A watch-timer correction as a signed m:ss — "+0:45", "−1:15", "±0:00". Unlike
// formatOffset this must show its sign and must not clamp: a backward
// correction is the common one (you started the timer before the recap), and
// hiding its sign would make the control unreadable. Uses U+2212 so it matches
// the −15s / −1m buttons beside it rather than sitting next to them as a
// hyphen.
export function formatAdjust(secs) {
    const total = Math.abs(Math.round(secs));
    const sign = secs === 0 ? '±' : secs < 0 ? '−' : '+';
    return `${sign}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/frontend/utils.test.js -t formatAdjust`
Expected: PASS.

- [ ] **Step 5: Wire the mutation through `SeasonView`**

In `frontend/discussion.js`, add beside the other mutations (after `setTimer`):

```js
// Absolute rather than a delta, matching the route: WatchTimer computes the
// new total from the value the server last sent, so a double-tap on a nudge
// cannot accumulate a correction nobody asked for.
const setOffsetAdjust = (episode, adjustSecs) =>
    mutate(() =>
        api(`/api/seasons/${seasonId}/episodes/${episode}/offset`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adjust_secs: adjustSecs }),
        }),
    );
```

Pass it to `EpisodeBoard` alongside the existing handlers:

```js
onTimer=${setTimer}
onOffsetAdjust=${setOffsetAdjust}
```

- [ ] **Step 6: Thread it through `EpisodeBoard`**

Add `onOffsetAdjust` to `EpisodeBoard`'s destructured props (after `onTimer`), and extend the `WatchTimer` element:

```js
html`<${WatchTimer}
    session=${ep.session}
    adjustSecs=${ep.adjust_secs ?? 0}
    serverSkewMs=${serverSkewMs}
    onAction=${(action) => onTimer(ep.episode, action)}
    onAdjust=${(secs) => onOffsetAdjust(ep.episode, secs)}
/>`;
```

- [ ] **Step 7: Rewrite `WatchTimer`**

Replace `WatchTimer` in `frontend/discussion.js` with:

```js
// The ticking chip. It re-derives the offset from the server's session every
// second rather than counting locally, so a pause, a reload, or a second device
// all land on the same number. It stops at the same three-hour staleness point
// the server uses (shared/session.js), because showing a number the server would
// refuse to stamp would be a promise the post cannot keep.
//
// The ± button opens a second row of nudges. Everyone watches separately, so
// timers drift by a constant shift — one person started before the "previously
// on", another skipped the recap — and one number corrects it. That number is
// applied on read, so a nudge also moves every note you have already posted on
// this episode, which is the point: you discover the drift by seeing your note
// land in the wrong place.
function WatchTimer({ session, adjustSecs, serverSkewMs, onAction, onAdjust }) {
    const [tick, setTick] = useState(0);
    // Local to the timer and deliberately not episode-scoped state up in
    // EpisodeBoard: the row belongs to this control, and nothing outside it
    // needs to know whether it is open.
    const [adjusting, setAdjusting] = useState(false);

    useEffect(() => {
        if (!session?.running_since) return;
        const id = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [session?.running_since]);

    const offset = sessionOffsetSecs(session, Date.now() + serverSkewMs, adjustSecs);
    // `tick` only exists to force this re-render each second.
    void tick;

    // Clamped here as well as server-side so a run of taps stops at the limit
    // instead of collecting a 400 banner per tap.
    const nudge = (delta) => {
        const next = Math.max(
            -MAX_OFFSET_ADJUST_SECS,
            Math.min(MAX_OFFSET_ADJUST_SECS, adjustSecs + delta),
        );
        if (next !== adjustSecs) onAdjust(next);
    };

    const chip =
        offset === null
            ? html`
                  ${session && html`<span class="timer-expired">timer expired</span>`}
                  <button class="timer-btn" onClick=${() => onAction('start')}>
                      Start watching
                  </button>
              `
            : html`
                  <span class=${'timer-chip' + (session.running_since ? ' running' : '')}>
                      ${session.running_since ? '▶' : '⏸'} ${formatOffset(offset)}
                  </span>
                  <button
                      class="timer-btn"
                      onClick=${() => onAction(session.running_since ? 'pause' : 'resume')}
                  >
                      ${session.running_since ? 'Pause' : 'Resume'}
                  </button>
                  <button class="timer-btn subtle" onClick=${() => onAction('start')}>
                      Restart
                  </button>
              `;

    return html`
        <div class="timer-stack">
            <div class="timer">
                ${chip}
                <button
                    class="timer-btn subtle"
                    aria-expanded=${adjusting}
                    title="Adjust this episode's timer"
                    aria-label="Adjust this episode's timer"
                    onClick=${() => setAdjusting((v) => !v)}
                >
                    <span aria-hidden="true">±</span>
                </button>
            </div>
            ${
                adjusting &&
                html`<div class="timer-adjust" role="group" aria-label="Timer adjustment">
                    <button class="timer-btn" onClick=${() => nudge(-60)}>−1m</button>
                    <button class="timer-btn" onClick=${() => nudge(-15)}>−15s</button>
                    <span class="timer-adjust-total">${formatAdjust(adjustSecs)}</span>
                    <button class="timer-btn" onClick=${() => nudge(15)}>+15s</button>
                    <button class="timer-btn" onClick=${() => nudge(60)}>+1m</button>
                    ${
                        adjustSecs !== 0 &&
                        html`<button class="timer-btn subtle" onClick=${() => onAdjust(0)}>
                            Reset
                        </button>`
                    }
                </div>`
            }
        </div>
    `;
}
```

The ± renders in both branches on purpose: the case the correction exists for is noticing days later that your notes sit in the wrong place, long after the session went stale and the chip fell back to "Start watching."

Update the imports at the top of `frontend/discussion.js`:

```js
import {
    seasonLabel,
    orderPosts,
    formatOffset,
    formatAdjust,
    quoteSnippet,
    bodyAfterPost,
} from './utils.js';
import { sessionOffsetSecs, MAX_OFFSET_ADJUST_SECS } from '../shared/session.js';
```

- [ ] **Step 8: Add the styles**

In `frontend/styles.css`, replace the `.timer` rule's `margin-left: auto` — the stack now owns the right-alignment — and add the new rules after `.timer-btn.subtle`:

```css
/* The timer and its optional adjustment row are one flex item in
   .episode-actions, not two: two would wrap apart from each other at narrow
   widths and put the nudges on the far side of the reveal button. */
.timer-stack {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.4rem;
    /* Pushes the whole timer to the right edge of .episode-actions — and keeps
       it there when the reveal button is gone and it is the only child. */
    margin-left: auto;
}

.timer-adjust {
    display: flex;
    align-items: center;
    gap: 0.35rem;
}

/* The running total, not a per-tap readout: the correction is stored state, so
   you need to see how far you have pushed yourself to know whether to undo it.
   Fixed width and tabular figures so the buttons either side hold still while
   the number changes under a finger. */
.timer-adjust-total {
    min-width: 3.5rem;
    font-variant-numeric: tabular-nums;
    font-size: 0.8rem;
    color: var(--text-subtle);
    text-align: center;
}
```

In the `@media (max-width: 640px)` block, add `.timer-adjust` to the existing `flex-wrap: wrap` group and correct its now-outdated comment:

```css
/* .timer holds a chip and up to three buttons, and .timer-adjust up to six
       controls at a 44px touch target — both wrap at phone widths, so this is
       load-bearing rather than the defensive rule it started as. */
.episode-head,
.season-view-head,
.timer,
.timer-adjust,
.sort-controls {
    flex-wrap: wrap;
}
```

- [ ] **Step 9: Verify by hand**

Run `npm run dev` and open a season. On an episode board: open ±, confirm the total reads `±0:00`, tap `+15s` twice and confirm it reads `+0:30` and that any note you have posted on that episode moves down the timeline by 30 seconds. Tap Reset and confirm both revert. Confirm the ± row also appears on an episode with no running timer. Narrow the window below 430px and confirm the rows wrap without overlapping the reveal button.

- [ ] **Step 10: Run the full check suite and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/utils.js frontend/discussion.js frontend/styles.css test/frontend/utils.test.js
git commit -m "feat: add a nudge control for correcting an episode's timer"
```

---

### Task 8: Documentation

**Files:**

- Modify: `README.md`, `CLAUDE.md`, `frontend/CLAUDE.md`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Update `README.md`**

Three edits:

1. In the watch-timer bullet (around line 37), add that a timer can be corrected after the fact, that the correction is a single per-episode number, and that it moves notes already posted.
2. In the reply bullet (around lines 44–45), amend "a reply keeps its own place on the watch-offset timeline" to note the one exception: it is never placed above the note it answers, and a reply that had to be pulled down shows no offset rather than one that reads backwards.
3. Add a row to the API table after the timer route:

```
| `PUT`    | `/api/seasons/:season_id/episodes/:episode/offset`  | Correct where this episode started for the caller (`{ adjust_secs }`, absolute, within ±3600); shifts every note they have posted on that episode |
```

4. Add `watch_offsets` to the schema section after `watch_sessions`, describing it as one revisable correction per `(user, season, episode)`, applied on read, deliberately outside `watch_sessions` because `start` zeroes that row.

- [ ] **Step 2: Update `CLAUDE.md`**

1. **Database Schema** — add a `watch_offsets` bullet after `watch_sessions`, with the "deliberately not a column on `watch_sessions`, because `start` zeroes it" reasoning and the "applied on read so `posts.offset_secs` keeps meaning what the timer read" reasoning.
2. **API Routes** — add the `PUT .../offset` entry after the timer route, recording that the value is absolute for the same reason the reactions route takes an explicit `on`, that zero deletes the row, that ±3600 is a 400, and that it deliberately requires no live session.
3. **API Routes** — amend the `GET .../discussion` entry: each post's `offset_secs` is the stored value plus its _author's_ correction for that episode, and each episode carries the caller's own `adjust_secs` for the live chip.
4. Add the known limit from the spec — one number is a constant shift, so a note written before you skipped a recap moves with the rest even though it was already right; accepted rather than solved, because the alternative is per-segment corrections.

- [ ] **Step 3: Update `frontend/CLAUDE.md`**

1. Amend the `orderPosts` bullet: a fourth rule now sits on top of the three cases — a reply's sort key is clamped to its parent's, using post id as the final tiebreaker so the reply lands immediately after, and including `tail` so a reply follows a stranded parent into the tail. Note that the lookup is through `reply_to.id` and that a locked or deleted parent clamps nothing.
2. Amend the reply/quote-block bullet, which currently says a reply "sits wherever its own watch offset places it on the shared timeline, same as any other note" — that is now true only up to the parent, and the bullet must say so or it contradicts the code.
3. Amend the watch-timer bullet: the ± control, that the correction is applied on read so it moves notes already posted, that it renders even with no live session, and that `adjusting` is local to `WatchTimer` rather than episode-scoped state in `EpisodeBoard`.
4. Note the blank time chip on a clamped reply, and that the span still renders so the `2.5rem` gutter survives.

- [ ] **Step 4: Verify and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add README.md CLAUDE.md frontend/CLAUDE.md
git commit -m "docs: document watch-timer corrections and reply ordering"
```

---

## Definition of Done

- [ ] `npm run build`, `npm test`, `npm run lint`, `npm run format:check` all pass.
- [ ] A correction survives `POST .../timer` with `action: "start"`.
- [ ] A correction moves the corrector's notes and nobody else's, on the named episode only.
- [ ] A reply never renders above its parent, in a chain, or across the tail boundary.
- [ ] A clamped reply's chip is blank and its stamp is in the tooltip.
- [ ] `README.md`, `CLAUDE.md`, and `frontend/CLAUDE.md` describe the new table, route, response fields, ordering rule, and the accepted mid-episode limitation.
