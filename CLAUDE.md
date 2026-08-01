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
    - `CLAUDE.md` — The frontend's conventions and gotchas; loads only when working on files under `frontend/`, keeping them out of every unrelated session's context
    - `script.js` — `App` component: board/season state, hash routing, optimistic mutations
    - `api.js` — `api()`, the shared fetch helper (throws with `.status` on a non-2xx response)
    - `hooks.js` — `useTheme`, `useIsDark`, `useRefreshGuard`, `useSubmitGuard`, `useHashRoute`, `useRefreshOnFocus`
    - `refresh-guard.js` — `createRefreshGuard`, the refetch-vs-mutation race rules as a plain state machine; `useRefreshGuard` is the wiring around it
    - `submit-guard.js` — `createSubmitGuard`, the submit-once and cannot-cancel-in-flight rules as a plain state machine, shared by the compose box and the edit box; `useSubmitGuard` is the wiring around it
    - `board.js` — `Header`, `Board` and its child components (the season × user grid)
    - `discussion.js` — `SeasonView`, `EpisodeBoard`, `WatchTimer`, and `PostForm`: the per-episode discussion board and its compose box + watch timer UI
    - `post.js` — The note renderer: `PostList` and its children, moved out of `discussion.js` so a quote block, a reaction bar, and the per-note `⋯` action menu have somewhere to live inside each note
    - `icons.js` — Bootstrap Icons path data inlined as plain strings, plus the `Icon` component that draws it; the outline/`-fill` pair per icon is what light/dark mode swaps between
    - `utils.js` — Pure helpers (`seasonLabel`, `isFullyWatched`, `sortSeasons`, `sortBySeenCount`, `selectableSeasons`, `setWatched`, `clearsCurrentlyWatching`, `episodeNumbers`, `formatOffset`, `orderPosts`, `quoteSnippet`); shared with tests
    - `styles.css` — Theme tokens + layout
- `shared/` — Code the Worker and the browser bundle both import, so the two never disagree
    - `session.js` — `sessionOffsetSecs`, the one watch-timer rule both sides must compute identically
    - `reactions.js` — `REACTIONS`, the four-emoji set both the Worker (validation) and the browser (the picker) must agree on
- `public/` — Served static assets
    - `index.html` — App shell that loads the bundled script
    - `manifest.json` — Web app manifest; makes the site installable to a home screen
    - `icon-512.png`, `icon-192.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon-32.png` — icons generated from `assets/icon-source.png` by `sips` (see README) and committed, unlike the build output below
    - `script.js`, `script.js.map`, `styles.css`, `styles.css.map` — build output (gitignored)
- `assets/` — Committed source material that is deliberately **not** served
    - `icon-source.png` — Original icon artwork, kept so the icons can be regenerated. It lives here rather than in `public/` because `[assets] directory = "public"` uploads every file under `public/` as a Workers static asset with its own URL, and nothing links to the 1.8 MiB original
- `src/` — Cloudflare Workers backend
    - `index.js` — Hono app + API for the board, watched state, and per-episode discussions
    - `access.js` — `accessTokenEmail`, Cloudflare Access JWT verification (signature, issuer, audience, expiry); the only source of caller identity in production
- `migrations/` — D1 SQL migrations (applied via wrangler)
- `roster.sql` — real roster: `users` (names) + `user_emails` (emails), with generic `user-N` ids (gitignored; template in `roster.example.sql`)
- `test/` — Tests
    - `test/worker/` — Worker API tests (`@cloudflare/vitest-pool-workers`)
    - `test/frontend/` — Frontend unit tests (logic only, no DOM)
- `build.js` — esbuild bundler for the frontend (one-shot + `--watch`)
- `seed.sql` — sample watched rows for local dev (uses the generic `user-N` ids)
- `wrangler.toml`, `package.json`, `eslint.config.js`

## Build & Bundling

The frontend lives in `frontend/` and is bundled to `public/script.js` by
`build.js` (esbuild). The bundle, its sourcemap, and the minified `styles.css`
are gitignored. Frontend tests import from `frontend/utils.js` and
`shared/session.js` directly, so `npm test` needs no bundle.

When editing the frontend, edit files under `frontend/`. Do not edit
`public/script.js` — it is build output.

`wrangler.toml` deliberately has no `[build]` hook. The npm scripts are the only
thing that bundles: `npm run deploy` builds before deploying, and `npm run dev`
runs the watch-mode bundler alongside `wrangler dev`. A `[build]` hook would
double-build on deploy and, worse, fire the one-shot minified build at `wrangler
dev` startup — clobbering the watcher's unminified, sourcemapped bundle until the
next file edit. The tradeoff: a bare `wrangler dev` or `wrangler deploy` serves
whatever is already in `public/`, so always go through the npm scripts.

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

Two pre-commit hooks also run locally (`.husky/pre-commit` and
`.pre-commit-config.yaml`), and neither is a substitute for the checks above —
they format and sanity-check, they do not build, test, or lint. Never bypass
either with `--no-verify`.

### Preview deployments

Cloudflare's GitHub integration (Workers Builds, configured in the Cloudflare
dashboard rather than in `wrangler.toml`) builds every pull request and
publishes it as its own Worker version, so a branch or commit gets a preview
URL the change can be reviewed on before it merges. Three consequences
specific to this repo:

- The build it runs has to bundle the frontend. `public/script.js` is
  gitignored, so a preview built without `npm run build` serves `index.html`
  with nothing behind it. This is the "always go through the npm scripts"
  tradeoff from Build & Bundling above, applied to a builder that is not your
  shell.
- A preview version uses the same bindings as production, so it reads and
  writes the **production D1** — there is no preview database. Clicking around
  a preview toggles real watched rows and posts real notes.
- Identity still comes from a verified Access token and nothing else. On a
  hostname the Access application does not front, no token arrives;
  `DEV_USER_EMAIL` is a local-dev affordance living in `.dev.vars`, so it is
  not there to fall back on either, and `callerUser` resolves to nothing. Every
  API route then answers 403 and the shell loads over an empty board. That is
  the first thing to check when a preview looks broken, and it is the intended
  failure rather than a gap — see Authentication & identity for why the
  plaintext header is deliberately not a fallback.

## Architecture Notes

### Authentication & identity

- Cloudflare Access protects the Worker at the edge and forwards the identity two
  ways: a plaintext `Cf-Access-Authenticated-User-Email` header and a signed JWT in
  `Cf-Access-Jwt-Assertion`. **Only the token is trusted, and `src/access.js`
  verifies it** — RS256 signature against `<team domain>/cdn-cgi/access/certs`,
  `iss` against `ACCESS_TEAM_DOMAIN`, `aud` against `ACCESS_AUD` (the AUD tag is
  per-application, so this is what keeps a token minted for a different Access
  application out), and `exp`. Do not reintroduce reads of the plaintext header:
  it is only trustworthy on a hostname the Access application fronts, and a Worker
  answers on every hostname bound to it (`*.workers.dev` included), so on an
  uncovered one that header is client-controlled and would let anyone act as any
  roster member. A signature holds regardless of hostname.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are runtime secrets set with
  `wrangler secret put`, deliberately not committed `[vars]`. If either is missing
  while a token is present, the Worker fails closed with a 500; a
  token that fails verification is a 403. Neither ever falls back to the header or
  to `DEV_USER_EMAIL`.
- `src/index.js` maps the verified email (lowercased) through `user_emails` to a
  `users` column. A couple's column has two emails pointing at it, so either
  partner acts as the same column. All mutations attribute to the caller's own
  `users.id` — there is no client-supplied user id, so you can only toggle your own
  column.
- `callerUser()` resolves to `{ id, name, email }`, carrying the verified email
  alongside the column. The email rides along only for note authorship: a
  discussion note is bylined to the individual, not the column, so it's the one
  mutation that needs to tell a shared column's two logins apart. Every other
  mutation — watched, currently-watching, reveals, timers — still attributes to
  `users.id` alone, and the email is never serialized to the client.
- Local dev bypasses Access, so there is no token to verify; `DEV_USER_EMAIL` (in
  `.dev.vars`) simulates a signed-in user, and the `ACCESS_*` settings are unused.
- Worker tests authenticate with real signed tokens: `test/worker/access-token.js`
  mints them with a throwaway key pair and stubs the JWKS endpoint, so
  `req(..., { email })` in the suites exercises the production verification path.

### Database Schema

- `users` — `id`, `name` (column header), `sort_order`, `currently_watching_season_id` (added in `0003`, `NULL` when not watching anything); one row per board column
- `user_emails` — `email` PK, `user_id`, `name` (added in `0006`, the individual's byline on a discussion note; `NULL` falls back to the column's `users.name`); maps each Access login email to a column (couples have two rows)
- `seasons` — `id` (the season number), `subtitle` (may be empty), `wikipedia_url`, `episode_count` (added in `0005`, from Wikipedia's episode table, excluding the reunion special)
- `watched` — `(user_id, season_id)` PK + `created_at`; presence = watched
- `posts` — one row per discussion note: `id`, `season_id`, `episode`, `user_id`, `body`, `created_at`, `offset_secs` (the writer's watch-timer offset at post time, frozen, `NULL` if no timer was running), `author_email` (added in `0006`, `REFERENCES user_emails (email)`; who wrote the note, `NULL` on notes predating individual attribution, which fall back to the column for both the byline and the delete rule), `reply_to_post_id` (added in `0007`, `REFERENCES posts (id)`; the note being answered, `NULL` for an ordinary note or a reply whose parent was deleted), `edited_at` (added in `0007`, `NULL` on a note never edited)
- `reveals` — `(user_id, season_id, episode)` PK + `created_at`; presence = that user opened that episode's board for reading (one-way — there is no re-lock)
- `watch_sessions` — `(user_id, season_id, episode)` PK, `elapsed_secs`, `running_since` (`NULL` while paused), `last_activity_at`; a running or paused watch timer, stale after three hours of inactivity
- `reactions` — `(post_id, email, emoji)` PK + `created_at`; presence = that individual put that emoji on that note. Keyed on the email, not the column, so both halves of a shared column react separately

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
- `POST /api/seasons/:season_id/episodes/:episode/posts` — `{ body, reply_to_post_id? }`; adds a discussion note, stamped with the caller's live watch-timer offset (or `null` if no timer is running) and their `author_email`; also touches the timer session's `last_activity_at`. `reply_to_post_id` is optional and, when present, must name a post in this same season and episode that the caller can currently see (`visiblePost`); anything else — missing, a different episode, or not visible to the caller — is a 404, matching the delete route's "don't distinguish not-yours from doesn't-exist" rule.
- `PATCH /api/posts/:post_id` — `{ body }`; rewrites one of the caller's own notes and stamps `edited_at`. Same ownership rule as `DELETE` (the individual author, or the column for a note with no recorded `author_email`), and the same 404 for a note that isn't theirs or doesn't exist. `created_at`, `offset_secs`, and `reply_to_post_id` are never touched, so an edit cannot move a note on the timeline
- `PUT /api/posts/:post_id/reactions` — `{ emoji, on }`; adds or removes one of the four emoji in `shared/reactions.js` on a note the caller can see. Idempotent in both directions, attributed to the individual's email rather than their column, and 400 for an emoji outside the set. Reacting to your own note is allowed
- `GET /api/seasons/:season_id/discussion` — `{ season, me, now, episodes }`; each episode carries `episode`, `readable`, `count`, `authors` (now `[{ name, mine }]`, one per distinct individual rather than per user id), gated `posts`, and the caller's timer `session`. Each post still carries `user_id`, plus `author_name`, `author_index` (a viewer-independent position in the roster of individuals, used for the accent stripe; `null` when the author can't be placed), `mine` (server-computed ownership), `edited_at`, `reply_to`, and `reactions` (`[{ emoji, count, mine, names }]`, in set order, omitting unused emoji, attached only to posts that pass the visibility filter so a locked board carries no counts or names); emails are never serialized. A deliberate, unrecorded-until-now consequence of that same visibility filter: the caller's own posts always pass it, even on a locked board, so their `reactions.names` can name a partner who reacted to one of the caller's own notes without posting anything themselves that episode — a shared column's other half showing up in `names` is strictly more disclosure than the `authors` list gives (built from note authorship only), since it can surface a reaction with no accompanying note at all. This is accepted rather than filtered out: on this project's small, shared-household board a partner's reaction is not a spoiler, matching the same "authors are named even on a locked board" reasoning in `src/index.js`, and the behavior should not change. **The spoiler rule**: an episode's foreign post bodies are readable only once the caller has watched the whole season or explicitly revealed that episode, and this is enforced server-side — a locked body is never serialized into the response. `reply_to` has three forms: `null` (an ordinary note or one whose parent was later deleted), `{ id, author_name, author_index, mine, body }` (the parent is currently visible to the caller), or `{ id, locked: true }` (the parent exists but is not — e.g. a season was marked watched, unlocking every episode without a `reveals` row, then unmarked, re-locking episodes the caller never explicitly revealed while their own reply, and its now-unreadable parent id, remain). `reply_to_post_id` is frozen at write time while visibility is recomputed on every read, so the two can disagree — the locked form exists for exactly that disagreement, and a locked parent's body is never serialized.
- `POST /api/seasons/:season_id/episodes/:episode/reveal` — opens one episode for reading; permanent and idempotent (`INSERT OR IGNORE`); watching the season has the same effect for all of its episodes without writing a row per episode
- `DELETE /api/posts/:post_id` — deletes one of the caller's own notes, scoped to the individual author who wrote it; a note with no recorded `author_email` predates attribution and stays deletable by the column. Ownership is checked with a `SELECT` before anything is written, then cleanup runs in a `DB.batch` in dependency order: a reply to this note is detached (`reply_to_post_id` set to `NULL`) rather than deleted or left dangling — delete is the author's explicit "unsay it," and a `[deleted]` ghost would preserve exactly what they removed — its reactions are deleted, then the note itself. A post that isn't theirs and one that doesn't exist both 404, so the route can't be used to probe which post ids are real.
- `POST /api/seasons/:season_id/episodes/:episode/timer` — `{ action: "start" | "pause" | "resume" }`; drives the caller's watch timer for that episode. `start` always zeroes the session; `pause`/`resume` return 409 both when there is no session to act on and when one exists but has gone stale (three hours idle) — either way nothing is written and the caller starts a new session instead of reviving the old one.

### Frontend

The frontend's conventions, layout rules, and gotchas live in
`frontend/CLAUDE.md`, which loads when working on files under `frontend/`.

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
