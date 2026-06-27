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
    - `script.js` — `App` component + child components managing state and rendering
    - `utils.js` — Pure helpers (`seasonLabel`, `isFullyWatched`, `sortSeasons`, `sortBySeenCount`, `selectableSeasons`, `clearsCurrentlyWatching`); shared with tests
- `public/` — Served static assets
    - `index.html` — App shell that loads the bundled script
    - `styles.css` — Theme tokens + layout
    - `script.js`, `script.js.map`, `styles.css` — build output (gitignored)
- `src/` — Cloudflare Workers backend
    - `index.js` — Hono app + API for the board and watched state
- `migrations/` — D1 SQL migrations (applied via wrangler)
    - `0001_initial.sql` — `users`, `user_emails`, `seasons`, `watched` tables
    - `0002_seed_seasons.sql` — all 50 seasons (reference data)
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
- `seasons` — `id` (the season number), `subtitle` (may be empty), `wikipedia_url`
- `watched` — `(user_id, season_id)` PK + `created_at`; presence = watched

Seasons (migration `0002`) are seeded reference data, present in every
environment after `migrations apply`. The roster (`users` + `user_emails`)
contains real names and emails, so it is seeded from `roster.sql` (gitignored;
template in `roster.example.sql`) rather than a committed migration — keep real
names and emails out of source control. `seed.sql` holds only optional sample
`watched` rows for local dev.

### API Routes

- `GET /api/board` — `{ me, users, seasons }`; each season carries `watched_by` (user ids); each user carries `currently_watching_season_id`. Emails are not exposed to the client.
- `POST /api/watched` — `{ season_id }`; marks the caller watched (idempotent, `INSERT OR IGNORE`); also clears the season as the caller's currently-watching, atomically via `DB.batch`
- `DELETE /api/watched/:season_id` — unmarks the caller (no-op safe)
- `PUT /api/currently-watching` — `{ season_id }` (nullable); sets the caller's currently-watching season, or clears it with `null`. Invariant: it's always one of the caller's unwatched seasons.

### Frontend

- `App` fetches `/api/board` once and owns `users`, `seasons`, `me` state.
- The `Board` component supports two sort modes toggled by a button group:
    - `sortSeasons` (default, "Season" mode) — sinks fully-watched seasons to the bottom, then sorts by season number.
    - `sortBySeenCount` ("Seen Count" mode) — sinks fully-watched seasons to the bottom, then sorts by ascending watcher count (ties broken by season number).
      Both functions live in `utils.js` and are shared with tests.
- Checkbox toggles are optimistic: the cell flips immediately, then reconciles
  with the server and reverts on failure.
- Only the current user's column checkboxes are enabled; others are read-only.

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
