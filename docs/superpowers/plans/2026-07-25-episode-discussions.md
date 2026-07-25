# Per-Episode Discussion Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every episode of every Survivor season a discussion board that is write-only until the reader deliberately opens it, with an optional watch timer that lets posts written days apart sort into one synced timeline.

**Architecture:** Three new D1 tables (`posts`, `reveals`, `watch_sessions`) plus an `episode_count` column on `seasons`. A single server-side predicate decides whether a caller may read an episode's foreign post bodies; hidden bodies never leave the Worker. The frontend gains a hash-routed season view, and `frontend/script.js` is split into focused modules along seams that already exist.

**Tech Stack:** Cloudflare Workers, Hono, Zod, D1 (SQLite), Preact + htm, esbuild, Vitest with `@cloudflare/vitest-pool-workers`.

## Global Constraints

- **Never commit real names or email addresses.** Every committed file uses the fake placeholders already established in `roster.example.sql`: `user-N` ids, the names Alice / Bob / Carol / Dave / Erin, and `@example.com` emails.
- **Before every commit run all four checks and confirm they pass:** `npm run build`, `npm test`, `npm run lint`, `npm run format:check`. These are exactly what CI runs. A commit that fails any of them must not be made.
- Never use `--no-verify`. Never amend an existing commit. If a hook modifies files, restage and run a fresh `git commit`.
- Indentation is 4 spaces for JS and CSS, matching `.prettierrc`. Let Prettier settle formatting; do not hand-format.
- Tests use Vitest. Worker tests live in `test/worker/`, pure frontend logic tests in `test/frontend/`. Frontend tests import from `frontend/utils.js` directly and never touch the DOM.
- Work happens on branch `feat/episode-discussions`, which already exists and holds the design spec.
- The spec this implements is `docs/superpowers/specs/2026-07-25-episode-discussions-design.md`.

## File Structure

**Created:**

| Path                              | Responsibility                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `migrations/0005_discussions.sql` | `episode_count` column, its seeded values, and the three new tables                                                 |
| `shared/session.js`               | The single definition of the 3h staleness rule and the offset formula, imported by both the Worker and the frontend |
| `frontend/api.js`                 | The `api()` fetch helper, moved out of `script.js`                                                                  |
| `frontend/hooks.js`               | `useTheme` (moved), `useHashRoute` (new), `useRefreshGuard` (extracted)                                             |
| `frontend/board.js`               | `Header`, `NowWatching`, `SeasonRow`, `Board` — moved from `script.js`                                              |
| `frontend/discussion.js`          | `SeasonView`, `EpisodeBoard`, `PostList`, `PostForm`, `WatchTimer`                                                  |
| `test/worker/discussion.test.js`  | Every new API route, and the spoiler gate in particular                                                             |
| `test/worker/migrations.test.js`  | Guards the hand-transcribed `episode_count` data                                                                    |
| `test/frontend/posts.test.js`     | `orderPosts`, `formatOffset`, `episodeNumbers`                                                                      |

**Modified:**

| Path                     | Change                                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| `src/index.js`           | Five new routes plus `episode_count` and `post_count` on `GET /api/board` |
| `frontend/script.js`     | Reduced to `App` + routing; components move out                           |
| `frontend/utils.js`      | Gains `orderPosts`, `formatOffset`, `episodeNumbers`                      |
| `frontend/styles.css`    | Season-view, episode-card, post, and timer styles                         |
| `eslint.config.js`       | A `shared/**/*.js` block                                                  |
| `README.md`, `CLAUDE.md` | Structure, schema, routes, frontend notes                                 |

The spec's file list named four frontend modules; this plan adds `frontend/hooks.js` as a fifth. Hooks are a distinct responsibility from components, and three of them (`useTheme`, `useHashRoute`, `useRefreshGuard`) are shared across both views — leaving them in `script.js` would make it the thing every other module imports from.

---

### Task 1: Migration and episode counts

**Files:**

- Create: `migrations/0005_discussions.sql`
- Create: `test/worker/migrations.test.js`

**Interfaces:**

- Produces: tables `posts`, `reveals`, `watch_sessions`; column `seasons.episode_count`. Every later task depends on this schema.

- [ ] **Step 1: Write the failing test**

Create `test/worker/migrations.test.js`. This file deliberately does **not** delete from `seasons` — it reads the data the migrations seeded. `@cloudflare/vitest-pool-workers` isolates storage per test file, so the deletes in `index.test.js` cannot reach it.

```js
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

// The 50 episode counts in migration 0005 are transcribed by hand from Wikipedia
// and are the likeliest place in this feature for a quiet error. A dropped row
// leaves a 0; a slipped digit leaves a 130. Both are caught here.
describe('seeded episode counts', () => {
    it('gives all 50 seasons a plausible episode count', async () => {
        const { results } = await env.DB.prepare(
            'SELECT id, episode_count FROM seasons ORDER BY id ASC',
        ).all();
        expect(results).toHaveLength(50);
        for (const season of results) {
            expect(season.episode_count).toBeGreaterThanOrEqual(12);
            expect(season.episode_count).toBeLessThanOrEqual(17);
        }
    });

    it('has the new discussion tables', async () => {
        const { results } = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        ).all();
        const names = results.map((r) => r.name);
        expect(names).toContain('posts');
        expect(names).toContain('reveals');
        expect(names).toContain('watch_sessions');
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: FAIL — `no such column: episode_count`.

- [ ] **Step 3: Source the episode counts**

Fetch `https://en.wikipedia.org/wiki/List_of_Survivor_(American_TV_series)_episodes`. Its season overview table has one row per season with an **Episodes** column. Transcribe that column for seasons 1–50.

Two rules, applied consistently:

- **Exclude the reunion special.** Wikipedia lists it separately from the numbered episodes; it is not an episode for our purposes.
- **A two-hour premiere counts as the single episode Wikipedia lists**, not two.

If a season's row is ambiguous, open that season's own article and count the rows in its episode table. Do not guess — a wrong number here silently breaks episode validation for that whole season.

- [ ] **Step 4: Write the migration**

Create `migrations/0005_discussions.sql`. Replace the `UPDATE` block below with all 50 real values from Step 3; the two shown are illustrative of the shape only.

```sql
-- Per-episode discussion boards. Episodes are a validated integer rather than a
-- table: they carry no attribute beyond the number, so a row per episode would
-- hold no information.
ALTER TABLE seasons ADD COLUMN episode_count INTEGER NOT NULL DEFAULT 0;

-- Episode counts as listed in each season's Wikipedia episode table, excluding
-- the reunion special. A two-hour premiere counts as the one episode listed.
-- Source: en.wikipedia.org/wiki/List_of_Survivor_(American_TV_series)_episodes
UPDATE seasons SET episode_count = 13 WHERE id = 1;
UPDATE seasons SET episode_count = 16 WHERE id = 2;
-- … through id = 50

-- One row per note. offset_secs is the caller's accumulated watch time at the
-- moment of writing, frozen here and never recomputed; NULL when no live timer
-- was running.
CREATE TABLE posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id   INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    offset_secs INTEGER,
    FOREIGN KEY (season_id) REFERENCES seasons (id),
    FOREIGN KEY (user_id)   REFERENCES users (id)
);

CREATE INDEX idx_posts_board ON posts (season_id, episode, id);

-- Presence = "this user opened this episode's board for reading". One-way:
-- there is no re-lock, because you cannot unsee it anyway.
CREATE TABLE reveals (
    user_id    TEXT    NOT NULL,
    season_id  INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

-- A running or paused watch timer. elapsed_secs banks time from completed
-- segments; running_since marks the current one and is NULL while paused.
-- last_activity_at is touched by start, pause, resume, and posting — three
-- hours of silence ends the session.
CREATE TABLE watch_sessions (
    user_id          TEXT    NOT NULL,
    season_id        INTEGER NOT NULL,
    episode          INTEGER NOT NULL,
    elapsed_secs     INTEGER NOT NULL DEFAULT 0,
    running_since    TEXT,
    last_activity_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: PASS, both tests.

- [ ] **Step 6: Apply locally and spot-check**

```bash
npx wrangler d1 migrations apply outwatch --local
npx wrangler d1 execute outwatch --local --command "SELECT id, subtitle, episode_count FROM seasons WHERE id IN (1, 2, 20, 41, 50)"
```

Confirm the counts against your own knowledge of those seasons. This is the manual check the spec asks for.

- [ ] **Step 7: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add migrations/0005_discussions.sql test/worker/migrations.test.js
git commit -m "feat(db): add discussion tables and per-season episode counts"
```

---

### Task 2: The shared session rule

**Files:**

- Create: `shared/session.js`
- Modify: `eslint.config.js`
- Create: `test/frontend/session.test.js`

**Interfaces:**

- Produces:
    - `SESSION_IDLE_LIMIT_SECS: number` — `10800`
    - `sessionOffsetSecs(session, nowMs): number | null` where `session` is `{ elapsed_secs, running_since, last_activity_at } | null | undefined` and `nowMs` is a millisecond epoch. Returns `null` when there is no session or it has gone stale.

This lives in `shared/` because the Worker and the browser must agree on it exactly. The server uses it to stamp posts; the client uses it to render the ticking chip. If the two ever disagreed, the UI would show an offset the server would refuse to apply.

- [ ] **Step 1: Write the failing test**

Create `test/frontend/session.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { sessionOffsetSecs, SESSION_IDLE_LIMIT_SECS } from '../../shared/session.js';

const T0 = Date.parse('2026-07-25T21:00:00.000Z');
const at = (secs) => T0 + secs * 1000;
const iso = (secs) => new Date(at(secs)).toISOString();

describe('sessionOffsetSecs', () => {
    it('is null when there is no session', () => {
        expect(sessionOffsetSecs(null, T0)).toBeNull();
        expect(sessionOffsetSecs(undefined, T0)).toBeNull();
    });

    it('counts time since running_since for a fresh session', () => {
        const session = { elapsed_secs: 0, running_since: iso(0), last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(600))).toBe(600);
    });

    it('adds banked elapsed time to the running segment', () => {
        const session = { elapsed_secs: 1200, running_since: iso(300), last_activity_at: iso(300) };
        expect(sessionOffsetSecs(session, at(360))).toBe(1260);
    });

    it('freezes at the banked total while paused', () => {
        const session = { elapsed_secs: 1200, running_since: null, last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(60))).toBe(1200);
    });

    it('is null once three hours pass with no activity', () => {
        const session = { elapsed_secs: 600, running_since: iso(0), last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(SESSION_IDLE_LIMIT_SECS + 1))).toBeNull();
    });

    it('is still live exactly at the three hour boundary', () => {
        const session = { elapsed_secs: 600, running_since: null, last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(SESSION_IDLE_LIMIT_SECS))).toBe(600);
    });

    it('never returns a negative offset when clocks disagree', () => {
        const session = { elapsed_secs: 0, running_since: iso(30), last_activity_at: iso(30) };
        expect(sessionOffsetSecs(session, at(0))).toBe(0);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/frontend/session.test.js`
Expected: FAIL — cannot resolve `../../shared/session.js`.

- [ ] **Step 3: Write the implementation**

Create `shared/session.js`:

```js
// The watch-timer rule, shared by the Worker (which stamps posts) and the
// browser (which renders the ticking chip). Both must agree exactly: if the
// client kept counting past the point the server stops stamping, the UI would
// promise an offset that never lands on the post.

// Three hours without a start, pause, resume, or post ends a session. Without
// this a timer left running overnight would stamp the next morning's note
// +19:42:11 into an episode that ran 45 minutes.
export const SESSION_IDLE_LIMIT_SECS = 3 * 60 * 60;

// Accumulated watch time right now, or null when there is no live session.
// `nowMs` is a millisecond epoch so callers can pass the server clock rather
// than a possibly-skewed local one.
export function sessionOffsetSecs(session, nowMs) {
    if (!session) return null;

    const idleSecs = (nowMs - Date.parse(session.last_activity_at)) / 1000;
    if (idleSecs > SESSION_IDLE_LIMIT_SECS) return null;

    // Paused sessions bank their total in elapsed_secs and contribute no
    // running segment. Clamp the segment at zero so a skewed clock cannot wind
    // the timer backwards.
    const runningSecs = session.running_since
        ? Math.max(0, (nowMs - Date.parse(session.running_since)) / 1000)
        : 0;

    return Math.round(session.elapsed_secs + runningSecs);
}
```

- [ ] **Step 4: Teach ESLint about the new directory**

In `eslint.config.js`, add a block after the `src/**/*.js` one. The module runs in both the Worker and the browser, so it gets no environment globals — only the standard built-ins, which is exactly the constraint we want on shared code.

```js
    {
        files: ['shared/**/*.js'],
        languageOptions: { globals: {} },
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/frontend/session.test.js`
Expected: PASS, all seven tests.

- [ ] **Step 6: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add shared/session.js test/frontend/session.test.js eslint.config.js
git commit -m "feat(shared): add the watch-session offset and staleness rule"
```

---

### Task 3: POST a note to an episode

**Files:**

- Modify: `src/index.js`
- Create: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `sessionOffsetSecs` from Task 2; the schema from Task 1.
- Produces:
    - Route `POST /api/seasons/:season_id/episodes/:episode/posts` with body `{ body: string }`, returning 201 and `{ success: true, post: { id, season_id, episode, user_id, body, created_at, offset_secs } }`.
    - `resolveEpisode(c, seasonId, episodeParam)` → `{ season, episode } | { error, status }`, reused by Tasks 4, 5 and 6.

- [ ] **Step 1: Write the failing test**

Create `test/worker/discussion.test.js`. The header mirrors `test/worker/index.test.js` so the two read alike.

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/index.js';

const mockAssetsFetch = vi.fn().mockResolvedValue(new Response('index.html'));

function makeEnv(overrides = {}) {
    return {
        ...env,
        DEV_USER_EMAIL: undefined,
        ASSETS: { fetch: mockAssetsFetch },
        DB: env.DB,
        ...overrides,
    };
}

async function req(method, path, { body, email, envOverrides } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    if (email) init.headers['Cf-Access-Authenticated-User-Email'] = email;
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv(envOverrides));
}

// Children before parents — the new tables carry foreign keys into seasons and users.
beforeEach(async () => {
    await env.DB.exec('DELETE FROM watch_sessions');
    await env.DB.exec('DELETE FROM reveals');
    await env.DB.exec('DELETE FROM posts');
    await env.DB.exec('DELETE FROM watched');
    await env.DB.exec('DELETE FROM user_emails');
    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM seasons');
    await env.DB.exec("INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1)");
    await env.DB.exec(
        "INSERT INTO users (id, name, sort_order) VALUES ('user-bob', 'Bob & Carol', 2)",
    );
    await env.DB.exec(
        'INSERT INTO user_emails (email, user_id) VALUES ' +
            "('alice@example.com', 'user-alice'), " +
            "('bob@example.com', 'user-bob'), " +
            "('carol@example.com', 'user-bob')",
    );
    await env.DB.exec(
        'INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES ' +
            "(45, '', 'https://en.wikipedia.org/wiki/Survivor_45', 13)",
    );
});

describe('POST /api/seasons/:season_id/episodes/:episode/posts', () => {
    it('stores a note attributed to the caller', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'blindside was insane' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(201);
        const { post } = await r.json();
        expect(post).toMatchObject({
            season_id: 45,
            episode: 7,
            user_id: 'user-alice',
            body: 'blindside was insane',
            offset_secs: null,
        });
    });

    it('trims surrounding whitespace', async () => {
        const { post } = await (
            await req('POST', '/api/seasons/45/episodes/7/posts', {
                body: { body: '  spaced out  ' },
                email: 'alice@example.com',
            })
        ).json();
        expect(post.body).toBe('spaced out');
    });

    it('attributes to the caller, not a client-supplied id', async () => {
        const { post } = await (
            await req('POST', '/api/seasons/45/episodes/7/posts', {
                body: { body: 'note', user_id: 'user-bob' },
                email: 'alice@example.com',
            })
        ).json();
        expect(post.user_id).toBe('user-alice');
    });

    it('returns 400 for an empty or whitespace-only body', async () => {
        for (const body of ['', '   ']) {
            const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
                body: { body },
                email: 'alice@example.com',
            });
            expect(r.status).toBe(400);
        }
    });

    it('returns 400 for a body over 2000 characters', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'x'.repeat(2001) },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('accepts a body of exactly 2000 characters', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'x'.repeat(2000) },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(201);
    });

    it('returns 404 for episode 0 and for an episode past episode_count', async () => {
        for (const episode of [0, 14, 99]) {
            const r = await req(`POST`, `/api/seasons/45/episodes/${episode}/posts`, {
                body: { body: 'note' },
                email: 'alice@example.com',
            });
            expect(r.status).toBe(404);
        }
    });

    it('returns 400 for a non-numeric episode', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/abc/posts', {
            body: { body: 'note' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('returns 404 for an unknown season', async () => {
        const r = await req('POST', '/api/seasons/999/episodes/1/posts', {
            body: { body: 'note' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(404);
    });

    it('returns 403 with no identity and for a stranger', async () => {
        const anon = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'note' },
        });
        expect(anon.status).toBe(403);
        const stranger = await req('POST', '/api/seasons/45/episodes/7/posts', {
            body: { body: 'note' },
            email: 'stranger@example.com',
        });
        expect(stranger.status).toBe(403);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: FAIL — the route 404s with `Unknown API endpoint`.

- [ ] **Step 3: Write the implementation**

In `src/index.js`, add the import at the top:

```js
import { sessionOffsetSecs } from '../shared/session.js';
```

Add the schema beside the existing ones:

```js
const postCreate = z.object({
    body: z
        .string()
        .trim()
        .min(1, { message: 'body must not be empty' })
        .max(2000, { message: 'body must be at most 2000 characters' }),
});
```

Add the shared resolver above the routes. Every discussion route validates the same two path segments, and an episode is only meaningful against its season's `episode_count`:

```js
// Resolves and validates the :season_id / :episode path pair. Returns either
// { season, episode } or { error, status } for the caller to return directly.
// An episode number is meaningless without its season, so the two are checked
// together rather than by a route-level validator.
async function resolveEpisode(c) {
    const seasonId = Number(c.req.param('season_id'));
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
        return { error: 'season_id must be a positive integer', status: 400 };
    }

    const episode = Number(c.req.param('episode'));
    if (!Number.isInteger(episode) || episode <= 0) {
        return { error: 'episode must be a positive integer', status: 400 };
    }

    const season = await c.env.DB.prepare(
        'SELECT id, subtitle, wikipedia_url, episode_count FROM seasons WHERE id = ?',
    )
        .bind(seasonId)
        .first();
    if (!season) return { error: `Unknown season: ${seasonId}`, status: 404 };

    if (episode > season.episode_count) {
        return { error: `Season ${seasonId} has no episode ${episode}`, status: 404 };
    }

    return { season, episode };
}

// The caller's accumulated watch time for this episode, or null when no live
// timer is running. Read fresh on every post so the stamp reflects the session
// as it stands at write time.
async function currentOffsetSecs(c, userId, seasonId, episode, nowMs) {
    const session = await c.env.DB.prepare(
        `SELECT elapsed_secs, running_since, last_activity_at
         FROM watch_sessions
         WHERE user_id = ? AND season_id = ? AND episode = ?`,
    )
        .bind(userId, seasonId, episode)
        .first();
    return sessionOffsetSecs(session, nowMs);
}
```

Add the route, before the `app.all('/api/*', …)` catch-all:

```js
app.post(
    '/api/seasons/:season_id/episodes/:episode/posts',
    zValidator('json', postCreate, onInvalid),
    async (c) => {
        const me = await callerUser(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

        const resolved = await resolveEpisode(c);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { body } = c.req.valid('json');
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const offsetSecs = await currentOffsetSecs(c, me.id, season.id, episode, nowMs);

        // Writing a note is activity: it keeps a live session from going stale
        // mid-episode just because you were typing. The touch is a no-op when
        // there is no session row.
        const [inserted] = await c.env.DB.batch([
            c.env.DB.prepare(
                `INSERT INTO posts (season_id, episode, user_id, body, created_at, offset_secs)
                 VALUES (?, ?, ?, ?, ?, ?)
                 RETURNING id, season_id, episode, user_id, body, created_at, offset_secs`,
            ).bind(season.id, episode, me.id, body, now, offsetSecs),
            c.env.DB.prepare(
                `UPDATE watch_sessions SET last_activity_at = ?
                 WHERE user_id = ? AND season_id = ? AND episode = ?`,
            ).bind(now, me.id, season.id, episode),
        ]);

        return c.json({ success: true, post: inserted.results[0] }, 201);
    },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS, all eleven tests.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js
git commit -m "feat(api): add POST route for episode discussion notes"
```

---

### Task 4: GET the discussion, gated

This is the task that carries the feature's whole security property. Review it hardest.

**Files:**

- Modify: `src/index.js`
- Modify: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `resolveEpisode` from Task 3.
- Produces: `GET /api/seasons/:season_id/discussion`, returning:

```json
{
    "season": { "id": 45, "subtitle": "", "wikipedia_url": "…", "episode_count": 13 },
    "me": { "id": "user-alice", "name": "Alice" },
    "now": "2026-07-25T21:10:00.000Z",
    "episodes": [
        {
            "episode": 1,
            "readable": false,
            "count": 4,
            "authors": ["user-alice", "user-bob"],
            "posts": [],
            "session": null
        }
    ]
}
```

`count` and `authors` always describe everyone. `posts` holds everyone's when `readable`, and only the caller's otherwise. `session` is the caller's raw session row or `null`.

- [ ] **Step 1: Write the failing test**

Append to `test/worker/discussion.test.js`:

```js
const post = (email, episode, body) =>
    req('POST', `/api/seasons/45/episodes/${episode}/posts`, { body: { body }, email });

const discussion = (email) => req('GET', '/api/seasons/45/discussion', { email });

describe('GET /api/seasons/:season_id/discussion', () => {
    it('returns one entry per episode, in order', async () => {
        const { season, episodes } = await (await discussion('alice@example.com')).json();
        expect(season).toMatchObject({ id: 45, episode_count: 13 });
        expect(episodes).toHaveLength(13);
        expect(episodes.map((e) => e.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    });

    it('hides other people’s bodies on a locked board but reports count and authors', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await post('bob@example.com', 7, 'told you');
        await post('alice@example.com', 7, 'called it');

        const { episodes } = await (await discussion('alice@example.com')).json();
        const ep7 = episodes.find((e) => e.episode === 7);

        expect(ep7.readable).toBe(false);
        expect(ep7.count).toBe(3);
        expect(ep7.authors.sort()).toEqual(['user-alice', 'user-bob']);
        expect(ep7.posts).toHaveLength(1);
        expect(ep7.posts[0].body).toBe('called it');
    });

    it('leaks no hidden body anywhere in the serialized response', async () => {
        await post('bob@example.com', 7, 'SECRET-BLINDSIDE');
        const r = await discussion('alice@example.com');
        expect(await r.text()).not.toContain('SECRET-BLINDSIDE');
    });

    it('shows everything once the caller has watched the season', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await req('POST', '/api/watched', { body: { season_id: 45 }, email: 'alice@example.com' });

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.every((e) => e.readable)).toBe(true);
        const ep7 = episodes.find((e) => e.episode === 7);
        expect(ep7.posts.map((p) => p.body)).toEqual(['no way she flips']);
    });

    it('returns empty locked boards for a caller who is not on the roster', async () => {
        await post('alice@example.com', 7, 'called it');
        const { me, episodes } = await (await discussion('stranger@example.com')).json();
        expect(me).toBeNull();
        const ep7 = episodes.find((e) => e.episode === 7);
        expect(ep7.readable).toBe(false);
        expect(ep7.count).toBe(1);
        expect(ep7.posts).toEqual([]);
    });

    it('returns 404 for an unknown season', async () => {
        expect((await req('GET', '/api/seasons/999/discussion')).status).toBe(404);
    });

    it('returns 400 for a non-numeric season id', async () => {
        expect((await req('GET', '/api/seasons/abc/discussion')).status).toBe(400);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/worker/discussion.test.js -t 'GET /api/seasons'`
Expected: FAIL — route 404s.

- [ ] **Step 3: Write the implementation**

Add to `src/index.js`, before the catch-all:

```js
// The spoiler gate. An episode is readable when the caller has watched the whole
// season or has explicitly opened that episode. Everything else about the
// feature follows from this one predicate — and it is evaluated here, on the
// server, so a hidden body is never serialized at all.
app.get('/api/seasons/:season_id/discussion', async (c) => {
    const seasonId = Number(c.req.param('season_id'));
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
        return c.json({ error: 'season_id must be a positive integer' }, 400);
    }

    const season = await c.env.DB.prepare(
        'SELECT id, subtitle, wikipedia_url, episode_count FROM seasons WHERE id = ?',
    )
        .bind(seasonId)
        .first();
    if (!season) return c.json({ error: `Unknown season: ${seasonId}` }, 404);

    const me = await callerUser(c);

    const [{ results: posts }, watchedRow, { results: reveals }, { results: sessions }] =
        await Promise.all([
            c.env.DB.prepare(
                `SELECT id, episode, user_id, body, created_at, offset_secs
                 FROM posts WHERE season_id = ? ORDER BY episode ASC, id ASC`,
            )
                .bind(seasonId)
                .all(),
            me
                ? c.env.DB.prepare('SELECT 1 FROM watched WHERE user_id = ? AND season_id = ?')
                      .bind(me.id, seasonId)
                      .first()
                : null,
            me
                ? c.env.DB.prepare(
                      'SELECT episode FROM reveals WHERE user_id = ? AND season_id = ?',
                  )
                      .bind(me.id, seasonId)
                      .all()
                : { results: [] },
            me
                ? c.env.DB.prepare(
                      `SELECT episode, elapsed_secs, running_since, last_activity_at
                       FROM watch_sessions WHERE user_id = ? AND season_id = ?`,
                  )
                      .bind(me.id, seasonId)
                      .all()
                : { results: [] },
        ]);

    const watchedSeason = watchedRow != null;
    const revealed = new Set(reveals.map((r) => r.episode));
    const sessionByEpisode = new Map(sessions.map((s) => [s.episode, s]));

    const byEpisode = new Map();
    for (const p of posts) {
        if (!byEpisode.has(p.episode)) byEpisode.set(p.episode, []);
        byEpisode.get(p.episode).push(p);
    }

    const episodes = [];
    for (let episode = 1; episode <= season.episode_count; episode++) {
        const all = byEpisode.get(episode) ?? [];
        const readable = watchedSeason || revealed.has(episode);

        // Authors are named even on a locked board: the main board already shows
        // who has watched which season, so this reveals nothing new — and it
        // tells you whether opening the board is worth it.
        const authors = [...new Set(all.map((p) => p.user_id))];

        // The one line that matters. On a locked board only the caller's own
        // posts survive; nobody else's body reaches the response.
        const visible = readable ? all : all.filter((p) => me && p.user_id === me.id);

        const session = sessionByEpisode.get(episode) ?? null;
        episodes.push({
            episode,
            readable,
            count: all.length,
            authors,
            posts: visible.map((p) => ({
                id: p.id,
                user_id: p.user_id,
                body: p.body,
                created_at: p.created_at,
                offset_secs: p.offset_secs,
            })),
            session: session
                ? {
                      elapsed_secs: session.elapsed_secs,
                      running_since: session.running_since,
                      last_activity_at: session.last_activity_at,
                  }
                : null,
        });
    }

    return c.json({
        season,
        me: me ? { id: me.id, name: me.name } : null,
        // The server clock, so a device with a skewed one still renders a
        // correct ticking timer.
        now: new Date().toISOString(),
        episodes,
    });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS, all eighteen tests.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js
git commit -m "feat(api): add gated GET route for a season's discussion"
```

---

### Task 5: Reveal an episode

**Files:**

- Modify: `src/index.js`
- Modify: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `resolveEpisode` from Task 3; `GET …/discussion` from Task 4.
- Produces: `POST /api/seasons/:season_id/episodes/:episode/reveal` → 200 `{ success: true, season_id, episode }`.

- [ ] **Step 1: Write the failing test**

Append to `test/worker/discussion.test.js`:

```js
const reveal = (email, episode) =>
    req('POST', `/api/seasons/45/episodes/${episode}/reveal`, { email });

describe('POST /api/seasons/:season_id/episodes/:episode/reveal', () => {
    it('opens that episode and leaves the others locked', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await post('bob@example.com', 8, 'still reeling');

        expect((await reveal('alice@example.com', 7)).status).toBe(200);

        const { episodes } = await (await discussion('alice@example.com')).json();
        const ep7 = episodes.find((e) => e.episode === 7);
        const ep8 = episodes.find((e) => e.episode === 8);
        expect(ep7.readable).toBe(true);
        expect(ep7.posts.map((p) => p.body)).toEqual(['no way she flips']);
        expect(ep8.readable).toBe(false);
        expect(ep8.posts).toEqual([]);
    });

    it('is idempotent', async () => {
        await reveal('alice@example.com', 7);
        expect((await reveal('alice@example.com', 7)).status).toBe(200);
        const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM reveals').first();
        expect(row.count).toBe(1);
    });

    it('reveals only for the caller', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await reveal('alice@example.com', 7);
        const { episodes } = await (await discussion('bob@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).readable).toBe(false);
    });

    it('survives un-marking the season as watched', async () => {
        await post('bob@example.com', 7, 'no way she flips');
        await reveal('alice@example.com', 7);
        await req('POST', '/api/watched', { body: { season_id: 45 }, email: 'alice@example.com' });
        await req('DELETE', '/api/watched/45', { email: 'alice@example.com' });

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).readable).toBe(true);
        expect(episodes.find((e) => e.episode === 8).readable).toBe(false);
    });

    it('returns 404 for an episode past episode_count and 403 for a stranger', async () => {
        expect((await reveal('alice@example.com', 14)).status).toBe(404);
        expect((await reveal('stranger@example.com', 7)).status).toBe(403);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/worker/discussion.test.js -t 'reveal'`
Expected: FAIL — route 404s.

- [ ] **Step 3: Write the implementation**

```js
// Opening an episode for reading is one-way and idempotent — there is no
// re-lock, because you cannot unsee it. Reveals are stored independently of
// `watched`, so un-marking a season (usually a mis-click correction) does not
// take back an episode you have already read.
app.post('/api/seasons/:season_id/episodes/:episode/reveal', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const resolved = await resolveEpisode(c);
    if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
    const { season, episode } = resolved;

    await c.env.DB.prepare(
        `INSERT OR IGNORE INTO reveals (user_id, season_id, episode, created_at)
         VALUES (?, ?, ?, ?)`,
    )
        .bind(me.id, season.id, episode, new Date().toISOString())
        .run();

    return c.json({ success: true, season_id: season.id, episode });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js
git commit -m "feat(api): add reveal route to open an episode board for reading"
```

---

### Task 6: Delete your own note

**Files:**

- Modify: `src/index.js`
- Modify: `test/worker/discussion.test.js`

**Interfaces:**

- Produces: `DELETE /api/posts/:post_id` → 200 `{ success: true, post_id }`, or 404.

- [ ] **Step 1: Write the failing test**

Append to `test/worker/discussion.test.js`:

```js
describe('DELETE /api/posts/:post_id', () => {
    it('removes your own note', async () => {
        const { post: mine } = await (await post('alice@example.com', 7, 'called it')).json();
        const r = await req('DELETE', `/api/posts/${mine.id}`, { email: 'alice@example.com' });
        expect(r.status).toBe(200);

        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).count).toBe(0);
    });

    it('refuses someone else’s note and leaves it intact', async () => {
        const { post: theirs } = await (
            await post('bob@example.com', 7, 'no way she flips')
        ).json();
        const r = await req('DELETE', `/api/posts/${theirs.id}`, { email: 'alice@example.com' });
        expect(r.status).toBe(404);

        const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM posts').first();
        expect(row.count).toBe(1);
    });

    it('returns the same 404 for a note that does not exist', async () => {
        // Deliberately indistinguishable from the not-yours case: a distinct
        // status would let anyone probe for which post ids are real.
        const r = await req('DELETE', '/api/posts/999999', { email: 'alice@example.com' });
        expect(r.status).toBe(404);
    });

    it('lets either partner of a shared column delete the column’s note', async () => {
        const { post: theirs } = await (await post('bob@example.com', 7, 'ours')).json();
        const r = await req('DELETE', `/api/posts/${theirs.id}`, { email: 'carol@example.com' });
        expect(r.status).toBe(200);
    });

    it('returns 400 for a non-numeric id and 403 with no identity', async () => {
        expect((await req('DELETE', '/api/posts/abc', { email: 'alice@example.com' })).status).toBe(
            400,
        );
        expect((await req('DELETE', '/api/posts/1')).status).toBe(403);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/worker/discussion.test.js -t 'DELETE /api/posts'`
Expected: FAIL — route 404s with `Unknown API endpoint`.

- [ ] **Step 3: Write the implementation**

```js
// Deleting a note you do not own and deleting one that never existed return the
// same 404 — a distinct "forbidden" would turn this route into an oracle for
// which post ids are real.
app.delete('/api/posts/:post_id', async (c) => {
    const me = await callerUser(c);
    if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

    const postId = Number(c.req.param('post_id'));
    if (!Number.isInteger(postId) || postId <= 0) {
        return c.json({ error: 'post_id must be a positive integer' }, 400);
    }

    const { meta } = await c.env.DB.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?')
        .bind(postId, me.id)
        .run();
    if (meta.changes === 0) return c.json({ error: 'Unknown post' }, 404);

    return c.json({ success: true, post_id: postId });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js
git commit -m "feat(api): let a user delete their own discussion note"
```

---

### Task 7: The watch timer

**Files:**

- Modify: `src/index.js`
- Modify: `test/worker/discussion.test.js`

**Interfaces:**

- Consumes: `resolveEpisode`, `currentOffsetSecs` from Task 3; `sessionOffsetSecs` from Task 2.
- Produces: `POST /api/seasons/:season_id/episodes/:episode/timer` with body `{ action: 'start' | 'pause' | 'resume' }`, returning 200 `{ success: true, season_id, episode, session: { elapsed_secs, running_since, last_activity_at }, offset_secs }`.

- [ ] **Step 1: Write the failing test**

Append to `test/worker/discussion.test.js`. The staleness case seeds `last_activity_at` in the past directly, which is why no clock abstraction is needed anywhere in the Worker.

```js
const timer = (email, episode, action) =>
    req('POST', `/api/seasons/45/episodes/${episode}/timer`, { body: { action }, email });

describe('POST /api/seasons/:season_id/episodes/:episode/timer', () => {
    it('starts a running session at zero', async () => {
        const r = await timer('alice@example.com', 7, 'start');
        expect(r.status).toBe(200);
        const { session, offset_secs } = await r.json();
        expect(session.elapsed_secs).toBe(0);
        expect(session.running_since).not.toBeNull();
        expect(offset_secs).toBeLessThan(5);
    });

    it('stamps a note posted while the timer runs', async () => {
        await timer('alice@example.com', 7, 'start');
        const { post: note } = await (await post('alice@example.com', 7, 'called it')).json();
        expect(note.offset_secs).not.toBeNull();
        expect(note.offset_secs).toBeLessThan(5);
    });

    it('banks elapsed time on pause and freezes the offset', async () => {
        await env.DB.exec(
            'INSERT INTO watch_sessions (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at) ' +
                "VALUES ('user-alice', 45, 7, 0, '2026-07-25T21:00:00.000Z', '2026-07-25T21:00:00.000Z')",
        );
        // Rewrite running_since to a known 600s ago so the banked total is exact.
        const since = new Date(Date.now() - 600_000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET running_since = ?, last_activity_at = ?')
            .bind(since, since)
            .run();

        const { session } = await (await timer('alice@example.com', 7, 'pause')).json();
        expect(session.running_since).toBeNull();
        expect(session.elapsed_secs).toBeGreaterThanOrEqual(600);
        expect(session.elapsed_secs).toBeLessThan(610);
    });

    it('carries the frozen offset onto a note written while paused', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare(
            'UPDATE watch_sessions SET elapsed_secs = 900, running_since = NULL',
        ).run();
        const { post: note } = await (await post('alice@example.com', 7, 'paused to type')).json();
        expect(note.offset_secs).toBe(900);
    });

    it('continues from the banked total on resume', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare(
            'UPDATE watch_sessions SET elapsed_secs = 900, running_since = NULL',
        ).run();
        const { session, offset_secs } = await (
            await timer('alice@example.com', 7, 'resume')
        ).json();
        expect(session.elapsed_secs).toBe(900);
        expect(session.running_since).not.toBeNull();
        expect(offset_secs).toBeGreaterThanOrEqual(900);
        expect(offset_secs).toBeLessThan(905);
    });

    it('zeroes the session when started again', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare('UPDATE watch_sessions SET elapsed_secs = 900').run();
        const { session } = await (await timer('alice@example.com', 7, 'start')).json();
        expect(session.elapsed_secs).toBe(0);
    });

    it('leaves a note untimed once the session has been idle three hours', async () => {
        await timer('alice@example.com', 7, 'start');
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET running_since = ?, last_activity_at = ?')
            .bind(stale, stale)
            .run();

        const { post: note } = await (await post('alice@example.com', 7, 'next morning')).json();
        expect(note.offset_secs).toBeNull();
    });

    it('keeps a session live across a post', async () => {
        await timer('alice@example.com', 7, 'start');
        const nearly = new Date(Date.now() - 2.9 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET last_activity_at = ?').bind(nearly).run();
        await post('alice@example.com', 7, 'still here');

        const row = await env.DB.prepare(
            'SELECT last_activity_at FROM watch_sessions WHERE user_id = ?',
        )
            .bind('user-alice')
            .first();
        expect(Date.parse(row.last_activity_at)).toBeGreaterThan(Date.parse(nearly));
    });

    it('keeps sessions per episode and per user', async () => {
        await timer('alice@example.com', 7, 'start');
        const { episodes } = await (await discussion('alice@example.com')).json();
        expect(episodes.find((e) => e.episode === 7).session).not.toBeNull();
        expect(episodes.find((e) => e.episode === 8).session).toBeNull();

        const bob = await (await discussion('bob@example.com')).json();
        expect(bob.episodes.find((e) => e.episode === 7).session).toBeNull();
    });

    it('returns 400 for an unknown action and 403 for a stranger', async () => {
        expect((await timer('alice@example.com', 7, 'stop')).status).toBe(400);
        expect((await timer('stranger@example.com', 7, 'start')).status).toBe(403);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/worker/discussion.test.js -t 'timer'`
Expected: FAIL — route 404s.

- [ ] **Step 3: Write the implementation**

Add the schema beside the others:

```js
const timerAction = z.object({
    action: z.enum(['start', 'pause', 'resume'], {
        message: 'action must be start, pause, or resume',
    }),
});
```

Add the route:

```js
// The watch timer. There is no stop action: a session simply goes stale after
// three hours without a start, pause, resume, or post (see shared/session.js).
// Sessions are per (user, episode) and deliberately not mutually exclusive —
// a forgotten one on another episode is harmless, because offsets freeze onto
// the post at write time and the stale session stamps nothing.
app.post(
    '/api/seasons/:season_id/episodes/:episode/timer',
    zValidator('json', timerAction, onInvalid),
    async (c) => {
        const me = await callerUser(c);
        if (!me) return c.json({ error: 'Your account is not on the watch list' }, 403);

        const resolved = await resolveEpisode(c);
        if (resolved.error) return c.json({ error: resolved.error }, resolved.status);
        const { season, episode } = resolved;

        const { action } = c.req.valid('json');
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const key = [me.id, season.id, episode];

        if (action === 'start') {
            // Starting again zeroes the session — it is the "I'm beginning this
            // episode" action, not a resume.
            await c.env.DB.prepare(
                `INSERT INTO watch_sessions
                     (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at)
                 VALUES (?, ?, ?, 0, ?, ?)
                 ON CONFLICT (user_id, season_id, episode) DO UPDATE SET
                     elapsed_secs = 0, running_since = excluded.running_since,
                     last_activity_at = excluded.last_activity_at`,
            )
                .bind(...key, now, now)
                .run();
        } else if (action === 'pause') {
            // Bank the running segment. Guarded on running_since so a double
            // pause cannot bank the same stretch twice.
            await c.env.DB.prepare(
                `UPDATE watch_sessions
                 SET elapsed_secs = elapsed_secs
                         + CAST((julianday(?) - julianday(running_since)) * 86400 AS INTEGER),
                     running_since = NULL,
                     last_activity_at = ?
                 WHERE user_id = ? AND season_id = ? AND episode = ? AND running_since IS NOT NULL`,
            )
                .bind(now, now, ...key)
                .run();
        } else {
            // Resume only restarts the clock; the banked total is untouched.
            await c.env.DB.prepare(
                `UPDATE watch_sessions SET running_since = ?, last_activity_at = ?
                 WHERE user_id = ? AND season_id = ? AND episode = ? AND running_since IS NULL`,
            )
                .bind(now, now, ...key)
                .run();
        }

        const session = await c.env.DB.prepare(
            `SELECT elapsed_secs, running_since, last_activity_at
             FROM watch_sessions WHERE user_id = ? AND season_id = ? AND episode = ?`,
        )
            .bind(...key)
            .first();
        if (!session) return c.json({ error: 'No timer to update' }, 409);

        return c.json({
            success: true,
            season_id: season.id,
            episode,
            session,
            offset_secs: sessionOffsetSecs(session, nowMs),
        });
    },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/worker/discussion.test.js`
Expected: PASS, all thirty-eight tests.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/discussion.test.js
git commit -m "feat(api): add pausable watch timer that stamps notes with an offset"
```

---

### Task 8: Surface discussions on the board

**Files:**

- Modify: `src/index.js:67-94` (the `GET /api/board` handler)
- Modify: `test/worker/index.test.js`

**Interfaces:**

- Produces: each season in `GET /api/board` gains `episode_count: number` and `post_count: number` (every note on every episode of that season, by every author).

- [ ] **Step 1: Write the failing test**

Append to the `describe('GET /api/board', …)` block in `test/worker/index.test.js`. That file's `beforeEach` inserts seasons without an `episode_count`, so add it there first:

```js
await env.DB.prepare(
    "INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo', 13)",
).run();
await env.DB.prepare(
    "INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES (41, '', 'https://en.wikipedia.org/wiki/Survivor_41', 13)",
).run();
```

Then the tests:

```js
it('includes episode_count per season', async () => {
    const { seasons } = await (await req('GET', '/api/board')).json();
    expect(seasons.find((s) => s.id === 1).episode_count).toBe(13);
});

it('reports post_count across every episode of a season', async () => {
    await req('POST', '/api/seasons/1/episodes/1/posts', {
        body: { body: 'first' },
        email: 'alice@example.com',
    });
    await req('POST', '/api/seasons/1/episodes/5/posts', {
        body: { body: 'second' },
        email: 'bob@example.com',
    });
    const { seasons } = await (await req('GET', '/api/board')).json();
    expect(seasons.find((s) => s.id === 1).post_count).toBe(2);
    expect(seasons.find((s) => s.id === 41).post_count).toBe(0);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/worker/index.test.js -t 'post_count'`
Expected: FAIL — `post_count` is `undefined`.

- [ ] **Step 3: Write the implementation**

In the `GET /api/board` handler, add a fifth query to the `Promise.all` and widen the seasons query:

```js
        c.env.DB.prepare(
            'SELECT id, subtitle, wikipedia_url, episode_count FROM seasons ORDER BY id ASC',
        ).all(),
        c.env.DB.prepare('SELECT season_id, user_id FROM watched').all(),
        // Post counts let the board show which seasons have any discussion at
        // all — without it there is nothing to click towards.
        c.env.DB.prepare(
            'SELECT season_id, COUNT(*) AS post_count FROM posts GROUP BY season_id',
        ).all(),
```

Destructure it and fold it into the mapped board:

```js
const postCounts = new Map(counts.map((c) => [c.season_id, c.post_count]));

const board = seasons.map((s) => ({
    id: s.id,
    subtitle: s.subtitle,
    wikipedia_url: s.wikipedia_url,
    episode_count: s.episode_count,
    post_count: postCounts.get(s.id) ?? 0,
    watched_by: watchedBySeason.get(s.id),
}));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/worker/`
Expected: PASS — the whole worker suite, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add src/index.js test/worker/index.test.js
git commit -m "feat(api): report episode and post counts per season on the board"
```

---

### Task 9: Split the frontend

A pure refactor: no behavior changes, no new tests. It exists because `frontend/script.js` is 520 lines before this feature adds a season view, a timer, and a router to it.

**Files:**

- Create: `frontend/api.js`, `frontend/hooks.js`, `frontend/board.js`
- Modify: `frontend/script.js`

**Interfaces:**

- Produces:
    - `frontend/api.js` — `api(path, options?): Promise<object>`
    - `frontend/hooks.js` — `useTheme(): { theme, toggle }`, `useRefreshGuard(fetcher, apply): { refresh, beginMutation, endMutation }`, `useRefreshOnFocus(refresh, onError): void`
    - `frontend/board.js` — `Header`, `NowWatching`, `SeasonRow`, `Board` (all named exports), plus `html` is re-bound locally in each module via `htm.bind(h)`.

- [ ] **Step 1: Move `api()` into its own module**

Create `frontend/api.js` containing the existing `api` function from `script.js:16-26` verbatim, with `export` added. Delete it from `script.js` and import it.

- [ ] **Step 2: Move the components**

Create `frontend/board.js`. Move `SunIcon`, `MoonIcon`, `Header`, `SeasonRow`, `NowWatching`, and `Board` from `script.js` verbatim. Add at the top:

```js
import { h } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import htm from 'htm';
import {
    seasonLabel,
    isFullyWatched,
    sortSeasons,
    sortBySeenCount,
    selectableSeasons,
} from './utils.js';

const html = htm.bind(h);
```

Export `Header` and `Board`; the rest stay module-private.

- [ ] **Step 3: Extract the refresh guard**

Create `frontend/hooks.js`. Move `useTheme` verbatim, then add `useRefreshGuard`, which is the `boardGen` / `boardFetches` / `mutationsInFlight` / `refreshQueued` machinery from `script.js:288-381` lifted out unchanged in behavior:

```js
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';

// Guards a shared-resource refetch against races with optimistic mutations.
//
// Two mechanisms, both carried over from the board:
//   - Generations: only the newest fetch may apply its response. Focus and
//     visibilitychange often both fire, and a mutation starting mid-flight
//     invalidates whatever a fetch was already carrying.
//   - Deferral: a refresh asked for while a mutation is in flight is queued
//     rather than started, because its response could come from a read taken
//     before the mutation commits. The last mutation to settle runs it.
//
// `fetcher` returns the data; `apply` writes it to state. refresh() resolves
// true when the response was applied and false when it was stale or deferred.
export function useRefreshGuard(fetcher, apply) {
    const generation = useRef(0);
    const fetchesInFlight = useRef(0);
    const mutationsInFlight = useRef(0);
    const queued = useRef(false);

    const refresh = useCallback(async () => {
        if (mutationsInFlight.current > 0) {
            queued.current = true;
            return false;
        }
        const mine = ++generation.current;
        fetchesInFlight.current++;
        try {
            const data = await fetcher();
            if (mine !== generation.current) return false;
            apply(data);
            return true;
        } finally {
            fetchesInFlight.current--;
        }
    }, [fetcher, apply]);

    const beginMutation = useCallback(() => {
        mutationsInFlight.current++;
        // A fetch already in flight may have read pre-mutation state: discard
        // its response and queue a refetch so the other-user changes it was
        // carrying still arrive.
        if (fetchesInFlight.current > 0) {
            generation.current++;
            queued.current = true;
        }
    }, []);

    const endMutation = useCallback(() => {
        if (--mutationsInFlight.current === 0 && queued.current) {
            queued.current = false;
            // Best-effort: the mutation's own error banner already reflects
            // reality, and the next focus refresh retries.
            refresh().catch(() => {});
        }
    }, [refresh]);

    return { refresh, beginMutation, endMutation };
}

// Refetch when the tab regains focus, so changes other people made while this
// tab was in the background show up without a reload.
export function useRefreshOnFocus(refresh, onError) {
    useEffect(() => {
        const handler = () => {
            if (document.visibilityState !== 'visible') return;
            refresh().then(
                // A discarded stale response says nothing about server health —
                // only clear the banner when the data actually applied.
                (applied) => applied && onError(null),
                (err) => onError(err.message),
            );
        };
        document.addEventListener('visibilitychange', handler);
        window.addEventListener('focus', handler);
        return () => {
            document.removeEventListener('visibilitychange', handler);
            window.removeEventListener('focus', handler);
        };
    }, [refresh, onError]);
}
```

- [ ] **Step 4: Rewire `App`**

In `script.js`, delete the moved code and wire `App` to the hooks. `loadBoard` becomes a plain fetcher, and the apply step moves into a callback:

```js
const fetchBoard = useCallback(() => api('/api/board'), []);
const applyBoard = useCallback((board) => {
    setUsers(board.users);
    setSeasons(board.seasons);
    setMe(board.me);
}, []);
const { refresh, beginMutation, endMutation } = useRefreshGuard(fetchBoard, applyBoard);
useRefreshOnFocus(refresh, setError);
```

The initial-load effect calls `refresh()`; `toggle` and `setCurrentlyWatching` keep their bodies unchanged, now calling the hook's `beginMutation` / `endMutation`.

- [ ] **Step 5: Verify nothing changed**

Run: `npm test && npm run build && npm run lint && npm run format:check`
Expected: PASS. The existing suites must be untouched — this task adds no tests because it adds no behavior.

Then run `npm run dev` and confirm in the browser that the board renders, a checkbox toggles, the Now Watching picker works, and the theme button still switches.

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "refactor(frontend): split script.js into api, hooks, and board modules"
```

---

### Task 10: Post ordering helpers

**Files:**

- Modify: `frontend/utils.js`
- Create: `test/frontend/posts.test.js`

**Interfaces:**

- Produces:
    - `episodeNumbers(count): number[]` — `[1, 2, … count]`, empty for a falsy count.
    - `formatOffset(secs): string` — `'+0:00'`, `'+5:00'`, `'+1:05:00'`.
    - `orderPosts(posts): Array<{ post, offset, inferred, tail }>` where `posts` is the API's per-episode `posts` array. `offset` is seconds, or `null` for a tail entry.

- [ ] **Step 1: Write the failing test**

Create `test/frontend/posts.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { orderPosts, formatOffset, episodeNumbers } from '../../frontend/utils.js';

const timed = (id, user_id, offset_secs, created_at) => ({
    id,
    user_id,
    body: `note ${id}`,
    created_at,
    offset_secs,
});
const untimed = (id, user_id, created_at) => timed(id, user_id, null, created_at);
const names = (placed) => placed.map((p) => `${p.post.user_id}@${p.offset}`);

describe('orderPosts', () => {
    it('interleaves two timed viewers by their own offsets', () => {
        // The spec's worked example: Alice watches at 9pm and posts at +10, +30,
        // +45, +50; Bob watches days later and posts at +5, +11, +35.
        const posts = [
            timed(1, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            timed(2, 'alice', 1800, '2026-07-20T21:30:00.000Z'),
            timed(3, 'alice', 2700, '2026-07-20T21:45:00.000Z'),
            timed(4, 'alice', 3000, '2026-07-20T21:50:00.000Z'),
            timed(5, 'bob', 300, '2026-07-23T06:05:00.000Z'),
            timed(6, 'bob', 660, '2026-07-23T06:11:00.000Z'),
            timed(7, 'bob', 2100, '2026-07-23T06:35:00.000Z'),
        ];
        expect(names(orderPosts(posts))).toEqual([
            'bob@300',
            'alice@600',
            'bob@660',
            'alice@1800',
            'bob@2100',
            'alice@2700',
            'alice@3000',
        ]);
    });

    it('infers a zero from an untimed author’s earliest note', () => {
        const posts = [
            timed(1, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            untimed(2, 'carol', '2026-07-22T20:00:00.000Z'),
            untimed(3, 'carol', '2026-07-22T20:13:00.000Z'),
        ];
        const placed = orderPosts(posts);
        expect(names(placed)).toEqual(['carol@0', 'alice@600', 'carol@780']);
        expect(placed[0].inferred).toBe(true);
        expect(placed[1].inferred).toBe(false);
    });

    it('drops an untimed straggler from a timed author to the tail', () => {
        // Alice ran a timer, then came back two days later. Inventing an offset
        // of +51:10:00 for that note would be a lie dressed as data.
        const posts = [
            timed(1, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            untimed(2, 'alice', '2026-07-22T21:10:00.000Z'),
            timed(3, 'bob', 300, '2026-07-23T06:05:00.000Z'),
        ];
        const placed = orderPosts(posts);
        expect(names(placed)).toEqual(['bob@300', 'alice@600', 'alice@null']);
        expect(placed[2].tail).toBe(true);
        expect(placed[2].offset).toBeNull();
    });

    it('breaks ties on equal offsets by post time', () => {
        const posts = [
            timed(1, 'bob', 600, '2026-07-23T06:10:00.000Z'),
            timed(2, 'alice', 600, '2026-07-20T21:10:00.000Z'),
        ];
        expect(orderPosts(posts).map((p) => p.post.id)).toEqual([2, 1]);
    });

    it('orders several tail notes among themselves by post time', () => {
        const posts = [
            timed(1, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            untimed(2, 'alice', '2026-07-24T10:00:00.000Z'),
            untimed(3, 'alice', '2026-07-23T10:00:00.000Z'),
        ];
        expect(orderPosts(posts).map((p) => p.post.id)).toEqual([1, 3, 2]);
    });

    it('handles an empty board and does not mutate its input', () => {
        expect(orderPosts([])).toEqual([]);
        const posts = [
            timed(2, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            timed(1, 'bob', 300, '2026-07-23T06:05:00.000Z'),
        ];
        const snapshot = posts.map((p) => p.id);
        orderPosts(posts);
        expect(posts.map((p) => p.id)).toEqual(snapshot);
    });
});

describe('formatOffset', () => {
    it('formats sub-hour offsets without an hour part', () => {
        expect(formatOffset(0)).toBe('+0:00');
        expect(formatOffset(300)).toBe('+5:00');
        expect(formatOffset(65)).toBe('+1:05');
    });

    it('pads minutes once an hour part appears', () => {
        expect(formatOffset(3900)).toBe('+1:05:00');
        expect(formatOffset(3600)).toBe('+1:00:00');
    });

    it('never renders a negative offset', () => {
        expect(formatOffset(-30)).toBe('+0:00');
    });
});

describe('episodeNumbers', () => {
    it('counts from one', () => {
        expect(episodeNumbers(3)).toEqual([1, 2, 3]);
    });

    it('is empty for a season with no episode count', () => {
        expect(episodeNumbers(0)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/frontend/posts.test.js`
Expected: FAIL — `orderPosts is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `frontend/utils.js`:

```js
// The episode numbers of a season, 1..count.
export function episodeNumbers(count) {
    return Array.from({ length: count || 0 }, (_, i) => i + 1);
}

// A watch offset as "+5:00", or "+1:05:00" once it passes an hour. Minutes are
// padded only when there is an hour part, so short offsets stay easy to scan.
export function formatOffset(secs) {
    const total = Math.max(0, Math.round(secs));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    return `+${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

// Places every note on one timeline so a conversation written days apart reads
// in episode order. Does not mutate the input.
//
// An author who ran a timer has real offsets. An author who never did gets an
// inferred zero — their own earliest note on the episode — so their notes still
// interleave instead of piling up at one end. An author with both (their session
// went stale and they came back later) keeps the real offsets, and the strays
// drop to the tail: giving that note a computed "+51:10:00" would be a lie
// dressed as data.
export function orderPosts(posts) {
    const timedAuthors = new Set(posts.filter((p) => p.offset_secs != null).map((p) => p.user_id));

    const zeroByAuthor = new Map();
    for (const p of posts) {
        if (timedAuthors.has(p.user_id)) continue;
        const at = Date.parse(p.created_at);
        const zero = zeroByAuthor.get(p.user_id);
        if (zero === undefined || at < zero) zeroByAuthor.set(p.user_id, at);
    }

    const placed = posts.map((post) => {
        const created = Date.parse(post.created_at);
        if (post.offset_secs != null) {
            return { post, offset: post.offset_secs, inferred: false, tail: false, created };
        }
        if (timedAuthors.has(post.user_id)) {
            return { post, offset: null, inferred: false, tail: true, created };
        }
        const offset = Math.round((created - zeroByAuthor.get(post.user_id)) / 1000);
        return { post, offset, inferred: true, tail: false, created };
    });

    return placed.sort((a, b) => {
        if (a.tail !== b.tail) return a.tail ? 1 : -1;
        if (!a.tail && a.offset !== b.offset) return a.offset - b.offset;
        return a.created - b.created;
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/frontend/posts.test.js`
Expected: PASS, all eleven tests.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/utils.js test/frontend/posts.test.js
git commit -m "feat(frontend): add post ordering and offset formatting helpers"
```

---

### Task 11: Hash routing and the season view shell

**Files:**

- Modify: `frontend/hooks.js`, `frontend/script.js`, `frontend/board.js`
- Create: `frontend/discussion.js`
- Modify: `frontend/styles.css`

**Interfaces:**

- Produces:
    - `useHashRoute(): number | null` in `hooks.js` — the season id from `#/season/N`, or `null` for the board.
    - `SeasonView({ seasonId, onError })` in `discussion.js` — fetches `/api/seasons/:id/discussion` and renders the shell. Episode cards arrive in Task 12; this task renders one placeholder row per episode.

- [ ] **Step 1: Add the route hook**

In `frontend/hooks.js`:

```js
// The app has exactly one route beyond the board, so a hash and a listener beat
// a router library. A hash also means Back returns to the board, a reload keeps
// your place, and a season is a link you can paste into chat.
export function useHashRoute() {
    const read = () => {
        const match = /^#\/season\/(\d+)$/.exec(window.location.hash);
        return match ? Number(match[1]) : null;
    };
    const [seasonId, setSeasonId] = useState(read);

    useEffect(() => {
        const handler = () => setSeasonId(read());
        window.addEventListener('hashchange', handler);
        return () => window.removeEventListener('hashchange', handler);
    }, []);

    return seasonId;
}
```

- [ ] **Step 2: Link the board rows**

In `frontend/board.js`, change `SeasonRow`'s season cell from the Wikipedia anchor to an in-app link, and add the discussion badge. The Wikipedia link moves into the season view header in Step 3.

```js
            <td class="season-cell">
                <a class="season-link" href=${`#/season/${season.id}`}>${seasonLabel(season)}</a>
                ${
                    season.post_count > 0
                        ? html`<span class="post-badge" title=${`${season.post_count} notes`}>
                              💬 ${season.post_count}
                          </span>`
                        : null
                }
            </td>
```

- [ ] **Step 3: Build the season view shell**

Create `frontend/discussion.js`:

```js
import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useRefreshGuard, useRefreshOnFocus } from './hooks.js';
import { seasonLabel } from './utils.js';

const html = htm.bind(h);

export function SeasonView({ seasonId }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const fetchDiscussion = useCallback(
        () => api(`/api/seasons/${seasonId}/discussion`),
        [seasonId],
    );
    const { refresh, beginMutation, endMutation } = useRefreshGuard(fetchDiscussion, setData);
    useRefreshOnFocus(refresh, setError);

    useEffect(() => {
        setLoading(true);
        refresh()
            .catch((err) => setError(err.message))
            .finally(() => setLoading(false));
    }, [refresh]);

    if (loading) return html`<div class="loading">Loading…</div>`;
    if (error) return html`<div class="error">${error}</div>`;
    if (!data) return null;

    return html`
        <div class="season-view">
            <a class="back-link" href="#/">← Board</a>
            <div class="season-view-head">
                <h2 class="season-view-title">${seasonLabel(data.season)}</h2>
                <a
                    class="wiki-link"
                    href=${data.season.wikipedia_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >Wikipedia ↗</a
                >
            </div>
            ${
                !data.me &&
                html`<div class="notice">
                    You're not on the watch list — you can read what you've opened, but not post.
                </div>`
            }
            <div class="episodes">
                ${data.episodes.map(
                    (ep) =>
                        html`<div key=${ep.episode} class="episode-card">
                            Episode ${ep.episode} — ${ep.count} notes
                        </div>`,
                )}
            </div>
        </div>
    `;
}
```

`beginMutation` and `endMutation` are unused until Task 12; leave them destructured and wire them there rather than adding and removing the line twice.

- [ ] **Step 4: Route in `App`**

In `frontend/script.js`, read the route and branch. The board's data stays loaded behind the season view so returning to it is instant:

```js
const routeSeasonId = useHashRoute();
```

Then in the render, replace the `<${Board} … />` block's condition so that when `routeSeasonId` is set, the view renders instead:

```js
                ${
                    !loading &&
                    routeSeasonId != null &&
                    html`<${SeasonView} seasonId=${routeSeasonId} />`
                }
                ${
                    !loading &&
                    routeSeasonId == null &&
                    users.length > 0 &&
                    html`
                        <${Board}
                            users=${users}
                            seasons=${seasons}
                            meId=${meId}
                            onToggle=${toggle}
                            onSetCurrentlyWatching=${setCurrentlyWatching}
                        />
                    `
                }
```

The "not on the watch list" notice and the empty-state block keep their existing
conditions but also gain `routeSeasonId == null`, so they do not stack on top of
the season view.

- [ ] **Step 5: Add the styles**

Append to `frontend/styles.css`, using the existing tokens rather than raw colors:

```css
.back-link {
    display: inline-block;
    margin-bottom: 1rem;
    color: var(--text-subtle);
    text-decoration: none;
    font-size: 0.9rem;
}

.back-link:hover {
    color: var(--text);
}

.season-view-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
}

.season-view-title {
    font-size: 1.25rem;
}

.wiki-link {
    color: var(--blue);
    text-decoration: none;
    font-size: 0.85rem;
    white-space: nowrap;
}

.season-link {
    color: var(--text);
    text-decoration: none;
}

.season-link:hover {
    color: var(--blue);
}

.post-badge {
    margin-left: 0.5rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
}

.episodes {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.episode-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
}
```

- [ ] **Step 6: Verify in the browser**

Run: `npm run build && npm test && npm run lint && npm run format:check` — all must pass.

Then `npm run dev` and confirm: clicking a season title opens `#/season/N`; Back returns to the board; reloading on `#/season/45` stays there; a season with notes shows the 💬 badge; `#/season/999` shows the error banner rather than a blank page.

- [ ] **Step 7: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): add hash-routed season view"
```

---

### Task 12: Episode boards

**Files:**

- Modify: `frontend/discussion.js`, `frontend/styles.css`

**Interfaces:**

- Consumes: `orderPosts`, `formatOffset` from Task 10; the routes from Tasks 3–6.
- Produces: `EpisodeBoard`, `PostList`, `PostForm` inside `discussion.js` — module-private, used by `SeasonView`.

- [ ] **Step 1: Resolve author names, and widen the imports**

`GET /api/seasons/:id/discussion` returns user ids but not names, so the season
view fetches the board alongside it. Both are small and the board is already
warm in cache.

In `frontend/discussion.js`, replace the fetcher from Task 11:

```js
const fetchDiscussion = useCallback(async () => {
    const [discussion, board] = await Promise.all([
        api(`/api/seasons/${seasonId}/discussion`),
        api('/api/board'),
    ]);
    return { ...discussion, users: board.users };
}, [seasonId]);
```

Add a lookup below the loading guards in `SeasonView`:

```js
const nameOf = (id) => data.users.find((u) => u.id === id)?.name ?? 'Someone';
```

Widen the module's imports — Task 11 left them at the shell's needs:

```js
import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import { seasonLabel, orderPosts, formatOffset } from './utils.js';
```

- [ ] **Step 1b: Render the cards**

Replace the placeholder `.episode-card` markup in `SeasonView`'s `.episodes`
div:

```js
                ${data.episodes.map(
                    (ep) => html`<${EpisodeBoard}
                        key=${ep.episode}
                        seasonId=${seasonId}
                        ep=${ep}
                        meId=${data.me?.id ?? null}
                        nameOf=${nameOf}
                        onReveal=${reveal}
                        onPost=${addPost}
                        onDelete=${removePost}
                    />`,
                )}
```

The three callbacks are defined in Step 4.

- [ ] **Step 2: Write `EpisodeBoard`**

```js
// One episode's board. Locked boards are the default: you see the count and who
// wrote, plus your own notes, and nothing else until you choose to open it.
function EpisodeBoard({ seasonId, ep, meId, nameOf, onReveal, onPost, onDelete }) {
    const [open, setOpen] = useState(false);
    const placed = useMemo(() => orderPosts(ep.posts), [ep.posts]);

    const summary =
        ep.count === 0 ? 'no notes' : `${ep.count} ${ep.count === 1 ? 'note' : 'notes'}`;
    const others = ep.authors.filter((id) => id !== meId).map(nameOf);

    return html`
        <div class=${'episode-card' + (ep.readable ? '' : ' locked')}>
            <button class="episode-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
                <span class="episode-name">Episode ${ep.episode}</span>
                <span class="episode-meta">
                    ${ep.readable ? '' : '🔒 '}${summary}${
                        others.length ? ` · ${others.join(', ')}` : ''
                    }
                </span>
            </button>
            ${
                open &&
                html`
                    <div class="episode-body">
                        <${PostList}
                            placed=${placed}
                            meId=${meId}
                            nameOf=${nameOf}
                            onDelete=${onDelete}
                        />
                        ${
                            !ep.readable &&
                            html`
                                ${
                                    ep.count > ep.posts.length &&
                                    html`<div class="hidden-note">
                                        — ${ep.count - ep.posts.length} notes hidden —
                                    </div>`
                                }
                                <button class="reveal-btn" onClick=${() => onReveal(ep.episode)}>
                                    Show discussion
                                </button>
                            `
                        }
                        ${meId && html`<${PostForm} onPost=${(body) => onPost(ep.episode, body)} />`}
                    </div>
                `
            }
        </div>
    `;
}
```

- [ ] **Step 3: Write `PostList` and `PostForm`**

```js
function PostList({ placed, meId, nameOf, onDelete }) {
    if (placed.length === 0) return html`<div class="no-posts">Nothing here yet.</div>`;
    return html`
        <ol class="posts">
            ${placed.map(
                ({ post, offset, inferred, tail }) => html`
                    <li key=${post.id} class="post">
                        <span class="post-time" title=${new Date(post.created_at).toLocaleString()}>
                            ${
                                tail
                                    ? new Date(post.created_at).toLocaleDateString()
                                    : `${inferred ? '~' : ''}${formatOffset(offset)}`
                            }
                        </span>
                        <span class="post-author"
                            >${post.user_id === meId ? 'You' : nameOf(post.user_id)}</span
                        >
                        <span class="post-body">${post.body}</span>
                        ${
                            post.user_id === meId &&
                            html`<button
                                class="post-delete"
                                title="Delete this note"
                                onClick=${() => onDelete(post.id)}
                            >
                                ×
                            </button>`
                        }
                    </li>
                `,
            )}
        </ol>
    `;
}

// Posting is not optimistic: the offset is assigned by the server from your
// live session, so there is nothing correct to render until it answers.
function PostForm({ onPost }) {
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e) => {
        e.preventDefault();
        const trimmed = body.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            await onPost(trimmed);
            setBody('');
        } finally {
            setBusy(false);
        }
    };

    return html`
        <form class="post-form" onSubmit=${submit}>
            <input
                class="post-input"
                type="text"
                maxlength="2000"
                placeholder="Write a note…"
                value=${body}
                disabled=${busy}
                onInput=${(e) => setBody(e.target.value)}
            />
            <button class="post-submit" type="submit" disabled=${busy || !body.trim()}>Post</button>
        </form>
    `;
}
```

- [ ] **Step 4: Wire the mutations in `SeasonView`**

```js
const mutate = useCallback(
    async (run) => {
        beginMutation();
        try {
            await run();
            await api(`/api/seasons/${seasonId}/discussion`).then((fresh) =>
                setData((prev) => ({ ...fresh, users: prev.users })),
            );
            setError(null);
        } catch (err) {
            setError(err.message);
        } finally {
            endMutation();
        }
    },
    [seasonId, beginMutation, endMutation],
);

const reveal = (episode) =>
    mutate(() => api(`/api/seasons/${seasonId}/episodes/${episode}/reveal`, { method: 'POST' }));

const addPost = (episode, body) =>
    mutate(() =>
        api(`/api/seasons/${seasonId}/episodes/${episode}/posts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        }),
    );

const removePost = (postId) => mutate(() => api(`/api/posts/${postId}`, { method: 'DELETE' }));
```

- [ ] **Step 5: Add the styles**

```css
.episode-card.locked {
    background: var(--surface-subtle);
}

.episode-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.episode-meta {
    font-size: 0.8rem;
    color: var(--text-muted);
}

.episode-body {
    margin-top: 0.75rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.75rem;
}

.posts {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}

.post {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.9rem;
}

.post-time {
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    font-size: 0.8rem;
    min-width: 4.5rem;
}

.post-author {
    color: var(--text-subtle);
    font-weight: 600;
}

.post-delete {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
}

.post-delete:hover {
    color: var(--red);
}

.no-posts,
.hidden-note {
    color: var(--text-muted);
    font-size: 0.85rem;
    font-style: italic;
    padding: 0.25rem 0;
}

.reveal-btn {
    margin: 0.5rem 0;
    padding: 0.35rem 0.75rem;
    background: var(--surface-accent);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    cursor: pointer;
    font-size: 0.85rem;
}

.post-form {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
}

.post-input {
    flex: 1;
    padding: 0.4rem 0.6rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
}

.post-submit {
    padding: 0.4rem 0.9rem;
    background: var(--surface-accent);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    cursor: pointer;
    font-size: 0.9rem;
}

.post-submit:disabled {
    opacity: 0.5;
    cursor: default;
}
```

- [ ] **Step 6: Verify the gate by hand**

Run all four checks, then `npm run dev`. In `.dev.vars`, `DEV_USER_EMAIL` selects who you are — switch it between two roster emails and restart to test both sides.

Confirm: as Alice, post on episode 7; as Bob, episode 7 shows `🔒 1 note · Alice` with no body; open DevTools' Network tab and confirm Alice's text is absent from the `/discussion` response payload, not merely hidden; click Show discussion and the body appears; reload and it stays open; delete your own note and the count drops; no delete button appears on anyone else's.

- [ ] **Step 7: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/
git commit -m "feat(frontend): add episode boards with reveal, posting, and deletion"
```

---

### Task 13: The watch timer UI

**Files:**

- Modify: `frontend/discussion.js`, `frontend/styles.css`

**Interfaces:**

- Consumes: `sessionOffsetSecs` from Task 2; `formatOffset` from Task 10; the timer route from Task 7.
- Produces: `WatchTimer({ session, serverSkewMs, onAction })` inside `discussion.js`.

- [ ] **Step 1: Track the server clock**

In `SeasonView`, derive the skew once per fetch so the ticking chip is anchored to the server's clock rather than a possibly-wrong local one:

```js
const serverSkewMs = data.now ? Date.parse(data.now) - Date.now() : 0;
```

Note this is computed at render from the last response, so it drifts by at most the age of that response — good enough for a display that ticks in seconds.

- [ ] **Step 2: Write `WatchTimer`**

```js
// The ticking chip. It re-derives the offset from the server's session every
// second rather than counting locally, so a pause, a reload, or a second device
// all land on the same number. It stops at the same three-hour staleness point
// the server uses (shared/session.js), because showing a number the server would
// refuse to stamp would be a promise the post cannot keep.
function WatchTimer({ session, serverSkewMs, onAction }) {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!session?.running_since) return;
        const id = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [session?.running_since]);

    const offset = sessionOffsetSecs(session, Date.now() + serverSkewMs);
    // `tick` only exists to force this re-render each second.
    void tick;

    if (offset === null) {
        return html`
            <div class="timer">
                ${session && html`<span class="timer-expired">timer expired</span>`}
                <button class="timer-btn" onClick=${() => onAction('start')}>Start watching</button>
            </div>
        `;
    }

    const running = session.running_since != null;
    return html`
        <div class="timer">
            <span class=${'timer-chip' + (running ? ' running' : '')}>
                ${running ? '▶' : '⏸'} ${formatOffset(offset)}
            </span>
            <button class="timer-btn" onClick=${() => onAction(running ? 'pause' : 'resume')}>
                ${running ? 'Pause' : 'Resume'}
            </button>
            <button class="timer-btn subtle" onClick=${() => onAction('start')}>Restart</button>
        </div>
    `;
}
```

- [ ] **Step 3: Wire it into `EpisodeBoard`**

Add `session`, `serverSkewMs`, and `onTimer` to `EpisodeBoard`'s props, and render the timer above the post form:

```js
                        ${
                            meId &&
                            html`<${WatchTimer}
                                session=${ep.session}
                                serverSkewMs=${serverSkewMs}
                                onAction=${(action) => onTimer(ep.episode, action)}
                            />`
                        }
```

In `SeasonView`, add the callback beside the others:

```js
const setTimer = (episode, action) =>
    mutate(() =>
        api(`/api/seasons/${seasonId}/episodes/${episode}/timer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
        }),
    );
```

Import `sessionOffsetSecs` at the top of `discussion.js`:

```js
import { sessionOffsetSecs } from '../shared/session.js';
```

- [ ] **Step 4: Add the styles**

```css
.timer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
}

.timer-chip {
    font-variant-numeric: tabular-nums;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: var(--surface-subtle);
    border: 1px solid var(--border);
    font-size: 0.85rem;
    color: var(--text-subtle);
}

.timer-chip.running {
    background: var(--surface-accent);
    color: var(--text);
}

.timer-expired {
    font-size: 0.8rem;
    color: var(--amber-text);
}

.timer-btn {
    padding: 0.25rem 0.6rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-subtle);
    cursor: pointer;
    font-size: 0.8rem;
}

.timer-btn.subtle {
    border-color: transparent;
    color: var(--text-muted);
}
```

- [ ] **Step 5: Verify by hand**

Run all four checks, then `npm run dev`.

Confirm: Start watching begins a chip that ticks each second; Pause freezes it and the label becomes Resume; a note posted while paused shows the frozen offset; Resume continues from that number rather than from zero; reloading the page keeps the running total; Restart returns it to `+0:00`. Then post from two different `DEV_USER_EMAIL` identities with timers started minutes apart, reveal the episode, and confirm the notes interleave by offset rather than by wall-clock.

- [ ] **Step 6: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add frontend/
git commit -m "feat(frontend): add the watch timer chip to episode boards"
```

---

### Task 14: Documentation

**Files:**

- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Update the repository structure in `CLAUDE.md`**

Add `shared/session.js` and the new frontend modules to the structure list, and add `0005_discussions.sql` to the migrations list with a one-line description.

- [ ] **Step 2: Update the schema section**

Add `posts`, `reveals`, and `watch_sessions` to the Database Schema list in the same one-line-per-table style as the existing entries, and note the `seasons.episode_count` column.

- [ ] **Step 3: Update the API routes section**

Add the five new routes with the same level of detail as the existing entries, and note that `GET /api/board` now carries `episode_count` and `post_count`. State the spoiler rule in one sentence: an episode's foreign bodies are readable only when the caller has watched the season or explicitly revealed that episode, and the filtering happens server-side.

- [ ] **Step 4: Update the frontend section**

Describe the hash route `#/season/N`, the split into `api.js` / `hooks.js` / `board.js` / `discussion.js`, and the ordering rule implemented by `orderPosts`.

- [ ] **Step 5: Update `README.md`**

Add a short feature section for discussion boards covering: boards are write-only until revealed, revealing is per-episode and permanent, watching a season opens all of its episodes, and the optional timer with its three-hour staleness rule.

- [ ] **Step 6: Commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
git add CLAUDE.md README.md
git commit -m "docs: describe per-episode discussion boards and the watch timer"
```

---

## Post-Implementation

Before opening a pull request:

- [ ] Apply the migration to production D1: `npx wrangler d1 migrations apply outwatch --remote`
- [ ] Spot-check the episode counts a second time against seasons you know well. This is the one number in the feature that no test can prove correct.
- [ ] Confirm `git log --oneline` shows one commit per task and that each builds.
