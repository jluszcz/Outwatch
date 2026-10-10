# Outwatch on TV Talk's Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Outwatch a Survivor-only frontend onto TV Talk's D1, so every note and every other piece of Survivor state is shared between the two apps.

**Architecture:** TV Talk gains a `Survivor` show via one migration and is otherwise unchanged. Outwatch's Worker binds TV Talk's `tvtalk` database and ports its SQL onto TV Talk's schema. One helper, `resolveSeason`, turns the Survivor season _number_ (which is all Outwatch's API and frontend ever use) into TV Talk's surrogate `seasons.id`. A one-time Python script copies Outwatch's production data across.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), Vitest with `@cloudflare/vitest-pool-workers`, stdlib Python 3 for the importer.

**Spec:** `docs/superpowers/specs/2026-10-10-tvtalk-backend-design.md`

## Global Constraints

- TV Talk owns the schema. Outwatch never runs `wrangler d1 migrations apply ... --remote`.
- Outwatch's `migrations/` is a byte-identical copy of TV Talk's `migrations/`.
- The Survivor show is found by the exact name `'Survivor'`, never by a hard-coded id.
- Outwatch's API contracts do not change: every `season_id` in a path, body, or response is the Survivor season number.
- Surrogate season ids (`row_id`) are never serialized to the client.
- Outwatch bounds stay its own: `MAX_EPISODE_COUNT` 30, `MAX_SUBTITLE_LENGTH` 100.
- TV Talk's code (`src/`, `frontend/`) is not modified.
- Never commit real names or emails. Use the standard cast (`Alice`, `Bob & Carol`, `Dave & Erin`, `@example.com`). The generated import SQL and any database export contain real emails, so they live only in the session scratchpad, never in either repo.
- Before every commit, in the repo being committed: `npm run build`, `npm test`, `npm run lint`, `npm run format:check` all pass. Never use `--no-verify`.
- Commit with the `jluszcz:commit` skill, on a feature branch (Outwatch: `outwatch-on-tvtalk-design`, already created; TV Talk: `add-survivor-show`).
- Outwatch production D1 (`outwatch`) is never written to.

## Review Focus

1. **Number vs. row id confusion.** A route binds the number where it should bind the row id, or the reverse. In the legacy suites the fixtures make the two equal, so those suites cannot catch it. `test/worker/survivor-scope.test.js` makes them differ on every route (Task 2).
2. **Another show's data leaking in or being acted on.** A post, watched row, or currently-watching row on a non-Survivor season must not show up in the board, feed, or discussion, and must 404 for edit, delete, and react (Task 2, scope suite).
3. **Season numbering counted across shows.** `POST /api/seasons` must compute "next season" from Survivor's numbers only (Task 2, scope suite).
4. **Import id remapping.** Replies and reactions must follow their post through the id offset, and every season-scoped row must land on the right Survivor season (Task 4, importer test).
5. **Import over a non-empty TV Talk.** Existing TV Talk posts, and a `feed_seen_at` that is later than Outwatch's, must survive the import (Task 4, importer test).

---

### Task 1: TV Talk — add the Survivor show

Works in `../TvTalk` (`/Users/jacob/Documents/Programs/TvTalk`).

**Files:**
- Create: `../TvTalk/migrations/0003_survivor.sql`
- Modify: `../TvTalk/test/worker/migrations.test.js:4-15`
- Modify: `../TvTalk/AGENTS.md` (Database Schema section, after the paragraph beginning "`shows` and `seasons` are seeded by migration `0002`")

**Interfaces:**
- Produces: a show row named exactly `Survivor`, plus seasons numbered 1–51 under it, in every environment that runs TV Talk's migrations. Tasks 2–5 depend on this.

- [ ] **Step 1: Branch**

```bash
cd /Users/jacob/Documents/Programs/TvTalk
git switch -c add-survivor-show -t origin/main
```

- [ ] **Step 2: Write the failing test**

In `test/worker/migrations.test.js`, make the existing seed test exclude Survivor, and add a Survivor test to the same `describe('seed', ...)` block:

```js
    it('seeds Bake Off Season 14 and Lanterns Season 1', async () => {
        const { results } = await env.DB.prepare(
            `SELECT shows.name AS show, seasons.number AS number, seasons.episode_count AS episodes
             FROM seasons JOIN shows ON shows.id = seasons.show_id
             WHERE shows.name <> 'Survivor'
             ORDER BY shows.name ASC`,
        ).all();
        expect(results).toEqual([
            { show: 'Lanterns', number: 1, episodes: 8 },
            { show: 'The Great British Bake Off', number: 14, episodes: 10 },
        ]);
    });

    // Outwatch (../Outwatch) reads and writes this database as a Survivor-only
    // frontend and finds the show by this exact name. The episode counts were
    // transcribed by hand from Wikipedia: a dropped value leaves a 0 and a
    // slipped digit leaves a 130, and both are caught here.
    it('seeds Survivor seasons 1–51 for Outwatch', async () => {
        const { results } = await env.DB.prepare(
            `SELECT seasons.number AS number, seasons.subtitle AS subtitle,
                    seasons.url AS url, seasons.episode_count AS episodes
             FROM seasons JOIN shows ON shows.id = seasons.show_id
             WHERE shows.name = 'Survivor'
             ORDER BY seasons.number ASC`,
        ).all();
        expect(results.map((r) => r.number)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
        for (const season of results) {
            expect(season.episodes).toBeGreaterThanOrEqual(12);
            expect(season.episodes).toBeLessThanOrEqual(17);
        }
        expect(results[0]).toEqual({
            number: 1,
            subtitle: 'Borneo',
            url: 'https://en.wikipedia.org/wiki/Survivor:_Borneo',
            episodes: 13,
        });
        expect(results[50].url).toBe('https://en.wikipedia.org/wiki/Survivor_51');
    });
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: FAIL in "seeds Survivor seasons 1–51 for Outwatch" (`expected [] to equal [1, 2, …]`).

- [ ] **Step 4: Write the migration**

Create `migrations/0003_survivor.sql`. The values are Outwatch's seasons table as its migrations `0002`, `0005`, and `0012` leave it, copied verbatim:

```sql
-- Survivor, shared with Outwatch (../Outwatch). Outwatch binds this same
-- database and is a Survivor-only frontend onto it: it finds the show by this
-- exact name, so renaming it breaks Outwatch. Seasons 1–51 are Outwatch's
-- reference data, carried over with their subtitles, Wikipedia links, and
-- episode counts (reunion specials excluded). Later seasons are added from
-- either app rather than by migration.
INSERT INTO shows (name, url, created_at) VALUES
    ('Survivor', 'https://en.wikipedia.org/wiki/Survivor_(American_TV_series)', '2026-10-10T00:00:00.000Z');

INSERT INTO seasons (show_id, number, subtitle, url, episode_count, created_at)
SELECT shows.id, v.column1, v.column2, v.column3, v.column4, '2026-10-10T00:00:00.000Z'
FROM shows, (VALUES
    (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo', 13),
    (2, 'The Australian Outback', 'https://en.wikipedia.org/wiki/Survivor:_The_Australian_Outback', 15),
    (3, 'Africa', 'https://en.wikipedia.org/wiki/Survivor:_Africa', 14),
    (4, 'Marquesas', 'https://en.wikipedia.org/wiki/Survivor:_Marquesas', 14),
    (5, 'Thailand', 'https://en.wikipedia.org/wiki/Survivor:_Thailand', 14),
    (6, 'The Amazon', 'https://en.wikipedia.org/wiki/Survivor:_The_Amazon', 14),
    (7, 'Pearl Islands', 'https://en.wikipedia.org/wiki/Survivor:_Pearl_Islands', 14),
    (8, 'All-Stars', 'https://en.wikipedia.org/wiki/Survivor:_All-Stars', 16),
    (9, 'Vanuatu', 'https://en.wikipedia.org/wiki/Survivor:_Vanuatu', 14),
    (10, 'Palau', 'https://en.wikipedia.org/wiki/Survivor:_Palau', 14),
    (11, 'Guatemala', 'https://en.wikipedia.org/wiki/Survivor:_Guatemala', 14),
    (12, 'Panama', 'https://en.wikipedia.org/wiki/Survivor:_Panama', 15),
    (13, 'Cook Islands', 'https://en.wikipedia.org/wiki/Survivor:_Cook_Islands', 15),
    (14, 'Fiji', 'https://en.wikipedia.org/wiki/Survivor:_Fiji', 14),
    (15, 'China', 'https://en.wikipedia.org/wiki/Survivor:_China', 14),
    (16, 'Micronesia', 'https://en.wikipedia.org/wiki/Survivor:_Micronesia', 14),
    (17, 'Gabon', 'https://en.wikipedia.org/wiki/Survivor:_Gabon', 13),
    (18, 'Tocantins', 'https://en.wikipedia.org/wiki/Survivor:_Tocantins', 14),
    (19, 'Samoa', 'https://en.wikipedia.org/wiki/Survivor:_Samoa', 15),
    (20, 'Heroes vs. Villains', 'https://en.wikipedia.org/wiki/Survivor:_Heroes_vs._Villains', 14),
    (21, 'Nicaragua', 'https://en.wikipedia.org/wiki/Survivor:_Nicaragua', 15),
    (22, 'Redemption Island', 'https://en.wikipedia.org/wiki/Survivor:_Redemption_Island', 14),
    (23, 'South Pacific', 'https://en.wikipedia.org/wiki/Survivor:_South_Pacific', 15),
    (24, 'One World', 'https://en.wikipedia.org/wiki/Survivor:_One_World', 14),
    (25, 'Philippines', 'https://en.wikipedia.org/wiki/Survivor:_Philippines', 14),
    (26, 'Caramoan', 'https://en.wikipedia.org/wiki/Survivor:_Caramoan', 14),
    (27, 'Blood vs. Water', 'https://en.wikipedia.org/wiki/Survivor:_Blood_vs._Water', 14),
    (28, 'Cagayan', 'https://en.wikipedia.org/wiki/Survivor:_Cagayan', 13),
    (29, 'San Juan del Sur', 'https://en.wikipedia.org/wiki/Survivor:_San_Juan_del_Sur', 14),
    (30, 'Worlds Apart', 'https://en.wikipedia.org/wiki/Survivor:_Worlds_Apart', 14),
    (31, 'Cambodia', 'https://en.wikipedia.org/wiki/Survivor:_Cambodia', 14),
    (32, 'Kaôh Rōng', 'https://en.wikipedia.org/wiki/Survivor:_Kaôh_Rōng', 14),
    (33, 'Millennials vs. Gen X', 'https://en.wikipedia.org/wiki/Survivor:_Millennials_vs._Gen_X', 13),
    (34, 'Game Changers', 'https://en.wikipedia.org/wiki/Survivor:_Game_Changers', 12),
    (35, 'Heroes vs. Healers vs. Hustlers', 'https://en.wikipedia.org/wiki/Survivor:_Heroes_vs._Healers_vs._Hustlers', 13),
    (36, 'Ghost Island', 'https://en.wikipedia.org/wiki/Survivor:_Ghost_Island', 13),
    (37, 'David vs. Goliath', 'https://en.wikipedia.org/wiki/Survivor:_David_vs._Goliath', 13),
    (38, 'Edge of Extinction', 'https://en.wikipedia.org/wiki/Survivor:_Edge_of_Extinction', 13),
    (39, 'Island of the Idols', 'https://en.wikipedia.org/wiki/Survivor:_Island_of_the_Idols', 13),
    (40, 'Winners at War', 'https://en.wikipedia.org/wiki/Survivor:_Winners_at_War', 14),
    (41, '', 'https://en.wikipedia.org/wiki/Survivor_41', 13),
    (42, '', 'https://en.wikipedia.org/wiki/Survivor_42', 13),
    (43, '', 'https://en.wikipedia.org/wiki/Survivor_43', 13),
    (44, '', 'https://en.wikipedia.org/wiki/Survivor_44', 13),
    (45, '', 'https://en.wikipedia.org/wiki/Survivor_45', 13),
    (46, '', 'https://en.wikipedia.org/wiki/Survivor_46', 13),
    (47, '', 'https://en.wikipedia.org/wiki/Survivor_47', 14),
    (48, '', 'https://en.wikipedia.org/wiki/Survivor_48', 13),
    (49, '', 'https://en.wikipedia.org/wiki/Survivor_49', 13),
    (50, 'In the Hands of the Fans', 'https://en.wikipedia.org/wiki/Survivor_50', 13),
    (51, '', 'https://en.wikipedia.org/wiki/Survivor_51', 13)
) AS v
WHERE shows.name = 'Survivor';
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run test/worker/migrations.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. If a suite elsewhere asserts the full list of shows or seasons without clearing them first, scope that assertion to exclude `Survivor` the same way Step 2 does, then rerun.

- [ ] **Step 7: Document the coupling in TV Talk's AGENTS.md**

Insert this paragraph after the one beginning "`shows` and `seasons` are seeded by migration `0002`":

```markdown
Migration `0003` adds the show `Survivor` with seasons 1–51. That show is
shared: Outwatch (`../Outwatch`) binds this same D1 database and is a
Survivor-only frontend onto it, so its notes, watched marks, timers, and every
other Survivor row are the same rows TV Talk reads. Three consequences: the
show's name `Survivor` is load-bearing (Outwatch looks the show up by name),
every schema change has to be copied into Outwatch's `migrations/` (a
byte-identical snapshot of this directory) and must keep Outwatch's queries
working, and roster changes made here apply to Outwatch as well.
```

Also add `0003_survivor.sql` to any migrations list in TV Talk's `README.md`, if it has one (`grep -n 0002 README.md`).

- [ ] **Step 8: Verify and commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all pass. Then commit with the `jluszcz:commit` skill, with message `Add the Survivor show for Outwatch`.

---

### Task 2: Outwatch — run on TV Talk's schema

Works in Outwatch. This task is one atomic change: once the schema is swapped, nothing passes until the Worker is ported.

**Files:**
- Create: `scripts/outwatch-schema.sql` (Outwatch's final schema before the move, frozen for the importer in Task 4)
- Replace: `migrations/*` with a copy of `../TvTalk/migrations/*`
- Modify: `wrangler.toml` (`[[d1_databases]]`)
- Create: `test/worker/survivor.js` (fixture helpers)
- Create: `test/worker/survivor-scope.test.js`
- Modify: `test/worker/index.test.js`, `test/worker/discussion.test.js`, `test/worker/feed.test.js`, `test/worker/access.test.js` (fixtures only)
- Rewrite: `test/worker/migrations.test.js`
- Modify: `src/index.js`

**Interfaces:**
- Consumes: the `Survivor` show from Task 1, through the copied migrations.
- Produces:
  - `resetDatabase()` and `insertSurvivorSeasons(rows)` in `test/worker/survivor.js`.
  - In `src/index.js`: `resolveSeason(c, number)`, which returns `{ row_id, id, subtitle, wikipedia_url, episode_count } | null`. `resolveEpisode(c)` now returns `{ season, episode }` with `season.row_id` set.

- [ ] **Step 1: Freeze Outwatch's current schema for the importer**

```bash
cd /Users/jacob/Documents/Programs/Outwatch
S=/private/tmp/claude-501/-Users-jacob-Documents-Programs-Outwatch/8dbd3b03-d653-4ec6-bd7a-403d886bc0d9/scratchpad
rm -f "$S/ow-schema.db"
for f in migrations/*.sql; do sqlite3 "$S/ow-schema.db" < "$f"; done
{ echo "-- Outwatch's schema as its own migrations 0001–0012 left it, before it moved onto"
  echo "-- TV Talk's database. Frozen for scripts/import-to-tvtalk.py and its test, which read"
  echo "-- an export of the old outwatch database. Not applied anywhere."
  sqlite3 "$S/ow-schema.db" .schema | grep -v '^CREATE TABLE sqlite_sequence'; } > scripts/outwatch-schema.sql
```

Expected: `scripts/outwatch-schema.sql` contains `CREATE TABLE seasons`, `CREATE TABLE posts`, `CREATE TABLE reactions`, and `currently_watching_season_id`.

- [ ] **Step 2: Swap in TV Talk's migrations and binding**

```bash
git rm -q migrations/*.sql
cp ../TvTalk/migrations/*.sql migrations/
diff -r ../TvTalk/migrations migrations && echo IDENTICAL
```

Expected: `IDENTICAL`.

In `wrangler.toml`, replace the `[[d1_databases]]` block with:

```toml
# TV Talk's database (../TvTalk). Outwatch is a Survivor-only frontend onto it,
# and TV Talk owns the schema: migrations/ here is a byte-identical copy of
# TV Talk's, kept so local dev and CI have the real schema. Never run
# `wrangler d1 migrations apply --remote` from this repo; apply from TV Talk.
[[d1_databases]]
binding = "DB"
database_name = "tvtalk"
database_id = "c58bdae1-7fa4-4332-806b-cffeb8e26080"
migrations_dir = "migrations"
```

- [ ] **Step 3: Add the fixture helpers**

Create `test/worker/survivor.js`:

```js
import { env } from 'cloudflare:test';

// Children before parents: D1 enforces foreign keys, and every table here
// points at users, seasons, or posts. Shows are left alone. The Survivor row
// comes from TV Talk's migration 0003 and is what every route looks up.
export async function resetDatabase() {
    for (const table of [
        'reactions',
        'watch_sessions',
        'watch_offsets',
        'episode_statuses',
        'reveals',
        'posts',
        'watched',
        'currently_watching',
        'user_emails',
        'users',
        'seasons',
    ]) {
        await env.DB.exec(`DELETE FROM ${table}`);
    }
}

// Seeds Survivor seasons. `row_id` defaults to the season number, which keeps
// every fixture that writes season_id directly meaning the same season it
// always did. survivor-scope.test.js passes a different row_id on purpose, to
// pull the two apart.
export async function insertSurvivorSeasons(rows) {
    for (const {
        number,
        row_id = number,
        subtitle = '',
        url = `https://en.wikipedia.org/wiki/Survivor_${number}`,
        episode_count = 13,
    } of rows) {
        await env.DB.prepare(
            `INSERT INTO seasons (id, show_id, number, subtitle, url, episode_count, created_at)
             SELECT ?, id, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z' FROM shows WHERE name = 'Survivor'`,
        )
            .bind(row_id, number, subtitle, url, episode_count)
            .run();
    }
}

export async function survivorShowId() {
    const row = await env.DB.prepare("SELECT id FROM shows WHERE name = 'Survivor'").first();
    return row.id;
}
```

- [ ] **Step 4: Point the existing suites' fixtures at the helpers**

In each of `index.test.js`, `discussion.test.js`, `feed.test.js`, and `access.test.js`:

1. Import the helpers: `import { resetDatabase, insertSurvivorSeasons } from './survivor.js';`
2. Replace the run of `env.DB.exec('DELETE FROM …')` lines at the top of the suite's `beforeEach` with `await resetDatabase();`.
3. Replace every `INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES …` with a call to `insertSurvivorSeasons`, passing the same values. For example, `index.test.js:70-75` becomes:

```js
    await insertSurvivorSeasons([
        {
            number: 1,
            subtitle: 'Borneo',
            url: 'https://en.wikipedia.org/wiki/Survivor:_Borneo',
            episode_count: 13,
        },
        { number: 41, episode_count: 13 },
    ]);
```

   and `feed.test.js:192-196` becomes `await insertSurvivorSeasons([{ number: 45 }, { number: 46 }]);`. Apply the same translation to `discussion.test.js:54` and any other `INSERT INTO seasons` found by `grep -n "INSERT INTO seasons" test/worker/*.test.js`.
4. Replace every direct read of a season by id with a read by number, scoped to Survivor. `grep -n "FROM seasons" test/worker/*.test.js` finds them. For example, `index.test.js:676`:

```js
        const row = await env.DB.prepare(
            "SELECT 1 FROM seasons WHERE number = 42 AND show_id = (SELECT id FROM shows WHERE name = 'Survivor')",
        ).first();
```

   and `index.test.js:648` becomes `SELECT COUNT(*) AS count FROM seasons WHERE show_id = (SELECT id FROM shows WHERE name = 'Survivor')`. A `SELECT episode_count FROM seasons WHERE id = 41` becomes `... WHERE number = 41 AND show_id = (…)`.

   Do not change direct `INSERT INTO posts / watched / reveals / watch_sessions / watch_offsets / episode_statuses` fixtures. Their `season_id` values are season numbers, and the default `row_id = number` keeps them correct.

- [ ] **Step 5: Rewrite the migrations suite**

Replace `test/worker/migrations.test.js` with:

```js
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

// The schema is TV Talk's (migrations/ is a copy of ../TvTalk/migrations), and
// TV Talk's own suite tests its history. What Outwatch depends on is that the
// copy carries the Survivor show it looks up by name, with the seeded seasons.
describe('Survivor in the shared schema', () => {
    it('has a Survivor show with seasons 1–51', async () => {
        const { results } = await env.DB.prepare(
            `SELECT seasons.number AS number, seasons.episode_count AS episode_count
             FROM seasons JOIN shows ON shows.id = seasons.show_id
             WHERE shows.name = 'Survivor' ORDER BY seasons.number ASC`,
        ).all();
        expect(results.map((r) => r.number)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
        for (const season of results) {
            expect(season.episode_count).toBeGreaterThanOrEqual(12);
            expect(season.episode_count).toBeLessThanOrEqual(17);
        }
    });

    it('has the tables the Worker reads', async () => {
        const { results } = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all();
        const names = results.map((r) => r.name);
        for (const table of [
            'shows',
            'seasons',
            'currently_watching',
            'posts',
            'reactions',
            'reveals',
            'watch_sessions',
            'watch_offsets',
            'episode_statuses',
        ]) {
            expect(names).toContain(table);
        }
    });
});
```

This suite runs before any `resetDatabase()` only if Vitest isolates storage per test file, which `@cloudflare/vitest-pool-workers` does. If the suite sees no seasons, it is sharing storage with another file. In that case, apply the migrations fresh inside this file instead of relying on the seed.

- [ ] **Step 6: Write the scope suite (the failing tests)**

Create `test/worker/survivor-scope.test.js`. Throughout this suite each Survivor season's row id differs from its number, and another show owns a season whose row id equals a Survivor number:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/index.js';
import { accessEnv, signAccessToken, stubJwksEndpoint } from './access-token.js';
import { resetDatabase, insertSurvivorSeasons, survivorShowId } from './survivor.js';

// Outwatch's API speaks Survivor season numbers; TV Talk's tables key on a
// surrogate seasons.id. The other suites seed row id === number, so they
// cannot tell the two apart. Here they always differ (Survivor 1 is row 101,
// Survivor 2 is row 102), and a Lanterns season sits on row 1, the id a
// number/row mix-up would hit.

function makeEnv() {
    return {
        ...env,
        ...accessEnv,
        DEV_USER_EMAIL: undefined,
        ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('index.html')) },
        DB: env.DB,
    };
}

async function req(method, path, { body, email = 'alice@example.com' } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    if (email) init.headers['Cf-Access-Jwt-Assertion'] = await signAccessToken({ email });
    return worker.fetch(new Request(`https://example.com${path}`, init), makeEnv());
}

const LANTERNS_ROW = 1;

async function insertPost({ season_id, episode = 1, user_id = 'user-bob', email = 'bob@example.com' }) {
    const row = await env.DB.prepare(
        `INSERT INTO posts (season_id, episode, user_id, body, created_at, author_email)
         VALUES (?, ?, ?, 'tribal was wild', ?, ?) RETURNING id`,
    )
        .bind(season_id, episode, user_id, new Date().toISOString(), email)
        .first();
    return row.id;
}

beforeEach(async () => {
    await stubJwksEndpoint();
    await resetDatabase();
    await env.DB.exec(
        "INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1), ('user-bob', 'Bob & Carol', 2)",
    );
    await env.DB.exec(
        'INSERT INTO user_emails (email, user_id, name) VALUES ' +
            "('alice@example.com', 'user-alice', NULL), " +
            "('bob@example.com', 'user-bob', 'Bob'), " +
            "('carol@example.com', 'user-bob', 'Carol')",
    );
    await insertSurvivorSeasons([
        { number: 1, row_id: 101, subtitle: 'Borneo', episode_count: 13 },
        { number: 2, row_id: 102, episode_count: 15 },
    ]);
    await env.DB.exec(
        `INSERT INTO seasons (id, show_id, number, subtitle, url, episode_count, created_at)
         SELECT ${LANTERNS_ROW}, id, 5, '', '', 8, '2026-01-01T00:00:00.000Z' FROM shows WHERE name = 'Lanterns'`,
    );
});

describe('board', () => {
    it('lists only Survivor seasons, by number', async () => {
        await insertPost({ season_id: 101 });
        await insertPost({ season_id: LANTERNS_ROW });
        await env.DB.exec(
            "INSERT INTO watched (user_id, season_id, created_at) VALUES ('user-alice', 101, 'x'), ('user-alice', 1, 'x')",
        );
        const board = await (await req('GET', '/api/board')).json();
        expect(board.seasons.map((s) => s.id)).toEqual([1, 2]);
        expect(board.seasons[0]).toMatchObject({
            id: 1,
            subtitle: 'Borneo',
            episode_count: 13,
            post_count: 1,
            watched_by: ['user-alice'],
        });
        expect(board.seasons[0]).not.toHaveProperty('row_id');
        expect(board.seasons[1]).toMatchObject({ id: 2, post_count: 0, watched_by: [] });
    });

    it("ignores a currently-watching pick on another show", async () => {
        await env.DB.exec(
            `INSERT INTO currently_watching (user_id, show_id, season_id)
             SELECT 'user-alice', id, ${LANTERNS_ROW} FROM shows WHERE name = 'Lanterns'`,
        );
        const board = await (await req('GET', '/api/board')).json();
        const alice = board.users.find((u) => u.id === 'user-alice');
        expect(alice.currently_watching_season_id).toBeNull();
    });
});

describe('watched and currently-watching', () => {
    it('writes the row id and answers with the number', async () => {
        const r = await req('POST', '/api/watched', { body: { season_id: 1 } });
        expect(r.status).toBe(201);
        expect((await r.json()).season_id).toBe(1);
        const row = await env.DB.prepare(
            "SELECT season_id FROM watched WHERE user_id = 'user-alice'",
        ).first();
        expect(row.season_id).toBe(101);

        expect((await req('DELETE', '/api/watched/1')).status).toBe(200);
        const gone = await env.DB.prepare("SELECT 1 FROM watched WHERE user_id = 'user-alice'").first();
        expect(gone).toBeNull();
    });

    it('treats an unknown number as a no-op on unwatch', async () => {
        expect((await req('DELETE', '/api/watched/99')).status).toBe(200);
    });

    it('sets, reports, and clears a Survivor pick without touching another show', async () => {
        await env.DB.exec(
            `INSERT INTO currently_watching (user_id, show_id, season_id)
             SELECT 'user-alice', id, ${LANTERNS_ROW} FROM shows WHERE name = 'Lanterns'`,
        );
        const put = await req('PUT', '/api/currently-watching', { body: { season_id: 2 } });
        expect(put.status).toBe(200);
        expect((await put.json()).season_id).toBe(2);

        const show = await survivorShowId();
        const pick = await env.DB.prepare(
            "SELECT season_id FROM currently_watching WHERE user_id = 'user-alice' AND show_id = ?",
        )
            .bind(show)
            .first();
        expect(pick.season_id).toBe(102);
        const board = await (await req('GET', '/api/board')).json();
        expect(board.users.find((u) => u.id === 'user-alice').currently_watching_season_id).toBe(2);

        // Finishing the season clears the Survivor pick only.
        await req('POST', '/api/watched', { body: { season_id: 2 } });
        const { results } = await env.DB.prepare(
            "SELECT season_id FROM currently_watching WHERE user_id = 'user-alice'",
        ).all();
        expect(results).toEqual([{ season_id: LANTERNS_ROW }]);

        await req('PUT', '/api/currently-watching', { body: { season_id: 1 } });
        await req('PUT', '/api/currently-watching', { body: { season_id: null } });
        const after = await env.DB.prepare(
            "SELECT season_id FROM currently_watching WHERE user_id = 'user-alice'",
        ).all();
        expect(after.results).toEqual([{ season_id: LANTERNS_ROW }]);
    });

    it('refuses a pick the caller has already watched', async () => {
        await req('POST', '/api/watched', { body: { season_id: 1 } });
        const r = await req('PUT', '/api/currently-watching', { body: { season_id: 1 } });
        expect(r.status).toBe(409);
    });

    it('404s a number with no Survivor season', async () => {
        const r = await req('PUT', '/api/currently-watching', { body: { season_id: 5 } });
        expect(r.status).toBe(404);
    });
});

describe('seasons', () => {
    it("numbers the next season from Survivor's seasons only", async () => {
        // Lanterns has a season 5; Survivor's next is still 3.
        const r = await req('POST', '/api/seasons', { body: { id: 3, episode_count: 14 } });
        expect(r.status).toBe(201);
        expect(await r.json()).toEqual({
            id: 3,
            subtitle: '',
            wikipedia_url: 'https://en.wikipedia.org/wiki/Survivor_3',
            episode_count: 14,
        });
        expect((await req('POST', '/api/seasons', { body: { id: 6, episode_count: 14 } })).status).toBe(
            409,
        );
    });

    it('edits the Survivor season, not the row whose id equals the number', async () => {
        const r = await req('PATCH', '/api/seasons/1', { body: { subtitle: 'Pulau Tiga' } });
        expect(r.status).toBe(200);
        expect((await r.json()).id).toBe(1);
        const lanterns = await env.DB.prepare('SELECT subtitle FROM seasons WHERE id = ?')
            .bind(LANTERNS_ROW)
            .first();
        expect(lanterns.subtitle).toBe('');
    });

    it('applies the shrink guard to the resolved row', async () => {
        await insertPost({ season_id: 101, episode: 12 });
        const r = await req('PATCH', '/api/seasons/1', { body: { episode_count: 10 } });
        expect(r.status).toBe(409);
    });

    it('404s an edit to a number with no Survivor season', async () => {
        expect((await req('PATCH', '/api/seasons/5', { body: { subtitle: 'x' } })).status).toBe(404);
    });
});

describe('discussion and episode routes', () => {
    it('posts onto the row id and reads back by number', async () => {
        const post = await req('POST', '/api/seasons/1/episodes/2/posts', { body: { body: 'hi' } });
        expect(post.status).toBe(201);
        const row = await env.DB.prepare('SELECT season_id FROM posts').first();
        expect(row.season_id).toBe(101);

        const d = await (await req('GET', '/api/seasons/1/discussion')).json();
        expect(d.season).toEqual({
            id: 1,
            subtitle: 'Borneo',
            wikipedia_url: 'https://en.wikipedia.org/wiki/Survivor_1',
            episode_count: 13,
        });
        expect(d.episodes).toHaveLength(13);
        expect(d.episodes[1].posts.map((p) => p.body)).toEqual(['hi']);
    });

    it('accepts a reply only to a post on the same Survivor season', async () => {
        const parent = await insertPost({ season_id: 101, episode: 1, user_id: 'user-alice', email: 'alice@example.com' });
        const ok = await req('POST', '/api/seasons/1/episodes/1/posts', {
            body: { body: 'agreed', reply_to_post_id: parent },
        });
        expect(ok.status).toBe(201);
        const foreign = await insertPost({ season_id: LANTERNS_ROW, user_id: 'user-alice', email: 'alice@example.com' });
        const bad = await req('POST', '/api/seasons/1/episodes/1/posts', {
            body: { body: 'agreed', reply_to_post_id: foreign },
        });
        expect(bad.status).toBe(404);
    });

    it('writes reveals, timers, offsets, and statuses against the row id', async () => {
        const reveal = await req('POST', '/api/seasons/1/episodes/3/reveal');
        expect((await reveal.json()).season_id).toBe(1);
        const timer = await req('POST', '/api/seasons/1/episodes/3/timer', { body: { action: 'start' } });
        expect((await timer.json()).season_id).toBe(1);
        await req('PUT', '/api/seasons/1/episodes/3/offset', { body: { adjust_secs: 30 } });
        await req('PUT', '/api/seasons/1/episodes/3/status', {
            body: { status: 'skipping', reason: 'recap' },
        });
        for (const table of ['reveals', 'watch_sessions', 'watch_offsets', 'episode_statuses']) {
            const row = await env.DB.prepare(`SELECT season_id FROM ${table}`).first();
            expect(row.season_id, table).toBe(101);
        }
        const d = await (await req('GET', '/api/seasons/1/discussion')).json();
        expect(d.episodes[2]).toMatchObject({ readable: true, hideable: true, adjust_secs: 30 });
        expect(d.episodes[2].session).not.toBeNull();
        expect(d.episodes[2].statuses).toEqual([
            { user_id: 'user-alice', name: 'Alice', status: 'skipping', reason: 'recap' },
        ]);
    });

    it('404s a discussion for a number with no Survivor season', async () => {
        expect((await req('GET', '/api/seasons/5/discussion')).status).toBe(404);
    });
});

describe("another show's notes", () => {
    it('cannot be edited, deleted, or reacted to', async () => {
        await env.DB.exec(
            "INSERT INTO watched (user_id, season_id, created_at) VALUES ('user-bob', 1, 'x')",
        );
        const id = await insertPost({ season_id: LANTERNS_ROW });
        const asBob = { email: 'bob@example.com' };
        expect((await req('PATCH', `/api/posts/${id}`, { ...asBob, body: { body: 'x' } })).status).toBe(404);
        expect(
            (await req('PUT', `/api/posts/${id}/reactions`, { ...asBob, body: { emoji: '🔥', on: true } }))
                .status,
        ).toBe(404);
        expect((await req('DELETE', `/api/posts/${id}`, asBob)).status).toBe(404);
        const still = await env.DB.prepare('SELECT 1 FROM posts WHERE id = ?').bind(id).first();
        expect(still).not.toBeNull();
    });

    it('stay out of the feed, which reports Survivor numbers', async () => {
        await insertPost({ season_id: LANTERNS_ROW });
        await insertPost({ season_id: 102, episode: 4 });
        const feed = await (await req('GET', '/api/feed')).json();
        expect(feed.events).toHaveLength(1);
        expect(feed.events[0]).toMatchObject({ author_name: 'Bob', season_id: 2, episode: 4 });
        expect(feed.unread_count).toBe(1);
    });
});
```

- [ ] **Step 7: Run the suites and confirm the expected failures**

Run: `npm test`
Expected: FAIL. Errors such as `no such column: wikipedia_url` or `no such column: currently_watching_season_id` come from `src/index.js`. The scope suite fails on the same errors. No failure should come from the fixtures themselves (for example `no such table`, or `FOREIGN KEY constraint failed` inside `beforeEach`). If one does, fix the fixture before porting.

- [ ] **Step 8: Port `src/index.js` — the season helpers**

After `app.use('/api/*', …)` and before `callerEmail`, add:

```js
// Outwatch is the Survivor slice of TV Talk's database (../TvTalk), which owns
// the schema. Everything Outwatch's API says about a season, in paths, bodies,
// and responses, is the Survivor season number. TV Talk keys every table on a
// surrogate seasons.id instead. resolveSeason is where a number becomes that
// row id: carried as `row_id` and never serialized. The show is found by name
// because its autoincrement id is not the same in every database.
const SURVIVOR_SHOW_ID = "(SELECT id FROM shows WHERE name = 'Survivor')";
const SURVIVOR_SEASON_IDS = `(SELECT id FROM seasons WHERE show_id = ${SURVIVOR_SHOW_ID})`;
const SEASON_COLUMNS = 'id AS row_id, number AS id, subtitle, url AS wikipedia_url, episode_count';

function resolveSeason(c, number) {
    return c.env.DB.prepare(
        `SELECT ${SEASON_COLUMNS} FROM seasons WHERE show_id = ${SURVIVOR_SHOW_ID} AND number = ?`,
    )
        .bind(number)
        .first();
}

function publicSeason({ id, subtitle, wikipedia_url, episode_count }) {
    return { id, subtitle, wikipedia_url, episode_count };
}
```

- [ ] **Step 9: Port `GET /api/board`**

Replace the handler body (`src/index.js:201-245`) with:

```js
app.get('/api/board', async (c) => {
    const [
        me,
        { results: users },
        { results: seasons },
        { results: watched },
        { results: counts },
        { results: picks },
    ] = await Promise.all([
        callerUser(c),
        c.env.DB.prepare('SELECT id, name FROM users ORDER BY sort_order ASC, name ASC').all(),
        c.env.DB.prepare(
            `SELECT ${SEASON_COLUMNS} FROM seasons
             WHERE show_id = ${SURVIVOR_SHOW_ID} ORDER BY number ASC`,
        ).all(),
        // Every show's rows come back; only Survivor row ids match a season below.
        c.env.DB.prepare('SELECT season_id, user_id FROM watched').all(),
        // Post counts let the board show which seasons have any discussion at
        // all — without it there is nothing to click towards.
        c.env.DB.prepare(
            'SELECT season_id, COUNT(*) AS post_count FROM posts GROUP BY season_id',
        ).all(),
        c.env.DB.prepare(
            `SELECT currently_watching.user_id AS user_id, seasons.number AS number
             FROM currently_watching JOIN seasons ON seasons.id = currently_watching.season_id
             WHERE currently_watching.show_id = ${SURVIVOR_SHOW_ID}`,
        ).all(),
    ]);

    const watchedBySeason = new Map(seasons.map((s) => [s.row_id, []]));
    for (const row of watched) {
        watchedBySeason.get(row.season_id)?.push(row.user_id);
    }

    const postCounts = new Map(counts.map((row) => [row.season_id, row.post_count]));
    const pickByUser = new Map(picks.map((row) => [row.user_id, row.number]));

    const board = seasons.map((s) => ({
        ...publicSeason(s),
        post_count: postCounts.get(s.row_id) ?? 0,
        watched_by: watchedBySeason.get(s.row_id),
    }));

    return c.json({
        me: me ? { id: me.id, name: me.name } : null,
        users: users.map((u) => ({
            ...u,
            currently_watching_season_id: pickByUser.get(u.id) ?? null,
        })),
        seasons: board,
    });
});
```

- [ ] **Step 10: Port currently-watching and watched**

In `PUT /api/currently-watching`, replace the body from `if (season_id !== null) {` to the closing `}` of the `else` with:

```js
        if (season_id !== null) {
            const season = await resolveSeason(c, season_id);
            if (!season) return c.json({ error: `Unknown season: ${season_id}` }, 404);

            // Invariant: your currently-watching season is always one of your
            // unwatched seasons. The picker only offers those; enforce it here
            // too so a direct API call can't break it. The not-watched check and
            // the write are a single statement so a concurrent POST /api/watched
            // can't land between them and leave you "watching" a watched season.
            const { meta } = await c.env.DB.prepare(
                `INSERT INTO currently_watching (user_id, show_id, season_id)
                 SELECT ?2, show_id, id FROM seasons
                 WHERE id = ?1
                   AND NOT EXISTS (SELECT 1 FROM watched WHERE user_id = ?2 AND season_id = ?1)
                 ON CONFLICT (user_id, show_id) DO UPDATE SET season_id = excluded.season_id`,
            )
                .bind(season.row_id, me.id)
                .run();
            if (meta.changes === 0) {
                return c.json({ error: `You have already watched season ${season_id}` }, 409);
            }
        } else {
            await c.env.DB.prepare(
                `DELETE FROM currently_watching WHERE user_id = ? AND show_id = ${SURVIVOR_SHOW_ID}`,
            )
                .bind(me.id)
                .run();
        }
```

In `POST /api/watched`, replace the season lookup and batch with:

```js
    const season = await resolveSeason(c, season_id);
    if (!season) return c.json({ error: `Unknown season: ${season_id}` }, 404);

    const now = new Date().toISOString();
    await c.env.DB.batch([
        c.env.DB.prepare(
            'INSERT OR IGNORE INTO watched (user_id, season_id, created_at) VALUES (?, ?, ?)',
        ).bind(me.id, season.row_id, now),
        // Finishing a season clears it as your currently-watching season — you
        // can't be mid-watch on something you've marked seen. No-op otherwise.
        c.env.DB.prepare(
            'DELETE FROM currently_watching WHERE user_id = ? AND season_id = ?',
        ).bind(me.id, season.row_id),
    ]);
```

In `DELETE /api/watched/:season_id`, replace the `DELETE` statement with:

```js
    await c.env.DB.prepare(
        `DELETE FROM watched
         WHERE user_id = ?
           AND season_id = (SELECT id FROM seasons WHERE show_id = ${SURVIVOR_SHOW_ID} AND number = ?)`,
    )
        .bind(me.id, seasonId)
        .run();
```

Also update that route's invariant comment: "currently_watching_season_id" becomes "Survivor `currently_watching` row".

- [ ] **Step 11: Port season create and edit**

In `POST /api/seasons`, replace the `INSERT` with:

```js
    const season = await c.env.DB.prepare(
        `INSERT INTO seasons (show_id, number, subtitle, url, episode_count, created_at)
         SELECT shows.id, ?1, ?2, ?3, ?4, ?5 FROM shows
         WHERE shows.name = 'Survivor'
           AND ?1 = (SELECT COALESCE(MAX(number), 0) + 1 FROM seasons WHERE show_id = shows.id)
         RETURNING number AS id, subtitle, url AS wikipedia_url, episode_count`,
    )
        .bind(
            id,
            subtitle,
            `https://en.wikipedia.org/wiki/Survivor_${id}`,
            episode_count,
            new Date().toISOString(),
        )
        .first();
```

In the comment above it, change "Picking MAX(id) + 1" to "Picking MAX(number) + 1".

In `PATCH /api/seasons/:season_id`, replace the `UPDATE` and the existence check with:

```js
    const season = await c.env.DB.prepare(
        `UPDATE seasons
         SET subtitle = COALESCE(?2, subtitle),
             episode_count = COALESCE(?3, episode_count)
         WHERE show_id = ${SURVIVOR_SHOW_ID} AND number = ?1
           AND (?3 IS NULL OR NOT EXISTS (
               SELECT 1 FROM posts            WHERE season_id = seasons.id AND episode > ?3
               UNION ALL
               SELECT 1 FROM reveals          WHERE season_id = seasons.id AND episode > ?3
               UNION ALL
               SELECT 1 FROM watch_sessions   WHERE season_id = seasons.id AND episode > ?3
               UNION ALL
               SELECT 1 FROM watch_offsets    WHERE season_id = seasons.id AND episode > ?3
               UNION ALL
               SELECT 1 FROM episode_statuses WHERE season_id = seasons.id AND episode > ?3
           ))
         RETURNING number AS id, subtitle, url AS wikipedia_url, episode_count`,
    )
        .bind(seasonId, subtitle, episode_count)
        .first();
    if (season) return c.json(season);

    if (!(await resolveSeason(c, seasonId))) {
        return c.json({ error: `Unknown season: ${seasonId}` }, 404);
    }
```

- [ ] **Step 12: Port the episode-scoped routes**

In `resolveEpisode`, replace the season query with `const season = await resolveSeason(c, seasonId);`. The returned `season` now carries `row_id` (for SQL) and `id` (the number, for responses and messages).

Then make every SQL bind of a season inside an episode-scoped route use `season.row_id`, and leave every response field as `season.id`:

- `POST …/posts`: `parent.season_id !== season.id` becomes `parent.season_id !== season.row_id`. `currentOffsetSecs(c, me.id, season.id, …)` becomes `season.row_id`. The two `.bind(season.id, …)` / `.bind(now, me.id, season.id, episode)` in the batch become `season.row_id`.
- `POST` and `DELETE …/reveal`: `.bind(me.id, season.id, …)` becomes `season.row_id`. The responses keep `season_id: season.id`.
- `POST …/timer`, `PUT …/offset`, `PUT …/status`: `const key = [me.id, season.id, episode];` becomes `[me.id, season.row_id, episode]`. The responses keep `season_id: season.id`.

Check with `grep -n "season\.id" src/index.js`. Every remaining hit must be a response field or an error message, never a `.bind(`, a `key`, or a comparison against a stored `season_id`.

- [ ] **Step 13: Port the discussion route**

In `GET /api/seasons/:season_id/discussion`, replace the season query with:

```js
    const season = await resolveSeason(c, seasonId);
    if (!season) return c.json({ error: `Unknown season: ${seasonId}` }, 404);
```

Change every `.bind(seasonId)` and `.bind(me.id, seasonId)` in the `Promise.all` to `season.row_id`, and the response's `season,` to `season: publicSeason(season),`.

- [ ] **Step 14: Scope the post-id routes and the feed to Survivor**

In `visiblePost`, change the query's `FROM posts WHERE id = ?` to:

```sql
FROM posts WHERE id = ? AND season_id IN ${SURVIVOR_SEASON_IDS}
```

In `PATCH /api/posts/:post_id`, add `AND season_id IN ${SURVIVOR_SEASON_IDS}` to the `UPDATE`'s `WHERE`. In `DELETE /api/posts/:post_id`, add the same clause to the ownership `SELECT`. Add one comment line above `visiblePost`: "Only Survivor's notes: Outwatch never shows another show's, so it does not act on them either."

In `GET /api/feed`, replace the query with:

```js
        c.env.DB.prepare(
            `SELECT seasons.number    AS season_id,
                    posts.episode     AS episode,
                    posts.user_id     AS user_id,
                    posts.author_email AS author_email,
                    posts.created_at  AS created_at,
                    COALESCE(LOWER(posts.author_email), 'user:' || posts.user_id) AS author_key
             FROM posts JOIN seasons ON seasons.id = posts.season_id
             WHERE seasons.show_id = ${SURVIVOR_SHOW_ID}
               AND posts.created_at >= ?
               AND CASE WHEN posts.author_email IS NULL
                        THEN posts.user_id <> ?
                        ELSE LOWER(posts.author_email) <> ?
                   END
             ORDER BY author_key ASC, seasons.number ASC, posts.episode ASC,
                      posts.created_at ASC`,
        )
```

- [ ] **Step 15: Run everything and confirm it passes**

Run: `npm test`
Expected: PASS, every suite including `survivor-scope.test.js`. For a remaining legacy failure, decide whether it comes from a fixture (fix it per Step 4) or from the port (fix `src/index.js`). Never weaken an assertion.

- [ ] **Step 16: Verify and commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all pass. Commit with the `jluszcz:commit` skill, with message `Run Outwatch on TV Talk's database as its Survivor slice`. The doc updates come in Task 3. Tell the commit skill that, so it doesn't block on stale docs.

---

### Task 3: Outwatch — dev tooling and documentation

**Files:**
- Modify: `seed.sql`
- Modify: `scripts/insert-test-post.py:83-86,106,146-149`
- Modify: `roster.example.sql`
- Modify: `README.md` (setup at ~153-168, roster at ~217-219, deploy at ~270-277, schema pointer at ~352)
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `resolveSeason` semantics from Task 2 (the number is the public id).

- [ ] **Step 1: `seed.sql`**

Rewrite the inserts so they resolve the season by number. Change the header comment's `outwatch` to `tvtalk`, and change "Seasons live in migration 0002" to "Survivor's seasons live in TV Talk's migration 0003":

```sql
INSERT OR IGNORE INTO watched (user_id, season_id, created_at)
SELECT v.column1, seasons.id, v.column3
FROM (VALUES
    ('user-1', 1,  '2026-01-01T00:00:00Z'),
    ('user-2', 1,  '2026-01-01T00:00:00Z'),
    ('user-3', 1,  '2026-01-01T00:00:00Z'),
    ('user-1', 20, '2026-01-02T00:00:00Z'),
    ('user-2', 20, '2026-01-02T00:00:00Z'),
    ('user-1', 40, '2026-01-03T00:00:00Z')
) AS v
JOIN seasons ON seasons.number = v.column2
            AND seasons.show_id = (SELECT id FROM shows WHERE name = 'Survivor');
```

Verify locally:

```bash
npx wrangler d1 migrations apply tvtalk --local
npx wrangler d1 execute tvtalk --local --file=roster.sql
npx wrangler d1 execute tvtalk --local --file=seed.sql
npx wrangler d1 execute tvtalk --local --command "SELECT COUNT(*) FROM watched"
```

Expected: a count of 6.

- [ ] **Step 2: `scripts/insert-test-post.py`**

`--season` stays the Survivor season number. `validate_season` returns the row id as well:

```python
def validate_season(conn, season_number):
    row = conn.execute(
        "SELECT id, episode_count FROM seasons WHERE number = ? "
        "AND show_id = (SELECT id FROM shows WHERE name = 'Survivor')",
        (season_number,),
    ).fetchone()
    if row is None:
        sys.exit(f"No Survivor season {season_number} in the local database.")
    return row
```

In `main`, unpack `season_row_id, episode_count = validate_season(conn, args.season)` and bind `season_row_id` in the `INSERT` instead of `args.season`. Change the `--season` help text to `"Survivor season number. Default: 1."`. Run it once against the local database from Step 1 and confirm the note appears in `npm run dev`.

- [ ] **Step 3: `roster.example.sql`**

Change the header's apply commands from `outwatch` to `tvtalk`, and add one line: "The roster is shared with TV Talk (../TvTalk), which owns it. Maintain it there; this template mirrors TV Talk's." Delete the one-time attribution `UPDATE posts` block and its comment. The import (Task 4) carries attributed notes across, and Outwatch production already ran the backfill.

- [ ] **Step 4: `README.md`**

- Setup: replace `wrangler d1 create outwatch` and the `migrations apply outwatch` lines with a note that the database is TV Talk's (`tvtalk`), created and migrated from `../TvTalk`. Local dev runs `npx wrangler d1 migrations apply tvtalk --local` here against the copied `migrations/`.
- Roster: point at TV Talk's `roster.sql`. Change local-only commands to `tvtalk --local`.
- Deploy: remove "apply any new migrations to production before deploying". Replace it with: "Schema changes are made and applied in TV Talk. Copy TV Talk's `migrations/` here (`cp ../TvTalk/migrations/*.sql migrations/`) and make sure `npm test` passes before deploying either app."
- The schema pointer at ~352 now points to TV Talk's migrations.

- [ ] **Step 5: `AGENTS.md`**

- Project Overview: add "Outwatch reads and writes TV Talk's D1 database (`../TvTalk`) and is a Survivor-only frontend onto it. Notes, watched marks, and every other Survivor row are shared with TV Talk."
- Repository Structure: `migrations/` is now "a byte-identical copy of TV Talk's migrations, the schema's owner. Never apply remotely from here." Add `scripts/outwatch-schema.sql` and (after Task 4) `scripts/import-to-tvtalk.py`. Add `test/worker/survivor.js` and `survivor-scope.test.js`.
- Database Schema: replace the table list with "TV Talk's schema (see `../TvTalk/AGENTS.md`), scoped to the show named `Survivor`". Then give the three differences that matter here:
  - `seasons` has a surrogate `id` plus `(show_id, number)`, and `url` in place of `wikipedia_url`.
  - Currently-watching lives in `currently_watching (user_id, show_id, season_id)`, not on `users`.
  - Every season-keyed table stores the surrogate id.

  Replace the "Seasons 1–51 (migration `0002`, plus `0012`…)" paragraph with the TV Talk `0003` equivalent.
- API Routes: add one paragraph before the list. "Every `season_id` in a path, body, or response is the Survivor season number. `resolveSeason` maps it to the surrogate `seasons.id` (`row_id`), which is used for every query and never serialized. Post-id routes (`PATCH`/`DELETE /api/posts/:id`, reactions) 404 a post on another show's season, and the feed lists only Survivor notes. `feed_seen_at` is shared with TV Talk, so opening the bell in either app clears both." In the `PUT /api/currently-watching` and `POST /api/watched` entries, replace `currently_watching_season_id` with the Survivor `currently_watching` row. In `POST /api/seasons`, `MAX(id) + 1` becomes `MAX(number) + 1` over Survivor's seasons.
- Rules: roster changes are made in TV Talk's `roster.sql`.

- [ ] **Step 6: Verify and commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all pass. Commit with the `jluszcz:commit` skill, with message `Document Outwatch running on TV Talk's database`.

---

### Task 4: Outwatch — one-time import script

**Files:**
- Create: `scripts/import-to-tvtalk.py`
- Create: `scripts/test_import_to_tvtalk.py`
- Uses: `scripts/outwatch-schema.sql` (Task 2) and `migrations/*.sql` (TV Talk's, copied in Task 2)

**Interfaces:**
- Produces: `generate(outwatch: sqlite3.Connection, post_id_offset: int) -> str`, which returns SQL to run against TV Talk. The CLI is `python3 scripts/import-to-tvtalk.py --outwatch <db.sqlite> --post-id-offset <n> > import.sql`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test_import_to_tvtalk.py`:

```python
"""Tests for import-to-tvtalk.py. Run: python3 -I -m unittest scripts/test_import_to_tvtalk.py"""

import glob
import importlib.util
import os
import sqlite3
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location("importer", os.path.join(HERE, "import-to-tvtalk.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

ROSTER = """
INSERT INTO users (id, name, sort_order) VALUES ('user-1', 'Alice', 1), ('user-2', 'Bob & Carol', 2);
INSERT INTO user_emails (email, user_id, name) VALUES
    ('alice@example.com', 'user-1', NULL),
    ('bob@example.com', 'user-2', 'Bob'),
    ('carol@example.com', 'user-2', 'Carol');
"""


def outwatch_db():
    conn = sqlite3.connect(":memory:")
    with open(os.path.join(HERE, "outwatch-schema.sql")) as f:
        conn.executescript(f.read())
    conn.executescript(ROSTER)
    conn.executescript("""
        INSERT INTO seasons (id, subtitle, wikipedia_url, episode_count) VALUES
            (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo', 14),
            (52, 'New Era', 'https://en.wikipedia.org/wiki/Survivor_52', 13);
        UPDATE users SET currently_watching_season_id = 52 WHERE id = 'user-1';
        INSERT INTO watched (user_id, season_id, created_at) VALUES ('user-2', 1, '2026-01-01T00:00:00Z');
        INSERT INTO posts (id, season_id, episode, user_id, body, created_at, offset_secs, author_email, reply_to_post_id, edited_at) VALUES
            (1, 52, 2, 'user-1', 'first', '2026-02-01T00:00:00Z', 90, 'alice@example.com', NULL, NULL),
            (2, 52, 2, 'user-2', 'reply', '2026-02-01T00:01:00Z', NULL, 'carol@example.com', 1, '2026-02-01T00:02:00Z');
        INSERT INTO reactions (post_id, email, emoji, created_at) VALUES (1, 'bob@example.com', '🔥', '2026-02-01T00:03:00Z');
        INSERT INTO reveals (user_id, season_id, episode, created_at) VALUES ('user-2', 52, 2, '2026-02-01T00:00:00Z');
        INSERT INTO watch_sessions (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at) VALUES ('user-1', 52, 2, 120, NULL, '2026-02-01T00:00:00Z');
        INSERT INTO watch_offsets (user_id, season_id, episode, adjust_secs, updated_at) VALUES ('user-1', 52, 2, -30, '2026-02-01T00:00:00Z');
        INSERT INTO episode_statuses (user_id, season_id, episode, status, reason, created_at) VALUES ('user-2', 52, 13, 'skipping', 'reunion', '2026-02-01T00:00:00Z');
        UPDATE user_emails SET feed_seen_at = '2026-03-01T00:00:00Z' WHERE email = 'alice@example.com';
        UPDATE user_emails SET feed_seen_at = '2026-01-01T00:00:00Z' WHERE email = 'bob@example.com';
    """)
    return conn


def tvtalk_db():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    for path in sorted(glob.glob(os.path.join(ROOT, "migrations", "*.sql"))):
        with open(path) as f:
            conn.executescript(f.read())
    conn.executescript(ROSTER)
    # An existing TV Talk note, on Lanterns, that the import must not disturb.
    conn.executescript("""
        INSERT INTO posts (id, season_id, episode, user_id, body, created_at, author_email)
        SELECT 7, seasons.id, 1, 'user-1', 'existing', '2026-01-05T00:00:00Z', 'alice@example.com'
        FROM seasons JOIN shows ON shows.id = seasons.show_id WHERE shows.name = 'Lanterns';
        UPDATE user_emails SET feed_seen_at = '2026-02-15T00:00:00Z' WHERE email = 'bob@example.com';
    """)
    return conn


def survivor_row(conn, number):
    return conn.execute(
        "SELECT seasons.id FROM seasons JOIN shows ON shows.id = seasons.show_id "
        "WHERE shows.name = 'Survivor' AND seasons.number = ?",
        (number,),
    ).fetchone()[0]


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.tv = tvtalk_db()
        max_id = self.tv.execute("SELECT MAX(id) FROM posts").fetchone()[0]
        self.offset = max_id
        self.tv.executescript(importer.generate(outwatch_db(), self.offset))

    def test_seasons_upserted_by_number(self):
        rows = self.tv.execute(
            "SELECT number, subtitle, url, episode_count FROM seasons JOIN shows ON shows.id = seasons.show_id "
            "WHERE shows.name = 'Survivor' AND number IN (1, 52) ORDER BY number"
        ).fetchall()
        self.assertEqual(rows, [
            (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo', 14),
            (52, 'New Era', 'https://en.wikipedia.org/wiki/Survivor_52', 13),
        ])

    def test_watched_and_currently_watching(self):
        self.assertEqual(
            self.tv.execute("SELECT user_id, season_id FROM watched").fetchall(),
            [('user-2', survivor_row(self.tv, 1))],
        )
        self.assertEqual(
            self.tv.execute(
                "SELECT user_id, season_id FROM currently_watching "
                "WHERE show_id = (SELECT id FROM shows WHERE name = 'Survivor')"
            ).fetchall(),
            [('user-1', survivor_row(self.tv, 52))],
        )

    def test_posts_replies_and_reactions_follow_the_offset(self):
        s52 = survivor_row(self.tv, 52)
        posts = self.tv.execute(
            "SELECT id, season_id, episode, body, offset_secs, author_email, reply_to_post_id, edited_at "
            "FROM posts WHERE season_id = ? ORDER BY id", (s52,)
        ).fetchall()
        o = self.offset
        self.assertEqual(posts, [
            (1 + o, s52, 2, 'first', 90, 'alice@example.com', None, None),
            (2 + o, s52, 2, 'reply', None, 'carol@example.com', 1 + o, '2026-02-01T00:02:00Z'),
        ])
        self.assertEqual(
            self.tv.execute("SELECT post_id, email, emoji FROM reactions").fetchall(),
            [(1 + o, 'bob@example.com', '🔥')],
        )

    def test_existing_tvtalk_posts_untouched(self):
        self.assertEqual(
            self.tv.execute("SELECT body FROM posts WHERE id = 7").fetchone(), ('existing',)
        )

    def test_episode_scoped_rows_remapped(self):
        s52 = survivor_row(self.tv, 52)
        for table in ("reveals", "watch_sessions", "watch_offsets", "episode_statuses"):
            self.assertEqual(
                self.tv.execute(f"SELECT DISTINCT season_id FROM {table}").fetchall(), [(s52,)], table
            )

    def test_feed_seen_keeps_the_later_mark(self):
        seen = dict(self.tv.execute("SELECT email, feed_seen_at FROM user_emails").fetchall())
        self.assertEqual(seen['alice@example.com'], '2026-03-01T00:00:00Z')
        self.assertEqual(seen['bob@example.com'], '2026-02-15T00:00:00Z')
        self.assertIsNone(seen['carol@example.com'])

    def test_rerun_is_rejected_by_post_ids(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.tv.executescript(importer.generate(outwatch_db(), self.offset))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `python3 -I -m unittest scripts/test_import_to_tvtalk.py`
Expected: FAIL with `FileNotFoundError` for `import-to-tvtalk.py`.

- [ ] **Step 3: Write the importer**

Create `scripts/import-to-tvtalk.py`:

```python
#!/usr/bin/env python3
"""
One-time copy of Outwatch's data into TV Talk's database, under the show
'Survivor'. Reads a SQLite copy of the old `outwatch` D1 database and prints
SQL to run against `tvtalk`:

    npx wrangler d1 export outwatch --remote --output="$S/outwatch-export.sql"
    sqlite3 "$S/outwatch.sqlite" < "$S/outwatch-export.sql"
    npx wrangler d1 execute tvtalk --remote --json \\
        --command "SELECT COALESCE(MAX(id), 0) AS max_id FROM posts"
    python3 -I scripts/import-to-tvtalk.py --outwatch "$S/outwatch.sqlite" \\
        --post-id-offset <max_id> > "$S/import.sql"

The output carries real emails. Keep it out of the repo (write it to a scratch
directory). Outwatch post ids are shifted by --post-id-offset so they cannot
collide with TV Talk's own, and replies and reactions are shifted with them.
Seasons are looked up by number inside the SQL rather than by id, because
seasons added in Outwatch after 51 do not exist in TV Talk until this runs.

Stdlib only. It reads only the file it is given and never touches the network
or wrangler.
"""

import argparse
import sqlite3
import sys

SHOW = "(SELECT id FROM shows WHERE name = 'Survivor')"


def q(value):
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def season(number):
    return f"(SELECT id FROM seasons WHERE show_id = {SHOW} AND number = {int(number)})"


def generate(outwatch, post_id_offset):
    rows = lambda sql: outwatch.execute(sql).fetchall()
    out = ["-- Generated by scripts/import-to-tvtalk.py. Contains real emails: do not commit."]

    for number, subtitle, url, episode_count in rows(
        "SELECT id, subtitle, wikipedia_url, episode_count FROM seasons ORDER BY id"
    ):
        out.append(
            "INSERT INTO seasons (show_id, number, subtitle, url, episode_count, created_at) "
            f"SELECT id, {q(number)}, {q(subtitle)}, {q(url)}, {q(episode_count)}, "
            "strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM shows WHERE name = 'Survivor' "
            "ON CONFLICT (show_id, number) DO UPDATE SET subtitle = excluded.subtitle, "
            "url = excluded.url, episode_count = excluded.episode_count;"
        )

    for user_id, season_id, created_at in rows(
        "SELECT user_id, season_id, created_at FROM watched"
    ):
        out.append(
            "INSERT OR IGNORE INTO watched (user_id, season_id, created_at) "
            f"VALUES ({q(user_id)}, {season(season_id)}, {q(created_at)});"
        )

    for user_id, season_id in rows(
        "SELECT id, currently_watching_season_id FROM users "
        "WHERE currently_watching_season_id IS NOT NULL"
    ):
        out.append(
            "INSERT INTO currently_watching (user_id, show_id, season_id) "
            f"VALUES ({q(user_id)}, {SHOW}, {season(season_id)}) "
            "ON CONFLICT (user_id, show_id) DO UPDATE SET season_id = excluded.season_id;"
        )

    # Ascending id, so a reply's parent is always inserted before the reply.
    for (pid, season_id, episode, user_id, body, created_at, offset_secs,
         author_email, reply_to, edited_at) in rows(
        "SELECT id, season_id, episode, user_id, body, created_at, offset_secs, "
        "author_email, reply_to_post_id, edited_at FROM posts ORDER BY id"
    ):
        new_reply = None if reply_to is None else reply_to + post_id_offset
        out.append(
            "INSERT INTO posts (id, season_id, episode, user_id, body, created_at, "
            "offset_secs, author_email, reply_to_post_id, edited_at) VALUES ("
            f"{pid + post_id_offset}, {season(season_id)}, {q(episode)}, {q(user_id)}, "
            f"{q(body)}, {q(created_at)}, {q(offset_secs)}, {q(author_email)}, "
            f"{q(new_reply)}, {q(edited_at)});"
        )

    for post_id, email, emoji, created_at in rows(
        "SELECT post_id, email, emoji, created_at FROM reactions"
    ):
        out.append(
            "INSERT OR IGNORE INTO reactions (post_id, email, emoji, created_at) "
            f"VALUES ({post_id + post_id_offset}, {q(email)}, {q(emoji)}, {q(created_at)});"
        )

    for user_id, season_id, episode, created_at in rows(
        "SELECT user_id, season_id, episode, created_at FROM reveals"
    ):
        out.append(
            "INSERT OR IGNORE INTO reveals (user_id, season_id, episode, created_at) "
            f"VALUES ({q(user_id)}, {season(season_id)}, {q(episode)}, {q(created_at)});"
        )

    for user_id, season_id, episode, elapsed, running_since, last_activity in rows(
        "SELECT user_id, season_id, episode, elapsed_secs, running_since, last_activity_at "
        "FROM watch_sessions"
    ):
        out.append(
            "INSERT OR IGNORE INTO watch_sessions (user_id, season_id, episode, elapsed_secs, "
            f"running_since, last_activity_at) VALUES ({q(user_id)}, {season(season_id)}, "
            f"{q(episode)}, {q(elapsed)}, {q(running_since)}, {q(last_activity)});"
        )

    for user_id, season_id, episode, adjust, updated_at in rows(
        "SELECT user_id, season_id, episode, adjust_secs, updated_at FROM watch_offsets"
    ):
        out.append(
            "INSERT OR IGNORE INTO watch_offsets (user_id, season_id, episode, adjust_secs, "
            f"updated_at) VALUES ({q(user_id)}, {season(season_id)}, {q(episode)}, "
            f"{q(adjust)}, {q(updated_at)});"
        )

    for user_id, season_id, episode, status, reason, created_at in rows(
        "SELECT user_id, season_id, episode, status, reason, created_at FROM episode_statuses"
    ):
        out.append(
            "INSERT OR IGNORE INTO episode_statuses (user_id, season_id, episode, status, "
            f"reason, created_at) VALUES ({q(user_id)}, {season(season_id)}, {q(episode)}, "
            f"{q(status)}, {q(reason)}, {q(created_at)});"
        )

    # The later of the two marks, so neither app's bell lights up again for
    # notes its reader had already seen.
    for email, seen in rows(
        "SELECT email, feed_seen_at FROM user_emails WHERE feed_seen_at IS NOT NULL"
    ):
        out.append(
            f"UPDATE user_emails SET feed_seen_at = {q(seen)} WHERE email = {q(email)} "
            f"AND (feed_seen_at IS NULL OR feed_seen_at < {q(seen)});"
        )

    return "\n".join(out) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--outwatch", required=True, help="SQLite copy of the outwatch database.")
    parser.add_argument(
        "--post-id-offset", type=int, required=True,
        help="TV Talk's current MAX(posts.id); Outwatch post ids are shifted by this.",
    )
    args = parser.parse_args()
    conn = sqlite3.connect(f"file:{args.outwatch}?mode=ro", uri=True)
    sys.stdout.write(generate(conn, args.post_id_offset))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `python3 -I -m unittest scripts/test_import_to_tvtalk.py -v`
Expected: 7 tests, all `ok`.

- [ ] **Step 5: Verify and commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`. Make sure Prettier does not choke on the `.py` files; `.prettierignore` or Prettier's parser list should skip them. Expected: all pass. Add `scripts/import-to-tvtalk.py` and its test to `AGENTS.md`'s Repository Structure. Then commit with the `jluszcz:commit` skill, with message `Add the one-time import of Outwatch's data into TV Talk`.

---

### Task 5: Local end-to-end dry run (no commit)

Checks the whole path against real Outwatch production data, run locally. Nothing remote is written. `S` is the scratchpad: `/private/tmp/claude-501/-Users-jacob-Documents-Programs-Outwatch/8dbd3b03-d653-4ec6-bd7a-403d886bc0d9/scratchpad`.

- [ ] **Step 1: Export Outwatch production (read-only)**

```bash
cd /Users/jacob/Documents/Programs/Outwatch
npx wrangler d1 export outwatch --remote --output="$S/outwatch-export.sql"
rm -f "$S/outwatch.sqlite" && sqlite3 "$S/outwatch.sqlite" < "$S/outwatch-export.sql"
sqlite3 "$S/outwatch.sqlite" "SELECT COUNT(*) FROM posts; SELECT MAX(id) FROM seasons;"
```

- [ ] **Step 2: Build a fresh local TV Talk database with TV Talk's own state**

```bash
cd /Users/jacob/Documents/Programs/TvTalk
npx wrangler d1 migrations apply tvtalk --local
npx wrangler d1 execute tvtalk --local --file=roster.sql
npx wrangler d1 execute tvtalk --local --json --command "SELECT COALESCE(MAX(id), 0) AS max_id FROM posts"
```

- [ ] **Step 3: Generate and apply the import locally**

```bash
cd /Users/jacob/Documents/Programs/Outwatch
python3 -I scripts/import-to-tvtalk.py --outwatch "$S/outwatch.sqlite" --post-id-offset <max_id> > "$S/import.sql"
cd ../TvTalk && npx wrangler d1 execute tvtalk --local --file="$S/import.sql"
```

Expected: no errors. Compare counts: `SELECT COUNT(*) FROM posts` grew by Outwatch's post count, and so on for `reactions`, `watched`, `reveals`.

- [ ] **Step 4: Run both apps on the same local database**

```bash
# terminal 1, in ../TvTalk
npm run dev
# terminal 2, in Outwatch: share TV Talk's local D1 state
npx wrangler dev --persist-to ../TvTalk/.wrangler/state --port 8788   # alongside `node build.js --watch`
```

Spot-check:
- Outwatch's board matches production Outwatch (watched marks, post counts, currently-watching).
- A season's discussion matches, including replies and reactions.
- TV Talk shows a `Survivor` show with the same notes.
- A note posted in one app appears in the other after a refresh.

Use the `run` skill if driving a browser.

---

### Task 6: Production cutover (each remote step confirmed with the user first)

These commands write to production. Run each one only after the user confirms it.

- [ ] **Step 1:** Confirm that TV Talk production has no show named `Survivor`: `npx wrangler d1 execute tvtalk --remote --command "SELECT id FROM shows WHERE name = 'Survivor'"`. Expect no rows.
- [ ] **Step 2:** Merge Task 1's TV Talk PR, then from `../TvTalk`: `npx wrangler d1 migrations apply tvtalk --remote`.
- [ ] **Step 3:** Announce the window to the group. Re-export Outwatch production (Task 5, Step 1). Read `MAX(posts.id)` from `tvtalk --remote`. Regenerate `import.sql` and review it: skim the top and tail, check counts against the export, and grep for anything unexpected.
- [ ] **Step 4:** `npx wrangler d1 execute tvtalk --remote --file="$S/import.sql"`.
- [ ] **Step 5:** Merge the Outwatch PR, then `npm run deploy` from Outwatch.
- [ ] **Step 6:** Spot-check both production apps as in Task 5, Step 4.
- [ ] **Step 7:** Delete `$S/outwatch-export.sql`, `$S/outwatch.sqlite`, and `$S/import.sql`, which hold real emails.

Rollback: redeploy the previous Outwatch commit. It is bound to the untouched `outwatch` database.
