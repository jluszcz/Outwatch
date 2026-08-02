# What's New Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bell in the header showing which comments other people have left since you last checked, each line linking to the episode board it names.

**Architecture:** Comments are read live from `posts.created_at` — there is no event table — and grouped per person per episode per watching session. The only schema change is `feed_seen_at` on `user_emails`, keyed per individual so a shared column's two logins have separate badges. Two routes (`GET /api/feed`, `POST /api/feed/seen`) and one new frontend component (`frontend/feed.js`) split trigger-from-panel the way `PostMenu`/`PostMenuPanel` already is.

**Tech Stack:** Cloudflare Workers + Hono + D1 (SQLite) on the server; Preact + htm bundled by esbuild on the client; Vitest with `@cloudflare/vitest-pool-workers` for the Worker suites.

**Spec:** `docs/superpowers/specs/2026-08-02-whats-new-feed-design.md`

---

## Deviation from the spec — READ FIRST

The spec groups notes by **calendar day**. Implementing it surfaced a defect,
so this plan groups by a **6-hour gap between consecutive notes** instead.
Everything else follows the spec as approved.

**Why the spec's rule breaks.** `posts.created_at` is
`new Date().toISOString()` — always UTC. A calendar day is therefore a UTC day,
and UTC midnight falls at 8:00pm Eastern / 5:00pm Pacific — inside the evening
when someone actually watches an episode. A session running 7:30–8:30pm ET
straddles that boundary, so its notes split into two groups and the panel shows
`Alice commented on Season 45 Episode 3` twice with two timestamps. It looks
like a bug because it is one.

**Why the gap rule instead.** Notes by the same author on the same episode join
the same group while consecutive notes are at most 6 hours apart. It has no
timezone concept at all, so it is right for every viewer regardless of where
they are; it still separates the three-week-old note the spec's day rule was
introduced to separate; and it costs about ten lines. The spec dismissed a
session rule as "much harder to express in SQL" — true, and irrelevant here,
because Task 2 groups in JavaScript over rows the route has already fetched.

**The alternative, if you prefer the spec's literal rule:** group on
`toLocaleDateString('en-CA', { timeZone: 'America/New_York' })` rather than the
UTC date. That fixes the split too, but it hardcodes one timezone into a shared
board and still splits anyone watching past midnight local. The gap rule has
neither problem.

**Before starting Task 2, confirm this deviation with the user** and update the
spec's Grouping section to match whichever rule wins. The plan and the spec must
not be left disagreeing.

---

## Global Constraints

- **Never commit real names or email addresses.** Use only the standard placeholder cast: `Alice` (solo column), `Bob & Carol` and `Dave & Erin` (shared columns), emails `alice@example.com` and so on. See the Rules section of `CLAUDE.md`.
- **Do not edit `public/script.js`** — it is build output from `frontend/`.
- **Never use `--no-verify`** to bypass commit hooks.
- **Before every commit**, all four must pass: `npm run build`, `npm test`, `npm run lint`, `npm run format:check`. Run `npm run format` to fix formatting.
- **No note bodies in the feed**, in any response field, ever.
- **A feed line must never fire `POST .../reveal`** — see Task 6.
- Frontend tests are logic-only; there is no DOM suite. Pure helpers go in `frontend/utils.js` and are tested there.
- Worker tests authenticate with real signed tokens via `req(..., { email })` from `test/worker/access-token.js`.

## Constants

Defined once in `src/feed.js` (Task 2) and imported where needed:

| Constant            | Value                      | Meaning                       |
| ------------------- | -------------------------- | ----------------------------- |
| `FEED_WINDOW_MS`    | `30 * 24 * 60 * 60 * 1000` | How far back the feed reaches |
| `FEED_MAX_EVENTS`   | `10`                       | Groups returned in `events`   |
| `FEED_GROUP_GAP_MS` | `6 * 60 * 60 * 1000`       | Gap that ends a group         |

## File Structure

**Create:**

- `migrations/0009_feed_seen.sql` — the one schema change
- `src/feed.js` — `groupNotes` plus the three constants. Pure, no D1, no Hono, so it is unit-testable without HTTP.
- `test/worker/feed.test.js` — `groupNotes` unit tests and both routes' integration tests
- `frontend/feed.js` — `FeedBell` and `FeedPanel`

**Modify:**

- `src/index.js` — two routes, after the reveal route
- `frontend/utils.js` — `relativeTime`, `feedLine`, `parseHashRoute`
- `frontend/hooks.js` — `useHashRoute` returns `{ seasonId, episode }`
- `frontend/script.js` — destructure the route; pass `showFeed` to `Header`
- `frontend/board.js` — `Header` renders `FeedBell`
- `frontend/discussion.js` — `SeasonView` seeds `openEpisode` from the route
- `frontend/icons.js` — add the `bell` icon
- `frontend/styles.css` — bell, badge, panel, bottom sheet
- `test/worker/migrations.test.js`, `test/frontend/utils.test.js`
- `CLAUDE.md`, `frontend/CLAUDE.md`, `README.md`

---

### Task 1: The migration

**Files:**

- Create: `migrations/0009_feed_seen.sql`
- Modify: `test/worker/migrations.test.js` (append a new `describe`)
- Modify: `CLAUDE.md` (the `user_emails` bullet under Database Schema)

**Interfaces:**

- Consumes: nothing
- Produces: `user_emails.feed_seen_at TEXT` (nullable ISO-8601 UTC string, `NULL` = never checked)

- [ ] **Step 1: Write the failing test**

Append to `test/worker/migrations.test.js`:

```js
// Migration 0009. The column arrives by ALTER TABLE, which rewrites the stored
// CREATE statement, so sqlite_master records whether it applied. It sits on
// user_emails rather than users because reading the feed is something a person
// does with their own eyes — a shared column's two logins keep separate badges.
describe('feed seen marks', () => {
    it('adds a per-individual feed_seen_at to user_emails', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_emails'",
        ).first();
        expect(row.sql).toContain('feed_seen_at TEXT');
    });

    it('does not add the column to users', async () => {
        const row = await env.DB.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'",
        ).first();
        expect(row.sql).not.toContain('feed_seen_at');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: FAIL — `expected '...' to contain 'feed_seen_at TEXT'`

- [ ] **Step 3: Write the migration**

Create `migrations/0009_feed_seen.sql`:

```sql
-- When each individual last opened the what's-new bell. NULL means never, in
-- which case everything inside the feed's 30-day window counts unread.
--
-- On user_emails rather than users, and so keyed on the person rather than the
-- board column. A couple shares a column, a screen, and a watch timer, but not
-- a pair of eyes: Bob opening the bell must not clear Carol's badge. This is
-- the same split the rest of the schema draws — authorship and reactions are
-- per individual, everything about watching is per column.
--
-- There is deliberately no events table to go with it. The feed reads comments
-- from posts.created_at live, so a deleted note leaves the feed on its own and
-- no denormalized row can drift from the note it describes.
ALTER TABLE user_emails ADD COLUMN feed_seen_at TEXT;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: PASS. The pool applies `migrations/` automatically — no wrangler command is needed for tests.

- [ ] **Step 5: Update `CLAUDE.md`**

In the Database Schema section, replace the `user_emails` bullet with:

```markdown
- `user_emails` — `email` PK, `user_id`, `name` (added in `0006`, the individual's byline on a discussion note; `NULL` falls back to the column's `users.name`), `feed_seen_at` (added in `0009`, when this individual last opened the what's-new bell; `NULL` means never, and everything in the feed's window then counts unread — on this table rather than `users` so a shared column's two logins keep separate badges); maps each Access login email to a column (couples have two rows)
```

- [ ] **Step 6: Verify and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add migrations/0009_feed_seen.sql test/worker/migrations.test.js CLAUDE.md
git commit -m "feat: record when each individual last opened the feed

Keyed on user_emails rather than users: a couple shares a column, a screen,
and a watch timer, but not a pair of eyes, so Bob opening the bell must not
clear Carol's badge."
```

---

### Task 2: `groupNotes` — the grouping rule as a pure function

**Files:**

- Create: `src/feed.js`
- Create: `test/worker/feed.test.js`

**Interfaces:**

- Consumes: nothing
- Produces:
    - `FEED_WINDOW_MS`, `FEED_MAX_EVENTS`, `FEED_GROUP_GAP_MS` — numbers
    - `groupNotes(rows)` — takes rows ordered by `(author_key, season_id, episode, created_at ASC)`, each `{ author_key, author_email, user_id, season_id, episode, created_at }`; returns `[{ author_key, author_email, user_id, season_id, episode, at }]` where `at` is the group's newest `created_at`. Group order follows input order — the caller sorts.

**Confirm the deviation above with the user before starting this task.**

- [ ] **Step 1: Write the failing test**

Create `test/worker/feed.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { groupNotes, FEED_GROUP_GAP_MS } from '../../src/feed.js';

// A row as the feed query returns it. author_key is what the SQL computes:
// the lowercased email for an attributed note, 'user:<id>' for one written
// before authorship was recorded.
function row(overrides = {}) {
    return {
        author_key: 'alice@example.com',
        author_email: 'alice@example.com',
        user_id: 'user-alice',
        season_id: 45,
        episode: 3,
        created_at: '2026-08-02T00:00:00.000Z',
        ...overrides,
    };
}

// Named offsetAt rather than `at` so it does not shadow the `at` parameter the
// route tests below destructure.
const offsetAt = (ms) => new Date(Date.parse('2026-08-02T00:00:00.000Z') + ms).toISOString();

describe('groupNotes', () => {
    it('returns nothing for no rows', () => {
        expect(groupNotes([])).toEqual([]);
    });

    it('folds one sitting on one episode into a single group', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(10 * 60 * 1000) }),
            row({ created_at: offsetAt(40 * 60 * 1000) }),
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].season_id).toBe(45);
        expect(groups[0].episode).toBe(3);
    });

    it('stamps a group with its newest note', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(40 * 60 * 1000) }),
        ]);
        expect(groups[0].at).toBe(offsetAt(40 * 60 * 1000));
    });

    it('splits when consecutive notes are further apart than the gap', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(FEED_GROUP_GAP_MS + 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('keeps a note exactly on the gap in the same group', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(FEED_GROUP_GAP_MS) }),
        ]);
        expect(groups).toHaveLength(1);
    });

    // The reason the gap rule replaced a calendar-day rule: created_at is UTC,
    // and UTC midnight is 8pm Eastern, so an evening session straddles it.
    it('does not split an evening session that crosses UTC midnight', () => {
        const groups = groupNotes([
            row({ created_at: '2026-08-02T23:40:00.000Z' }),
            row({ created_at: '2026-08-03T00:20:00.000Z' }),
        ]);
        expect(groups).toHaveLength(1);
    });

    it('measures the gap from the previous note, not the group start', () => {
        const hour = 60 * 60 * 1000;
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(5 * hour) }),
            row({ created_at: offsetAt(10 * hour) }),
        ]);
        expect(groups).toHaveLength(1);
    });

    it('does not group two people together', () => {
        const groups = groupNotes([
            row({ author_key: 'alice@example.com', created_at: offsetAt(0) }),
            row({
                author_key: 'bob@example.com',
                author_email: 'bob@example.com',
                user_id: 'user-bob',
                created_at: offsetAt(60 * 1000),
            }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('does not group two episodes together', () => {
        const groups = groupNotes([
            row({ episode: 3, created_at: offsetAt(0) }),
            row({ episode: 4, created_at: offsetAt(60 * 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('does not group two seasons together', () => {
        const groups = groupNotes([
            row({ season_id: 45, created_at: offsetAt(0) }),
            row({ season_id: 46, created_at: offsetAt(60 * 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('carries the fields the byline is resolved from', () => {
        const groups = groupNotes([row()]);
        expect(groups[0].author_email).toBe('alice@example.com');
        expect(groups[0].user_id).toBe('user-alice');
    });

    it('never carries a note body', () => {
        const groups = groupNotes([{ ...row(), body: 'no way he played that idol' }]);
        expect(JSON.stringify(groups)).not.toContain('idol');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/worker/feed.test.js`
Expected: FAIL — cannot resolve `../../src/feed.js`

- [ ] **Step 3: Write the implementation**

Create `src/feed.js`:

```js
// How far back the feed reaches. Everything past this is gone from the panel
// and from the unread count alike, so the count can never name something the
// list has no way to show.
export const FEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// How many groups the panel gets. The unread count is deliberately not capped
// to match — see GET /api/feed.
export const FEED_MAX_EVENTS = 10;

// What ends a group: six hours between one note and the next. Notes by the same
// author on the same episode otherwise join the same line however many there
// are, because the line carries no count and two notes and five notes both mean
// go read the episode.
//
// This replaced a calendar-day rule, which was wrong for the app's main case.
// posts.created_at is always UTC, so a "day" boundary falls at 8pm Eastern —
// inside the evening someone watches an episode — and a session running
// 7:30-8:30pm ET split into two lines with two timestamps. A gap has no
// timezone in it at all, so it is right wherever the viewer is, while still
// separating a note left weeks later from the sitting that produced the rest.
export const FEED_GROUP_GAP_MS = 6 * 60 * 60 * 1000;

// Collapse a season's worth of notes into one line per person per episode per
// sitting.
//
// `rows` must arrive ordered by (author_key, season_id, episode, created_at
// ASC) — the query does that ordering, and this walk assumes it: a group only
// ever extends the row before it, so an out-of-order feed would silently
// produce more groups than it should rather than fail. Group order follows
// input order; the caller sorts by `at`.
export function groupNotes(rows) {
    const groups = [];
    let current = null;

    for (const row of rows) {
        const continues =
            current !== null &&
            current.author_key === row.author_key &&
            current.season_id === row.season_id &&
            current.episode === row.episode &&
            Date.parse(row.created_at) - Date.parse(current.at) <= FEED_GROUP_GAP_MS;

        if (continues) {
            // The rows are ascending, so the latest one seen is the newest.
            current.at = row.created_at;
            continue;
        }

        // Only the fields a byline and a link are built from. A body is never
        // copied across, which is what makes "the feed carries no bodies" a
        // property of this function rather than a promise the route has to keep.
        current = {
            author_key: row.author_key,
            author_email: row.author_email,
            user_id: row.user_id,
            season_id: row.season_id,
            episode: row.episode,
            at: row.created_at,
        };
        groups.push(current);
    }

    return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/worker/feed.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/feed.js test/worker/feed.test.js
git commit -m "feat: group feed notes by sitting rather than by calendar day

created_at is UTC, so a calendar day breaks at 8pm Eastern — inside the
evening someone watches an episode. A six-hour gap has no timezone in it, so
it is right wherever the viewer is while still separating a note left weeks
after the sitting that produced the rest."
```

---

### Task 3: `GET /api/feed`

**Files:**

- Modify: `src/index.js` (add after the reveal route, around line 676)
- Modify: `test/worker/feed.test.js` (append)
- Modify: `CLAUDE.md` (API Routes)

**Interfaces:**

- Consumes: `groupNotes`, `FEED_WINDOW_MS`, `FEED_MAX_EVENTS` from `src/feed.js`; existing `callerUser(c)` → `{ id, name, email }`, `rosterPeople(c)` → `{ byEmail, columnName }`, `attribute(post, people, me)` → `{ author_name, author_index, mine }`
- Produces: `GET /api/feed` → `{ now, unread_count, events: [{ author_name, season_id, episode, at, unread }] }`

- [ ] **Step 1: Write the failing test**

Append to `test/worker/feed.test.js`. First **replace** the existing vitest import line — do not add a second one, which ESLint's `no-duplicate-imports` rejects — and add three more below it:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/index.js';
import { accessEnv, signAccessToken, stubJwksEndpoint } from './access-token.js';
import { groupNotes, FEED_GROUP_GAP_MS } from '../../src/feed.js';
```

(The last line is the one already there from Task 2 — keep it, just make sure it sits below the new ones.)

Then append:

```js
const mockAssetsFetch = vi.fn().mockResolvedValue(new Response('index.html'));

function makeEnv(overrides = {}) {
    return {
        ...env,
        ...accessEnv,
        DEV_USER_EMAIL: undefined,
        ASSETS: { fetch: mockAssetsFetch },
        DB: env.DB,
        ...overrides,
    };
}

async function req(method, path, { body, email } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    if (email) init.headers['Cf-Access-Jwt-Assertion'] = await signAccessToken({ email });
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv());
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function addPost({
    user = 'user-alice',
    email = 'alice@example.com',
    season = 45,
    episode = 3,
    at,
}) {
    await env.DB.prepare(
        `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
         VALUES (?, ?, ?, 'no way he played that idol', ?, ?)`,
    )
        .bind(season, episode, user, at, email)
        .run();
}

describe('GET /api/feed', () => {
    beforeEach(async () => {
        await stubJwksEndpoint();
        await env.DB.exec('DELETE FROM reactions');
        await env.DB.exec('DELETE FROM posts');
        await env.DB.exec('DELETE FROM user_emails');
        await env.DB.exec('DELETE FROM users');
        await env.DB.exec('DELETE FROM seasons');
        await env.DB.exec(
            "INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1)",
        );
        await env.DB.exec(
            "INSERT INTO users (id, name, sort_order) VALUES ('user-bob', 'Bob & Carol', 2)",
        );
        await env.DB.exec(
            'INSERT INTO user_emails (email, user_id, name) VALUES ' +
                "('alice@example.com', 'user-alice', NULL), " +
                "('bob@example.com', 'user-bob', 'Bob'), " +
                "('carol@example.com', 'user-bob', 'Carol')",
        );
        await env.DB.exec(
            'INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES ' +
                "(45, '', 'https://en.wikipedia.org/wiki/Survivor_45', 13), " +
                "(46, '', 'https://en.wikipedia.org/wiki/Survivor_46', 13)",
        );
    });

    it('403s for a caller who is not on the roster', async () => {
        const res = await req('GET', '/api/feed', { email: 'nobody@example.com' });
        expect(res.status).toBe(403);
    });

    it('names another individual, their season, and their episode', async () => {
        await addPost({ at: ago(3 * 60 * 60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toHaveLength(1);
        expect(data.events[0]).toMatchObject({
            author_name: 'Alice',
            season_id: 45,
            episode: 3,
        });
    });

    it("excludes the caller's own notes", async () => {
        await addPost({ at: ago(60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'alice@example.com' });
        const data = await res.json();
        expect(data.events).toEqual([]);
        expect(data.unread_count).toBe(0);
    });

    // Bob and Carol share a column but are different people, and the byline is
    // already per individual — so Carol's note is news to Bob.
    it("shows a note by the other half of the caller's own column", async () => {
        await addPost({ user: 'user-bob', email: 'carol@example.com', at: ago(60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toHaveLength(1);
        expect(data.events[0].author_name).toBe('Carol');
    });

    it('bylines a note with no recorded author to its column', async () => {
        await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
             VALUES (45, 3, 'user-bob', 'old note', ?, NULL)`,
        )
            .bind(ago(60 * 1000))
            .run();
        const res = await req('GET', '/api/feed', { email: 'alice@example.com' });
        const data = await res.json();
        expect(data.events[0].author_name).toBe('Bob & Carol');
    });

    it("excludes an unattributed note written by the caller's own column", async () => {
        await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
             VALUES (45, 3, 'user-bob', 'old note', ?, NULL)`,
        )
            .bind(ago(60 * 1000))
            .run();
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toEqual([]);
    });

    it('drops notes older than the 30-day window', async () => {
        await addPost({ at: ago(31 * 24 * 60 * 60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toEqual([]);
    });

    it('orders events newest first', async () => {
        await addPost({ episode: 3, at: ago(5 * 60 * 60 * 1000) });
        await addPost({ episode: 4, at: ago(1 * 60 * 60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events.map((e) => e.episode)).toEqual([4, 3]);
    });

    it('returns at most ten events but counts every unread group', async () => {
        for (let episode = 1; episode <= 13; episode += 1) {
            await addPost({ episode, at: ago(episode * 60 * 60 * 1000) });
        }
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toHaveLength(10);
        expect(data.unread_count).toBe(13);
    });

    it('marks everything unread when the caller has never checked', async () => {
        await addPost({ at: ago(60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events[0].unread).toBe(true);
        expect(data.unread_count).toBe(1);
    });

    it('marks a group read once the caller has checked since it landed', async () => {
        await addPost({ at: ago(2 * 60 * 60 * 1000) });
        await env.DB.prepare('UPDATE user_emails SET feed_seen_at = ? WHERE email = ?')
            .bind(ago(60 * 60 * 1000), 'bob@example.com')
            .run();
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events[0].unread).toBe(false);
        expect(data.unread_count).toBe(0);
    });

    it('leaves a group unread for the partner who has not checked', async () => {
        await addPost({ at: ago(2 * 60 * 60 * 1000) });
        await env.DB.prepare('UPDATE user_emails SET feed_seen_at = ? WHERE email = ?')
            .bind(ago(60 * 60 * 1000), 'bob@example.com')
            .run();
        const res = await req('GET', '/api/feed', { email: 'carol@example.com' });
        const data = await res.json();
        expect(data.unread_count).toBe(1);
    });

    it('drops a deleted note from the feed', async () => {
        await addPost({ at: ago(60 * 1000) });
        await env.DB.exec('DELETE FROM posts');
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toEqual([]);
    });

    it('serializes no note body and no email', async () => {
        await addPost({ at: ago(60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const text = await res.text();
        expect(text).not.toContain('idol');
        expect(text).not.toContain('@example.com');
    });

    it('carries no per-group note count', async () => {
        await addPost({ at: ago(60 * 60 * 1000) });
        await addPost({ at: ago(30 * 60 * 1000) });
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(data.events).toHaveLength(1);
        expect(data.events[0].count).toBeUndefined();
    });

    it('echoes the server clock', async () => {
        const res = await req('GET', '/api/feed', { email: 'bob@example.com' });
        const data = await res.json();
        expect(Number.isNaN(Date.parse(data.now))).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/worker/feed.test.js`
Expected: FAIL — the route 404s, so `data.events` is undefined

- [ ] **Step 3: Write the route**

In `src/index.js`, extend the `src/feed.js` import at the top of the file (add it below the `shared/reactions.js` import):

```js
import { groupNotes, FEED_WINDOW_MS, FEED_MAX_EVENTS } from './feed.js';
```

Then add this route immediately after the reveal route:

```js
// What other people have said since you last looked.
//
// Read from posts rather than an event log, which is what makes a deleted note
// leave the feed on its own. The whole window is fetched and grouped in one
// pass rather than paged: a household board's 30 days is a few hundred rows,
// and one pass is what keeps the unread count and the ten shown groups from
// ever disagreeing about what a group is.
//
// The caller's own notes are excluded in SQL rather than after grouping, so the
// ten returned are ten they can actually act on. The test mirrors
// attribute()'s `mine` rule exactly: an attributed note is theirs when the
// email matches, an unattributed one when the column does.
app.get('/api/feed', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const nowMs = Date.now();
    const since = new Date(nowMs - FEED_WINDOW_MS).toISOString();

    const [{ results: rows }, people, seenRow] = await Promise.all([
        c.env.DB.prepare(
            `SELECT posts.season_id   AS season_id,
                    posts.episode     AS episode,
                    posts.user_id     AS user_id,
                    posts.author_email AS author_email,
                    posts.created_at  AS created_at,
                    COALESCE(LOWER(posts.author_email), 'user:' || posts.user_id) AS author_key
             FROM posts
             WHERE posts.created_at >= ?
               AND CASE WHEN posts.author_email IS NULL
                        THEN posts.user_id <> ?
                        ELSE LOWER(posts.author_email) <> ?
                   END
             ORDER BY author_key ASC, posts.season_id ASC, posts.episode ASC,
                      posts.created_at ASC`,
        )
            .bind(since, me.id, me.email)
            .all(),
        rosterPeople(c),
        c.env.DB.prepare('SELECT feed_seen_at FROM user_emails WHERE email = ?')
            .bind(me.email)
            .first(),
    ]);

    const seenAt = seenRow?.feed_seen_at ?? null;

    // Both sides are toISOString() output — fixed-length UTC — so a string
    // compare is a chronological one and needs no parsing.
    const groups = groupNotes(rows).map((group) => ({
        ...group,
        unread: seenAt === null || group.at > seenAt,
    }));

    // groupNotes returns them grouped by author; the panel wants them by time.
    groups.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    return c.json({
        now: new Date(nowMs).toISOString(),
        // Counts every unread group in the window, not only the ten shown, so
        // the badge can read higher than the list is long. Deliberate: the
        // panel has no second page, so a footer explaining the difference could
        // only name a number nobody can follow.
        unread_count: groups.filter((group) => group.unread).length,
        events: groups.slice(0, FEED_MAX_EVENTS).map((group) => ({
            // attribute() resolves the byline the same way the discussion route
            // does, so a note reads the same in the feed as on its board.
            author_name: attribute(group, people, me).author_name,
            season_id: group.season_id,
            episode: group.episode,
            at: group.at,
            unread: group.unread,
        })),
    });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/worker/feed.test.js`
Expected: PASS

- [ ] **Step 5: Update `CLAUDE.md`**

In the API Routes section, add after the reveal route bullet:

```markdown
- `GET /api/feed` — `{ now, unread_count, events }`; what other people have said recently. Each event is `{ author_name, season_id, episode, at, unread }` — one line per person per episode per sitting, where a sitting ends after `FEED_GROUP_GAP_MS` (6 hours, `src/feed.js`) without another note. Deliberately not a calendar day: `created_at` is UTC, so a day boundary falls at 8pm Eastern and split an evening session into two lines. Read live from `posts`, so a deleted note leaves the feed with no cleanup and no event log can drift from what it describes. At most `FEED_MAX_EVENTS` (10) groups from the past `FEED_WINDOW_MS` (30 days), newest first, regardless of read state — the panel shows recent activity rather than emptying as you read it. `unread_count` counts every unread group in the window rather than only the ten returned, so the badge can read higher than the list is long; there is no footer explaining the gap, because the panel has no second page to send anyone to. The caller's own notes are excluded, by the same individual-or-column rule `attribute()` uses for `mine`; a shared column's other half is _not_ excluded, since the byline is per individual and Carol's note is news to Bob. No note body and no email is ever serialized, and there is deliberately no per-group note count — nothing renders it, and a field the client ignores is a field that will drift.
- `POST /api/feed/seen` — stamps the caller's `user_emails.feed_seen_at` to the server's clock. No request body: the server uses its own time, so the route cannot backdate or forward-date a seen mark. Idempotent, per individual. Returns `{ feed_seen_at }`.
```

(The `POST` bullet is added here so the two read together; its route arrives in Task 4.)

- [ ] **Step 6: Verify and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/feed.test.js CLAUDE.md
git commit -m "feat: serve recent comments by other people as a feed

Read live from posts rather than an event log, so a deleted note leaves the
feed on its own. The caller's own notes are excluded in SQL rather than after
grouping, so the ten returned are ten they can act on — but a shared column's
other half is not, since the byline is per individual."
```

---

### Task 4: `POST /api/feed/seen`

**Files:**

- Modify: `src/index.js` (immediately after `GET /api/feed`)
- Modify: `test/worker/feed.test.js` (append a `describe`)

**Interfaces:**

- Consumes: `callerUser(c)`
- Produces: `POST /api/feed/seen` → `{ feed_seen_at }` (ISO string)

- [ ] **Step 1: Write the failing test**

Append to `test/worker/feed.test.js`, inside the same file and after the `GET /api/feed` describe. It reuses that block's `beforeEach` by nesting under the same top-level scope — copy the `beforeEach` body into this describe as well so the two are independent:

```js
describe('POST /api/feed/seen', () => {
    beforeEach(async () => {
        await stubJwksEndpoint();
        await env.DB.exec('DELETE FROM reactions');
        await env.DB.exec('DELETE FROM posts');
        await env.DB.exec('DELETE FROM user_emails');
        await env.DB.exec('DELETE FROM users');
        await env.DB.exec('DELETE FROM seasons');
        await env.DB.exec(
            "INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1)",
        );
        await env.DB.exec(
            "INSERT INTO users (id, name, sort_order) VALUES ('user-bob', 'Bob & Carol', 2)",
        );
        await env.DB.exec(
            'INSERT INTO user_emails (email, user_id, name) VALUES ' +
                "('alice@example.com', 'user-alice', NULL), " +
                "('bob@example.com', 'user-bob', 'Bob'), " +
                "('carol@example.com', 'user-bob', 'Carol')",
        );
        await env.DB.exec(
            'INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES ' +
                "(45, '', 'https://en.wikipedia.org/wiki/Survivor_45', 13)",
        );
    });

    it('403s for a caller who is not on the roster', async () => {
        const res = await req('POST', '/api/feed/seen', { email: 'nobody@example.com' });
        expect(res.status).toBe(403);
    });

    it('stamps the caller and returns the mark', async () => {
        const res = await req('POST', '/api/feed/seen', { email: 'bob@example.com' });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Number.isNaN(Date.parse(data.feed_seen_at))).toBe(false);

        const row = await env.DB.prepare('SELECT feed_seen_at FROM user_emails WHERE email = ?')
            .bind('bob@example.com')
            .first();
        expect(row.feed_seen_at).toBe(data.feed_seen_at);
    });

    it('leaves the other half of a shared column unmarked', async () => {
        await req('POST', '/api/feed/seen', { email: 'bob@example.com' });
        const row = await env.DB.prepare('SELECT feed_seen_at FROM user_emails WHERE email = ?')
            .bind('carol@example.com')
            .first();
        expect(row.feed_seen_at).toBeNull();
    });

    it('clears the unread count it was called to clear', async () => {
        await env.DB.prepare(
            `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
             VALUES (45, 3, 'user-alice', 'note', ?, 'alice@example.com')`,
        )
            .bind(new Date(Date.now() - 60 * 1000).toISOString())
            .run();

        const before = await (await req('GET', '/api/feed', { email: 'bob@example.com' })).json();
        expect(before.unread_count).toBe(1);

        await req('POST', '/api/feed/seen', { email: 'bob@example.com' });

        const after = await (await req('GET', '/api/feed', { email: 'bob@example.com' })).json();
        expect(after.unread_count).toBe(0);
        expect(after.events).toHaveLength(1);
    });

    it('is idempotent', async () => {
        const first = await (
            await req('POST', '/api/feed/seen', { email: 'bob@example.com' })
        ).json();
        const second = await (
            await req('POST', '/api/feed/seen', { email: 'bob@example.com' })
        ).json();
        expect(Date.parse(second.feed_seen_at)).toBeGreaterThanOrEqual(
            Date.parse(first.feed_seen_at),
        );
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/worker/feed.test.js -t "POST /api/feed/seen"`
Expected: FAIL — 404, so `data.feed_seen_at` is undefined

- [ ] **Step 3: Write the route**

In `src/index.js`, immediately after `GET /api/feed`:

```js
// Marks the feed read for the individual, not their column — the same reason
// feed_seen_at sits on user_emails.
//
// No request body on purpose. The stamp is the server's own clock, so a caller
// cannot backdate the mark to keep a badge lit or forward-date it to silence
// one. Idempotent: calling it twice just moves the mark forward.
app.post('/api/feed/seen', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const seenAt = new Date().toISOString();
    await c.env.DB.prepare('UPDATE user_emails SET feed_seen_at = ? WHERE email = ?')
        .bind(seenAt, me.email)
        .run();

    return c.json({ feed_seen_at: seenAt });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/worker/feed.test.js`
Expected: PASS

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/feed.test.js
git commit -m "feat: let a caller mark the feed read

No request body: the stamp is the server's clock, so nobody can backdate the
mark to keep a badge lit or forward-date it to silence one."
```

---

### Task 5: `relativeTime` and `feedLine`

**Files:**

- Modify: `frontend/utils.js` (append)
- Modify: `test/frontend/utils.test.js` (extend the import list, append tests)

**Interfaces:**

- Consumes: nothing
- Produces:
    - `relativeTime(iso, nowMs)` → string
    - `feedLine(event)` → string, where `event` is `{ author_name, season_id, episode }`

- [ ] **Step 1: Write the failing test**

Add `relativeTime` and `feedLine` to the import list at the top of `test/frontend/utils.test.js`, then append:

```js
// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z');
    const ago = (secs) => new Date(now - secs * 1000).toISOString();

    it('calls the present moment just now', () => {
        expect(relativeTime(ago(0), now)).toBe('just now');
    });

    it('still says just now at five minutes exactly', () => {
        expect(relativeTime(ago(300), now)).toBe('just now');
    });

    it('starts counting minutes just past five', () => {
        expect(relativeTime(ago(301), now)).toBe('5 minutes ago');
    });

    it('counts minutes up to the hour', () => {
        expect(relativeTime(ago(59 * 60), now)).toBe('59 minutes ago');
    });

    it('switches to hours at sixty minutes', () => {
        expect(relativeTime(ago(60 * 60), now)).toBe('1 hour ago');
    });

    it('truncates towards zero rather than rounding', () => {
        expect(relativeTime(ago(119 * 60), now)).toBe('1 hour ago');
    });

    it('pluralises hours', () => {
        expect(relativeTime(ago(3 * 60 * 60), now)).toBe('3 hours ago');
    });

    it('counts hours up to the day', () => {
        expect(relativeTime(ago(23 * 60 * 60 + 59 * 60), now)).toBe('23 hours ago');
    });

    it('switches to days at twenty-four hours', () => {
        expect(relativeTime(ago(24 * 60 * 60), now)).toBe('1 day ago');
    });

    it('pluralises days', () => {
        expect(relativeTime(ago(3 * 24 * 60 * 60), now)).toBe('3 days ago');
    });

    // A device clock running fast would otherwise produce "in 3 hours".
    it('clamps a future stamp to just now', () => {
        expect(relativeTime(new Date(now + 60 * 60 * 1000).toISOString(), now)).toBe('just now');
    });
});

// ---------------------------------------------------------------------------
// feedLine
// ---------------------------------------------------------------------------

describe('feedLine', () => {
    it('names the person, the season, and the episode', () => {
        expect(feedLine({ author_name: 'Alice', season_id: 45, episode: 3 })).toBe(
            'Alice commented on Season 45 Episode 3',
        );
    });

    // No count, however many notes the group holds: two and five both mean go
    // read the episode.
    it('says the same thing however many notes are behind it', () => {
        const one = feedLine({ author_name: 'Bob', season_id: 46, episode: 1 });
        expect(one).toBe('Bob commented on Season 46 Episode 1');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/frontend/utils.test.js`
Expected: FAIL — `relativeTime is not a function`

- [ ] **Step 3: Write the implementation**

Append to `frontend/utils.js`:

```js
// How long ago something happened, at the precision the feed actually claims.
//
// The five-minute floor is what keeps the panel from being wrong in its most
// visible case: a note that landed while you were reading the board reads
// "just now" instead of ticking through "1 minute ago". It also means the
// minutes tier never renders below five, so "1 minute ago" is unreachable and
// the singular only exists at the hours and days tiers.
//
// `nowMs` is the server's clock (GET /api/feed echoes one), not Date.now(), so
// a device with a wrong clock cannot age everything by a day. The clamp at zero
// covers the remaining skew in the other direction — a stamp from the near
// future reads "just now" rather than "in 3 hours".
export function relativeTime(iso, nowMs) {
    const secs = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
    if (secs <= 300) return 'just now';

    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins} minutes ago`;

    const hours = Math.floor(secs / 3600);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

    const days = Math.floor(secs / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

// One feed event as a sentence. Deliberately carries no note count — "Alice
// commented on Season 45 Episode 3" already implies one or more, and two notes
// and five notes both mean the same thing to whoever is reading it. The season
// subtitle is left out too: seasonLabel's full form is wider than the panel.
export function feedLine(event) {
    return `${event.author_name} commented on Season ${event.season_id} Episode ${event.episode}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/frontend/utils.test.js`
Expected: PASS

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/utils.js test/frontend/utils.test.js
git commit -m "feat: add the feed's relative time and line text

The five-minute floor on \"just now\" keeps a note that landed while you were
reading the board from ticking through a precision nothing else in the panel
claims — and puts \"1 minute ago\" out of reach entirely."
```

---

### Task 6: The episode route segment

**Files:**

- Modify: `frontend/utils.js` (append `parseHashRoute`)
- Modify: `frontend/hooks.js:141-159` (`useHashRoute`)
- Modify: `frontend/script.js` (destructure the route)
- Modify: `frontend/discussion.js` (`SeasonView` seeds `openEpisode`)
- Modify: `test/frontend/utils.test.js`

**Interfaces:**

- Consumes: nothing
- Produces:
    - `parseHashRoute(hash)` → `{ seasonId: number | null, episode: number | null }`
    - `useHashRoute()` → the same object, stable across a hashchange that does not change either value
    - `SeasonView` gains a `routeEpisode` prop (`number | null`)

- [ ] **Step 1: Write the failing test**

Add `parseHashRoute` to the import list in `test/frontend/utils.test.js`, then append:

```js
// ---------------------------------------------------------------------------
// parseHashRoute
// ---------------------------------------------------------------------------

describe('parseHashRoute', () => {
    it('reads a season', () => {
        expect(parseHashRoute('#/season/45')).toEqual({ seasonId: 45, episode: null });
    });

    it('reads a season and an episode', () => {
        expect(parseHashRoute('#/season/45/episode/3')).toEqual({ seasonId: 45, episode: 3 });
    });

    it('falls back to the board for an empty hash', () => {
        expect(parseHashRoute('')).toEqual({ seasonId: null, episode: null });
    });

    it('falls back to the board for an unrelated hash', () => {
        expect(parseHashRoute('#/settings')).toEqual({ seasonId: null, episode: null });
    });

    // Season 0 and episode 0 do not exist. Matching them would mount the view
    // and surface the API's raw validation error instead of showing the board.
    it('rejects a zero season', () => {
        expect(parseHashRoute('#/season/0')).toEqual({ seasonId: null, episode: null });
    });

    it('rejects a zero episode', () => {
        expect(parseHashRoute('#/season/45/episode/0')).toEqual({ seasonId: null, episode: null });
    });

    it('rejects a leading zero', () => {
        expect(parseHashRoute('#/season/045')).toEqual({ seasonId: null, episode: null });
    });

    it('rejects trailing junk', () => {
        expect(parseHashRoute('#/season/45/episode/3/x')).toEqual({
            seasonId: null,
            episode: null,
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/frontend/utils.test.js`
Expected: FAIL — `parseHashRoute is not a function`

- [ ] **Step 3: Write `parseHashRoute`**

Append to `frontend/utils.js`:

```js
// The app's whole routing table. Extracted from useHashRoute so the regex is
// testable on its own — the same split refresh-guard.js and submit-guard.js
// draw between a rule and the wiring around it.
//
// Both numbers carry the [1-9]\d* guard: no leading zeros and no bare 0. A "0"
// would otherwise match, mount the season view, and surface the API's raw
// "season_id must be a positive integer" instead of falling back to the board.
// An unparseable hash is the board, never a partial route.
export function parseHashRoute(hash) {
    const match = /^#\/season\/([1-9]\d*)(?:\/episode\/([1-9]\d*))?$/.exec(hash);
    if (!match) return { seasonId: null, episode: null };
    return { seasonId: Number(match[1]), episode: match[2] ? Number(match[2]) : null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/frontend/utils.test.js`
Expected: PASS

- [ ] **Step 5: Rewrite `useHashRoute`**

In `frontend/hooks.js`, add `parseHashRoute` to the imports:

```js
import { parseHashRoute } from './utils.js';
```

Replace the whole `useHashRoute` function (lines 141-159) with:

```js
export function useHashRoute() {
    const [route, setRoute] = useState(() => parseHashRoute(window.location.hash));

    useEffect(() => {
        const handler = () =>
            setRoute((current) => {
                const next = parseHashRoute(window.location.hash);
                // Returning the same object lets Preact bail out. Without this
                // every hashchange — including one that lands on the hash we
                // are already on — would be a new object and a re-render.
                return next.seasonId === current.seasonId && next.episode === current.episode
                    ? current
                    : next;
            });
        window.addEventListener('hashchange', handler);
        return () => window.removeEventListener('hashchange', handler);
    }, []);

    return route;
}
```

- [ ] **Step 6: Update `App`**

In `frontend/script.js`, replace line 19:

```js
const { seasonId: routeSeasonId, episode: routeEpisode } = useHashRoute();
```

and pass the episode to the view — replace the `SeasonView` render block (lines 184-188) with:

```js
${
    !loading &&
    routeSeasonId != null &&
    html`<${SeasonView}
        key=${routeSeasonId}
        seasonId=${routeSeasonId}
        routeEpisode=${routeEpisode}
    />`
}
```

Everything else in `App` already reads `routeSeasonId` and needs no change.

- [ ] **Step 7: Seed `openEpisode` in `SeasonView`**

In `frontend/discussion.js`, change the signature on line 21:

```js
export function SeasonView({ seasonId, routeEpisode }) {
```

and add this effect immediately after the `openEpisode` state declaration (line 28):

```js
// A feed line links straight at an episode, so the route can name one. An
// effect rather than a useState seed because SeasonView is keyed on the
// season: following a second link within the same season does not remount,
// so an initial value would never re-run.
//
// It must NOT reveal. Expanding a board and revealing it are separate
// actions here (onToggle vs onReveal) and have to stay that way — a reveal
// is permanent and one-way, and spending someone's reveal on a tap they
// made in a header panel is not something they can undo. Landing on a
// locked episode shows the locked board and its Reveal button, which is the
// right destination.
useEffect(() => {
    if (routeEpisode != null) setOpenEpisode(routeEpisode);
}, [routeEpisode]);
```

- [ ] **Step 8: Verify the reveal rule still holds**

Run: `grep -n "reveal(" frontend/discussion.js`
Expected: exactly one call site, the `onReveal` prop passed to `EpisodeBoard`. If there are two, a reveal has been wired to navigation and must be removed.

- [ ] **Step 9: Verify and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/utils.js frontend/hooks.js frontend/script.js frontend/discussion.js test/frontend/utils.test.js
git commit -m "feat: let a hash name an episode as well as a season

Seeding openEpisode from the route expands that board and nothing else — it
must never fire a reveal, which is permanent and one-way. Landing on a locked
episode shows the locked board and its Reveal button."
```

---

### Task 7: The bell and its panel

**Files:**

- Modify: `frontend/icons.js` (add `bell`)
- Create: `frontend/feed.js`
- Modify: `frontend/board.js` (`Header`)
- Modify: `frontend/script.js` (pass `showFeed`)

**Interfaces:**

- Consumes: `relativeTime`, `feedLine` (Task 5); `api` from `frontend/api.js`; `useRefreshGuard`, `useRefreshOnFocus`, `useIsDark` from `frontend/hooks.js`; `Icon` from `frontend/icons.js`
- Produces: `FeedBell()` — no props; `Header({ theme, onToggleTheme, showFeed })`

- [ ] **Step 1: Add the bell icon**

In `frontend/icons.js`, add to the `ICONS` object (path data from Bootstrap Icons v1.13.1, `bell.svg` and `bell-fill.svg`):

```js
    // bi-bell / bi-bell-fill — the what's-new trigger. The outline thins out
    // against a dark surface, so the fill variant is the dark-mode form, same
    // as bi-chat.
    bell: {
        outline: [
            'M8 16a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2M8 1.918l-.797.161A4 4 0 0 0 4 6c0 .628-.134 2.197-.459 3.742-.16.767-.376 1.566-.663 2.258h10.244c-.287-.692-.502-1.49-.663-2.258C12.134 8.197 12 6.628 12 6a4 4 0 0 0-3.203-3.92zM14.22 12c.223.447.481.801.78 1H1c.299-.199.557-.553.78-1C2.68 10.2 3 6.88 3 6c0-2.42 1.72-4.44 4.005-4.901a1 1 0 1 1 1.99 0A5 5 0 0 1 13 6c0 .88.32 4.2 1.22 6',
        ],
        fill: [
            'M8 16a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2m.995-14.901a1 1 0 1 0-1.99 0A5 5 0 0 0 3 6c0 1.098-.5 6-2 7h14c-1.5-1-2-5.902-2-7 0-2.42-1.72-4.44-4.005-4.901',
        ],
    },
```

- [ ] **Step 2: Write `frontend/feed.js`**

```js
import { h } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useRefreshGuard, useRefreshOnFocus, useIsDark } from './hooks.js';
import { relativeTime, feedLine } from './utils.js';
import { Icon } from './icons.js';

const html = htm.bind(h);

// The panel: the scrim, the list, and the phone layout's close button. Split
// out of FeedBell so its Escape listener and its scrim are subscribed only
// while it is open — the same split PostMenu/PostMenuPanel draws, for the same
// reason.
function FeedPanel({ data, error, onClose }) {
    const dark = useIsDark();
    const panelRef = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    // Focus into the panel so a keyboard user is not left behind on the trigger
    // with a list they cannot reach.
    useEffect(() => {
        panelRef.current?.querySelector('.feed-item, .feed-close')?.focus();
    }, []);

    const events = data?.events ?? [];
    const nowMs = data ? Date.parse(data.now) : Date.now();

    return html`
        <div class="feed-scrim" onClick=${onClose}></div>
        <div class="feed-panel" ref=${panelRef} role="group" aria-label="Recent activity">
            <button class="feed-close" onClick=${onClose} aria-label="Close">
                <${Icon} name="x" filled=${dark} />
            </button>
            ${
                error
                    ? html`<p class="feed-empty">Couldn't load activity.</p>`
                    : events.length === 0
                      ? html`<p class="feed-empty">Nothing new yet.</p>`
                      : html`
                            <ul class="feed-list">
                                ${events.map(
                                    (event) => html`
                                        <li
                                            key=${`${event.season_id}-${event.episode}-${event.at}`}
                                        >
                                            <a
                                                class=${'feed-item' + (event.unread ? ' unread' : '')}
                                                href=${`#/season/${event.season_id}/episode/${event.episode}`}
                                                onClick=${onClose}
                                            >
                                                <span class="feed-text">${feedLine(event)}</span>
                                                <span class="feed-when"
                                                    >${relativeTime(event.at, nowMs)}</span
                                                >
                                            </a>
                                        </li>
                                    `,
                                )}
                            </ul>
                        `
            }
        </div>
    `;
}

// The bell and its badge.
//
// Fetches through useRefreshGuard like every other fetch in the app, so a slow
// response cannot overwrite a newer one, and refetches on focus so the badge is
// right after the tab has been in the background.
export function FeedBell() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [open, setOpen] = useState(false);
    // Whether the badge has been cleared optimistically. Deliberately separate
    // from the per-event `unread` flags, which keep their marks until the next
    // fetch — otherwise every mark would vanish from under you at the moment
    // you opened the panel to read them.
    const [seen, setSeen] = useState(false);
    const dark = useIsDark();

    const fetchFeed = useCallback(() => api('/api/feed'), []);
    const applyFeed = useCallback((next) => {
        setData(next);
        setSeen(false);
    }, []);
    const { refresh } = useRefreshGuard(fetchFeed, applyFeed);
    useRefreshOnFocus(refresh, setError);

    useEffect(() => {
        refresh().catch((err) => setError(err.message));
    }, [refresh]);

    const openPanel = useCallback(async () => {
        setOpen(true);
        setSeen(true);
        try {
            await api('/api/feed/seen', { method: 'POST' });
        } catch {
            // Not worth a banner in the header: the badge coming back is the
            // whole story, and the next open retries it.
            setSeen(false);
        }
    }, []);

    const unread = seen ? 0 : (data?.unread_count ?? 0);
    const label = unread > 0 ? `What's new (${unread} unread)` : "What's new";

    return html`
        <div class="feed-wrap">
            <button
                class="feed-btn"
                aria-haspopup="true"
                aria-expanded=${open}
                aria-label=${label}
                title=${label}
                onClick=${() => (open ? setOpen(false) : openPanel())}
            >
                <${Icon} name="bell" filled=${dark} />
                ${unread > 0 ? html`<span class="feed-badge">${unread}</span>` : null}
            </button>
            ${open && html`<${FeedPanel} data=${data} error=${error} onClose=${() => setOpen(false)} />`}
        </div>
    `;
}
```

- [ ] **Step 3: Render it in `Header`**

In `frontend/board.js`, add the import at the top:

```js
import { FeedBell } from './feed.js';
```

and replace `Header` (lines 62-72) with:

```js
export function Header({ theme, onToggleTheme, showFeed }) {
    const title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    return html`
        <header class="header">
            <h1 class="title">Outwit, Outplay, Outlast, Outwatch</h1>
            <div class="header-actions">
                ${
                    // Only for someone on the roster: every feed route 403s for
                    // anyone else, so the bell would be a control that can only
                    // fail.
                    showFeed ? html`<${FeedBell} />` : null
                }
                <button class="theme-btn" title=${title} onClick=${onToggleTheme}>
                    ${theme === 'dark' ? html`<${SunIcon} />` : html`<${MoonIcon} />`}
                </button>
            </div>
        </header>
    `;
}
```

- [ ] **Step 4: Pass `showFeed` from `App`**

In `frontend/script.js`, replace the `Header` render (line 158):

```js
<${Header} theme=${theme} onToggleTheme=${toggleTheme} showFeed=${Boolean(meId)} />
```

- [ ] **Step 5: Verify the bundle builds**

Run: `npm run build`
Expected: no errors; `public/script.js` is written.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run lint && npm run format:check
git add frontend/icons.js frontend/feed.js frontend/board.js frontend/script.js
git commit -m "feat: add the what's-new bell to the header

The badge clears optimistically on open, but the per-event unread marks keep
their state until the next fetch — otherwise every mark would vanish from
under you at the moment you opened the panel to read them."
```

---

### Task 8: Styles

**Files:**

- Modify: `frontend/styles.css`

**Interfaces:**

- Consumes: the class names from Task 7 — `.feed-wrap`, `.feed-btn`, `.feed-badge`, `.feed-scrim`, `.feed-panel`, `.feed-close`, `.feed-list`, `.feed-item`, `.feed-item.unread`, `.feed-text`, `.feed-when`, `.feed-empty`, `.header-actions`
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the base rules**

Add near the existing `.post-menu` rules (after them, before the `max-width: 640px` block). **The mobile rules in Step 2 must come after every rule here** — media queries add no specificity, so a mobile rule placed ahead of a same-specificity base rule loses on source order and is silently dead.

```css
/* The header's controls as one row, so the bell and the theme toggle sit
   together rather than the bell pushing the title around. */
.header-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}

/* The positioning context the dropdown hangs off. Deliberately no z-index: no
   stacking context forms here, so the panel's z-index competes page-wide the
   way .post-menu's does. */
.feed-wrap {
    position: relative;
}

.feed-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--control-height);
    min-height: var(--control-height);
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    color: var(--text-subtle);
    cursor: pointer;
    anchor-name: --feed-anchor;
}

/* Rides the button's corner rather than sitting beside it, so a two-digit
   count cannot widen the header row. */
.feed-badge {
    position: absolute;
    top: -0.35rem;
    right: -0.35rem;
    min-width: 1.1rem;
    padding: 0 0.25rem;
    font-size: 0.7rem;
    line-height: 1.1rem;
    font-weight: 600;
    text-align: center;
    color: var(--on-accent);
    background: var(--accent);
    border-radius: 999px;
}

.feed-scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: transparent;
}

.feed-panel {
    position: absolute;
    top: 100%;
    right: 0;
    margin-block: 0.25rem;
    z-index: 21;
    width: min(22rem, calc(100vw - 2rem));
    max-height: 70vh;
    overflow-y: auto;
    padding: 0.35rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px var(--shadow);
}

/* Same call as .post-menu: let the browser measure. Gated behind @supports
   rather than layered as duplicate `top` declarations, since a minifier
   collapses two `top`s in one rule and drops the fallback. */
@supports (position-try-fallbacks: flip-block) {
    .feed-panel {
        position-anchor: --feed-anchor;
        top: anchor(bottom);
        right: anchor(right);
        position-try-fallbacks: flip-block;
    }
}

/* Hidden on a pointer device, where clicking off the dropdown already
   dismisses. The phone layout reveals it — see the mobile block. */
.feed-close {
    display: none;
}

.feed-list {
    list-style: none;
    margin: 0;
    padding: 0;
}

.feed-item {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.5rem 0.6rem;
    border-radius: 0.35rem;
    color: var(--text-subtle);
    text-decoration: none;
}

/* A dot in the leading gutter rather than a different background: the list
   should read as one list, with the unread ones marked inside it. */
.feed-item.unread {
    position: relative;
    color: var(--text);
    font-weight: 600;
}

.feed-item.unread::before {
    content: '';
    position: absolute;
    left: 0.15rem;
    top: 0.95rem;
    width: 0.35rem;
    height: 0.35rem;
    border-radius: 999px;
    background: var(--accent);
}

.feed-text {
    font-size: 0.9rem;
}

.feed-when {
    font-size: 0.75rem;
    color: var(--text-faint);
}

.feed-empty {
    margin: 0;
    padding: 1rem 0.6rem;
    text-align: center;
    font-size: 0.85rem;
    color: var(--text-faint);
}
```

- [ ] **Step 2: Add the phone layout**

Inside the existing `@media (max-width: 640px)` block, after the `.post-menu` rules:

```css
/* The same element as a bottom sheet. position: fixed escapes .feed-wrap
       because nothing between it and the root is transformed — the same escape
       .post-menu relies on. */
.feed-panel {
    position: fixed;
    inset: auto 0 0 0;
    /* Content-sized against the bottom edge, so it cannot overflow and has
           nothing to flip. */
    position-try-fallbacks: none;
    width: auto;
    max-height: 75vh;
    padding: 0.6rem 0.9rem 1.5rem;
    border-width: 1px 0 0;
    border-radius: 0.9rem 0.9rem 0 0;
    box-shadow: 0 -4px 16px var(--shadow);
}

.feed-scrim {
    background: light-dark(rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0.6));
}

/* Top-right, which is the furthest point in the sheet from the bottom edge
       iOS Safari's collapsed toolbar owns — a tap along that strip expands the
       toolbar rather than reaching the page. Same reasoning, and same negative
       margins, as .post-menu-close. */
.feed-close {
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: flex-end;
    margin: -0.4rem -0.5rem 0 auto;
    min-width: 44px;
    min-height: 44px;
    background: none;
    border: none;
    border-radius: 0.35rem;
    color: var(--text-faint);
    cursor: pointer;
}

.feed-item {
    padding: 0.7rem 0.6rem;
}

.feed-text {
    font-size: 1rem;
}
```

- [ ] **Step 3: Add the hover rules**

Inside the existing `@media (hover: hover)` block:

```css
.feed-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
}

.feed-item:hover {
    background: var(--surface-subtle);
}
```

- [ ] **Step 4: Check the token names actually exist**

Run: `grep -nE "\-\-(on-accent|accent|surface-subtle|border-strong|text-faint|text-subtle|control-height):" frontend/styles.css`
Expected: every token above appears. **If any does not, substitute the nearest existing token rather than inventing one** — check the `:root` block at the top of the file and match what `.post-menu-item` and `.timer-btn` already use.

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/styles.css
git commit -m "feat: style the feed bell, badge, and panel

Dropdown on a pointer device, bottom sheet below 640px, with the close button
in the sheet's top-right corner — the furthest point from the strip along the
bottom edge that iOS Safari's collapsed toolbar swallows taps in."
```

---

### Task 9: Documentation and final verification

**Files:**

- Modify: `frontend/CLAUDE.md`
- Modify: `README.md`
- Delete: `docs/superpowers/specs/2026-08-02-whats-new-feed-design.md`, `docs/superpowers/plans/2026-08-02-whats-new-feed.md`

**Interfaces:**

- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Add the frontend conventions**

Append to `frontend/CLAUDE.md`:

```markdown
- The what's-new bell (`frontend/feed.js`) is split `FeedBell` / `FeedPanel` the
  same way `PostMenu`/`PostMenuPanel` is: the trigger and its badge always
  render, while the scrim, the list, and the Escape listener mount only while
  the panel is open. It sits in `Header` beside the theme toggle rather than in
  either route's own view, so it is reachable from the board and from a season
  view alike — and it renders only when `showFeed` is true, since every feed
  route 403s for someone off the roster and the bell would otherwise be a
  control that can only fail. Two layouts, one DOM, following the rules
  `PostMenu` established: an anchored dropdown on a pointer device (with
  `position-try-fallbacks: flip-block` behind `@supports`) and a bottom sheet
  with a dimmed scrim below `640px`, its close button in the top-right corner
  for the same iOS-toolbar reason.
    - Opening the panel clears the badge optimistically and `POST`s
      `/api/feed/seen`, but the per-event `unread` marks are left alone: they
      come from the server's response and only move on the next fetch.
      Otherwise every mark would vanish from under you at the moment you opened
      the panel to read them. A failed `seen` restores the badge and raises no
      banner — the badge returning is the whole story, and the next open
      retries it.
    - The badge can read higher than the list is long, since `unread_count`
      covers the whole 30-day window and the list stops at ten. There is
      deliberately no "and N more" footer: the panel has no second page, so it
      could only name a number nobody can follow.
    - `relativeTime` (`utils.js`) computes against the server's `now` rather
      than `Date.now()`, so a device with a wrong clock cannot age the whole
      panel by a day, and it clamps a future stamp to "just now" rather than
      rendering "in 3 hours". Its five-minute floor means the minutes tier
      starts at five and `1 minute ago` is unreachable — the singular exists
      only at the hours and days tiers.
- The hash route (`parseHashRoute` in `utils.js`, wired by `useHashRoute`)
  understands `#/season/45` and `#/season/45/episode/3`. The parse is a pure
  function so the regex is testable — the same split `refresh-guard.js` and
  `submit-guard.js` draw. `useHashRoute` returns the _same object_ when a
  hashchange leaves both values alone, so Preact can bail out instead of
  re-rendering on every hash event.
    - `SeasonView` seeds `openEpisode` from `routeEpisode` in an effect rather
      than a `useState` initialiser, because the view is keyed on the season:
      following a second feed link within the same season does not remount.
    - **Arriving from a feed line expands the board and must never reveal it.**
      Expanding and revealing are separate handlers (`onToggle` vs `onReveal`)
      and have to stay that way — a reveal is permanent and one-way, and
      spending someone's reveal on a tap they made in a header panel is not
      something they can undo. Landing on a locked episode shows the locked
      board, its authors, and its Reveal button, which is the right
      destination. There is no DOM suite to assert this, so a reviewer should
      check that `reveal` in `discussion.js` still has exactly one call site.
```

- [ ] **Step 2: Add the README section**

Add to `README.md`, after the reactions section, matching its voice:

```markdown
### What's new

A bell in the header shows what the rest of the group has been saying. Each
line names one person, one episode, and how long ago — `Alice commented on
Season 45 Episode 3`, `3 hours ago` — and links straight to that episode's
board. A badge counts what has landed since you last opened it.

A person's notes on one episode in one sitting collapse to a single line, so a
lively night is one entry rather than twenty. The line carries no note count:
two notes and five notes both mean go read the episode. Nothing older than 30
days appears, and the panel shows the ten most recent entries whether or not
you have read them, so opening it on a quiet day still tells you what has been
going on.

The bell is per person rather than per column: both halves of a shared login
have their own badge, and each sees the other's notes, since the byline is per
individual too.

Following a line opens that episode's board — it does **not** reveal it. If you
have not watched the season or revealed the episode, you land on the locked
board with its Reveal button, and the notes stay hidden until you ask for them.
```

- [ ] **Step 3: Run the full check suite**

```bash
npm run build && npm test && npm run lint && npm run format:check
```

Expected: all four pass. Do not proceed past a failure.

- [ ] **Step 4: Exercise it by hand**

```bash
npm run dev
```

With `DEV_USER_EMAIL` set in `.dev.vars`, confirm each of these:

1. The bell appears in the header on the board and inside a season view.
2. With another user's note seeded in the last 30 days, the badge shows a count and the panel lists the line.
3. Opening the panel clears the badge but leaves the line's unread dot showing.
4. Reloading shows the line without its dot and no badge.
5. Clicking a line navigates to `#/season/N/episode/M` and expands that board.
6. Clicking a line for an episode you have **not** revealed lands on the locked board with its Reveal button, and no note bodies.
7. Below 640px (device toolbar) the panel is a bottom sheet with a scrim and a working close button.
8. Escape closes the panel.

- [ ] **Step 5: Remove the spec and the plan**

Both are finished work, and the repo's convention is to delete them once the feature lands (see commit `a549556`).

```bash
git rm docs/superpowers/specs/2026-08-02-whats-new-feed-design.md
git rm docs/superpowers/plans/2026-08-02-whats-new-feed.md
```

- [ ] **Step 6: Commit and open the PR**

```bash
git add frontend/CLAUDE.md README.md
git commit -m "docs: document the what's-new bell

Includes the rule with no test to hold it: arriving from a feed line expands
an episode board and must never reveal it, so reveal keeps its single call
site."
git push -u origin feed-notifications
gh pr create --title "Add a what's-new bell with a feed of recent comments" --body "$(cat <<'EOF'
A bell in the header lists what other people have said recently — one line per
person per episode per sitting, each linking straight at that episode's board.

Comments are read live from `posts.created_at` rather than an event log, so a
deleted note leaves the feed with no cleanup and nothing can drift from what it
describes. The only schema change is `feed_seen_at` on `user_emails`, keyed per
individual so a shared column's two logins keep separate badges.

Notes group by a six-hour gap rather than by calendar day: `created_at` is UTC,
so a day boundary falls at 8pm Eastern and split an evening session into two
lines with two timestamps.

Following a line expands that episode's board and deliberately does **not**
reveal it — a reveal is permanent and one-way, so landing on a locked episode
shows the locked board and its Reveal button instead.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section                                   | Task                                        |
| ---------------------------------------------- | ------------------------------------------- |
| Scope — comments only, own excluded            | 3                                           |
| `feed_seen_at` on `user_emails`                | 1                                           |
| No event table; deleted note leaves the feed   | 2, 3                                        |
| Grouping                                       | 2 (**deviates — see the top of this plan**) |
| Window 30 days, cap 10, NULL = all unread      | 2, 3                                        |
| `GET /api/feed` shape, no bodies, 403          | 3                                           |
| `POST /api/feed/seen`, no body, per individual | 4                                           |
| Disclosure — no new class of information       | 3 (tests assert no body, no email)          |
| `FeedBell`/`FeedPanel` split, header placement | 7                                           |
| Dropdown + bottom sheet                        | 8                                           |
| Badge optimistic, marks kept until refetch     | 7                                           |
| Line text, no count, unread dot, empty state   | 5, 7, 8                                     |
| No "and N more" footer                         | 7 (absent by construction)                  |
| `relativeTime` tiers                           | 5                                           |
| `parseHashRoute`, `useHashRoute`, seeding      | 6                                           |
| Arriving at a locked episode does not reveal   | 6 (step 8 check), 9                         |
| Docs                                           | 1, 3, 9                                     |

**Known gaps, accepted:**

- No DOM suite, so the panel's behaviour (opening, focus, Escape, the bottom sheet) is verified by hand in Task 9 Step 4, not in CI. This matches the rest of the frontend, whose phone layout is also verified ad hoc.
- The `reveal`-has-one-call-site rule is a grep in Task 6 and a note in `frontend/CLAUDE.md`, not an assertion.
