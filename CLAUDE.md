# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**Outwatch** is a shared tracker for which seasons of _Survivor_ a small group
(<5 people) has watched. Each season is a row ("Season X: Subtitle" linked to
Wikipedia); each user is a checkbox column. Identity comes from Cloudflare Access,
and a user can only toggle their own column. When every user has checked a season
it grays out and sorts to the bottom. Built as a Cloudflare Workers application
with a D1 (SQLite) database and a static Preact frontend.

It is a sibling of the **Seen** project and follows the same stack and structure.

## Repository Structure

- `frontend/` — Preact + htm frontend source
    - `script.js` — `App` component: board/season state, hash routing, optimistic mutations
    - `api.js` — `api()`, the shared fetch helper (throws with `.status` on a non-2xx response)
    - `hooks.js` — `useTheme`, `useRefreshGuard`, `useHashRoute`, `useRefreshOnFocus`
    - `board.js` — `Header`, `Board` and its child components (the season × user grid)
    - `discussion.js` — `SeasonView` and the per-episode discussion board + watch timer UI
    - `utils.js` — Pure helpers (`seasonLabel`, `isFullyWatched`, `sortSeasons`, `sortBySeenCount`, `selectableSeasons`, `clearsCurrentlyWatching`, `episodeNumbers`, `formatOffset`, `orderPosts`); shared with tests
    - `styles.css` — Theme tokens + layout
- `shared/` — Code the Worker and the browser bundle both import, so the two never disagree
    - `session.js` — `sessionOffsetSecs`, the one watch-timer rule both sides must compute identically
- `public/` — Served static assets
    - `index.html` — App shell that loads the bundled script
    - `script.js`, `script.js.map`, `styles.css`, `styles.css.map` — build output (gitignored)
- `src/` — Cloudflare Workers backend
    - `index.js` — Hono app + API for the board, watched state, and per-episode discussions
- `migrations/` — D1 SQL migrations (applied via wrangler)
    - `0001_initial.sql` — `users`, `user_emails`, `seasons`, `watched` tables
    - `0002_seed_seasons.sql` — all 50 seasons (reference data)
    - `0003_currently_watching.sql` — adds `users.currently_watching_season_id`
    - `0004_email_nocase.sql` — rebuilds `user_emails` with `COLLATE NOCASE` emails
    - `0005_discussions.sql` — adds `seasons.episode_count`; creates `posts`, `reveals`, `watch_sessions`
- `roster.sql` — real roster: `users` (names) + `user_emails` (emails), with generic `user-N` ids (gitignored; template in `roster.example.sql`)
- `test/` — Tests
    - `test/worker/` — Worker API tests (`@cloudflare/vitest-pool-workers`)
    - `test/frontend/` — Frontend unit tests (logic only, no DOM)
- `build.js` — esbuild bundler for the frontend (one-shot + `--watch`)
- `seed.sql` — sample watched rows for local dev (uses the generic `user-N` ids)
- `wrangler.toml`, `package.json`

## Technology Stack

- **Backend**: Cloudflare Workers + [Hono](https://hono.dev/) router with [Zod](https://zod.dev/) validation
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: [Preact](https://preactjs.com/) + [htm](https://github.com/developit/htm), bundled with esbuild
- **Authentication**: Cloudflare Access (zero-code, dashboard-configured)
- **Testing**: Vitest + `@cloudflare/vitest-pool-workers`

## Build & Bundling

The frontend lives in `frontend/` and is bundled to `public/script.js` by
`build.js` (esbuild). The bundle, its sourcemap, and the minified `styles.css`
are gitignored.

- `npm run build` — one-shot production bundle (minified)
- `npm run dev` — `node build.js --watch` + `wrangler dev` concurrently
- `npm run deploy` — builds, then `wrangler deploy`
- `npm test` — Vitest only; tests import from `frontend/utils.js` directly

When editing the frontend, edit files under `frontend/`. Do not edit
`public/script.js` — it is build output.

## Validation

`.github/workflows/ci.yml` is a thin caller of
`jluszcz/github-utils/.github/workflows/node-ci.yml@v1` — the steps live in that
shared workflow, not in this repo. On every push and PR to `main` it runs, in
order, on Node 22:

1. `npm ci` — install dependencies from the lockfile
2. `npm run build` — the frontend bundle must build
3. `npm test` — all Vitest suites must pass
4. `npm run lint` — ESLint (flat config in `eslint.config.js`)
5. `npm run format:check` — Prettier formatting must be clean (run `npm run format` to fix)

**Before committing any change, run `npm run build`, `npm test`, `npm run lint`,
and `npm run format:check` locally and confirm they all pass.** These are exactly
the checks CI runs, and a commit that fails any of them should not be made.

## Architecture Notes

### Authentication & identity

- Cloudflare Access protects the Worker at the edge and forwards the verified
  identity in the `Cf-Access-Authenticated-User-Email` header. The client cannot
  spoof it.
- `src/index.js` maps that email (lowercased) through `user_emails` to a `users`
  column. A couple's column has two emails pointing at it, so either partner acts
  as the same column. All mutations attribute to the caller's own `users.id` —
  there is no client-supplied user id, so you can only toggle your own column.
- Local dev bypasses Access; `DEV_USER_EMAIL` (in `.dev.vars`) simulates a
  signed-in user.

### Database Schema

- `users` — `id`, `name` (column header), `sort_order`; one row per board column
- `user_emails` — `email` PK, `user_id`; maps each Access login email to a column (couples have two rows)
- `seasons` — `id` (the season number), `subtitle` (may be empty), `wikipedia_url`, `episode_count` (added in `0005`, from Wikipedia's episode table, excluding the reunion special)
- `watched` — `(user_id, season_id)` PK + `created_at`; presence = watched
- `posts` — one row per discussion note: `id`, `season_id`, `episode`, `user_id`, `body`, `created_at`, `offset_secs` (the writer's watch-timer offset at post time, frozen, `NULL` if no timer was running)
- `reveals` — `(user_id, season_id, episode)` PK + `created_at`; presence = that user opened that episode's board for reading (one-way — there is no re-lock)
- `watch_sessions` — `(user_id, season_id, episode)` PK, `elapsed_secs`, `running_since` (`NULL` while paused), `last_activity_at`; a running or paused watch timer, stale after three hours of inactivity

Seasons (migration `0002`) are seeded reference data, present in every
environment after `migrations apply`. The roster (`users` + `user_emails`)
contains real names and emails, so it is seeded from `roster.sql` (gitignored;
template in `roster.example.sql`) rather than a committed migration — keep real
names and emails out of source control. `seed.sql` holds only optional sample
`watched` rows for local dev.

### API Routes

- `GET /api/board` — `{ me, users, seasons }`; each season carries `watched_by` (user ids), `episode_count`, and `post_count`; each user carries `currently_watching_season_id`. Emails are not exposed to the client.
- `POST /api/watched` — `{ season_id }`; marks the caller watched (idempotent, `INSERT OR IGNORE`); also clears the season as the caller's currently-watching, atomically via `DB.batch`
- `DELETE /api/watched/:season_id` — unmarks the caller (no-op safe)
- `PUT /api/currently-watching` — `{ season_id }` (nullable); sets the caller's currently-watching season, or clears it with `null`. Invariant: it's always one of the caller's unwatched seasons — a season the caller has already watched is rejected with 409.
- `POST /api/seasons/:season_id/episodes/:episode/posts` — `{ body }`; adds a discussion note, stamped with the caller's live watch-timer offset (or `null` if no timer is running); also touches the timer session's `last_activity_at`
- `GET /api/seasons/:season_id/discussion` — `{ season, me, now, episodes }`; each episode carries `episode`, `readable`, `count`, `authors`, gated `posts`, and the caller's timer `session`. **The spoiler rule**: an episode's foreign post bodies are readable only once the caller has watched the whole season or explicitly revealed that episode, and this is enforced server-side — a locked body is never serialized into the response.
- `POST /api/seasons/:season_id/episodes/:episode/reveal` — opens one episode for reading; permanent and idempotent (`INSERT OR IGNORE`); watching the season has the same effect for all of its episodes without writing a row per episode
- `DELETE /api/posts/:post_id` — deletes one of the caller's own notes; a post that isn't theirs and one that doesn't exist both 404, so the route can't be used to probe which post ids are real
- `POST /api/seasons/:season_id/episodes/:episode/timer` — `{ action: "start" | "pause" | "resume" }`; drives the caller's watch timer for that episode. `start` always zeroes the session; `pause`/`resume` return 409 both when there is no session to act on and when one exists but has gone stale (three hours idle) — either way nothing is written and the caller starts a new session instead of reviving the old one.

### Frontend

- `App` fetches `/api/board` on load and owns `users`, `seasons`, `me` state; it refetches when the tab regains focus/visibility so other people's changes show up without a reload.
- The `Board` component supports two sort modes toggled by a button group:
    - `sortSeasons` (default, "Season" mode) — sinks fully-watched seasons to the bottom, then sorts by season number.
    - `sortBySeenCount` ("Seen Count" mode) — sinks fully-watched seasons to the bottom, then sorts by ascending watcher count (ties broken by season number).
      Both functions live in `utils.js` and are shared with tests.
- Checkbox toggles are optimistic: the cell flips immediately, then reconciles
  with the server and reverts on failure.
- Only the current user's column checkboxes are enabled; others are read-only.
- `styles.css` themes via CSS `light-dark()`, which needs a mid-2024 browser
  (Chrome 123+, Safari 17.5+, Firefox 120+); older browsers render with no
  theme colors at all.
- The hash route `#/season/N` (`useHashRoute` in `hooks.js`) swaps the board for
  `SeasonView`, that season's per-episode discussion boards — a hash beats a
  router library for the app's one extra route, and it also makes Back work,
  survives a reload, and gives each season a link you can paste into chat.
- `SeasonView` renders one `EpisodeBoard` per episode. A locked board (not
  `readable`) shows only the note count, the authors, and the caller's own
  notes; opening it (`POST .../reveal`) is permanent. Marking a whole season
  watched has the same effect on every one of its episodes.
- Within an opened board, `orderPosts` (`utils.js`) places every note on one
  synced timeline by watch-timer offset instead of wall-clock time, using
  three cases per author: a real `offset_secs` is used as-is; an author who
  never ran a timer gets an inferred offset of zero, anchored to their own
  earliest note on that episode, so their notes still interleave; and an
  untimed note from an author who _did_ time other notes on the episode (their
  session went stale and they posted again later) is dropped to the tail
  sorted by wall-clock time, rather than given a fabricated offset.
- The optional watch timer (`WatchTimer` in `discussion.js`, rule in
  `shared/session.js`) starts, pauses, and resumes per (user, episode); a
  session goes stale after three hours without a start/pause/resume/post, and
  `pause`/`resume` on a stale session 409 without writing.

## Rules

- **Never commit real names or email addresses.** The real roster (people's
  names and their emails) lives only in `roster.sql`, which is gitignored.
  Anything committed — migrations, `seed.sql`, `roster.example.sql`, README,
  CLAUDE.md, tests, `.dev.vars.example` — must use fake placeholders only
  (generic `user-N` ids, made-up names, `@example.com` emails). The committed
  fake names must not be the real people's names. When adding or changing the
  roster, edit `roster.sql`, never a tracked file.

## Configuration Notes

The `database_id` in `wrangler.toml` is a routing identifier, not a secret — it
is safe to commit (consistent with the Seen project). Using the database still
requires valid Cloudflare authentication.

## Cost

Designed to be free for personal use (Workers, D1, and Access free tiers).
