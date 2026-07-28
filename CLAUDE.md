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
    - `hooks.js` — `useTheme`, `useRefreshGuard`, `useHashRoute`, `useRefreshOnFocus`, `useAutoSize`
    - `refresh-guard.js` — `createRefreshGuard`, the refetch-vs-mutation race rules as a plain state machine; `useRefreshGuard` is the wiring around it
    - `board.js` — `Header`, `Board` and its child components (the season × user grid)
    - `discussion.js` — `SeasonView`, `EpisodeBoard`, `WatchTimer`, and `PostForm`: the per-episode discussion board and its compose box + watch timer UI
    - `post.js` — The note renderer: `PostList` and its children, moved out of `discussion.js` so a quote block and a reaction bar have somewhere to live inside each note
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
    - `0001_initial.sql` — `users`, `user_emails`, `seasons`, `watched` tables
    - `0002_seed_seasons.sql` — all 50 seasons (reference data)
    - `0003_currently_watching.sql` — adds `users.currently_watching_season_id`
    - `0004_email_nocase.sql` — rebuilds `user_emails` with `COLLATE NOCASE` emails
    - `0005_discussions.sql` — adds `seasons.episode_count`; creates `posts`, `reveals`, `watch_sessions`
    - `0006_individual_authors.sql` — adds `user_emails.name` and `posts.author_email`
    - `0007_replies_edits_reactions.sql` — adds `posts.reply_to_post_id` and `posts.edited_at`; creates `reactions`
- `roster.sql` — real roster: `users` (names) + `user_emails` (emails), with generic `user-N` ids (gitignored; template in `roster.example.sql`)
- `test/` — Tests
    - `test/worker/` — Worker API tests (`@cloudflare/vitest-pool-workers`)
    - `test/frontend/` — Frontend unit tests (logic only, no DOM)
- `build.js` — esbuild bundler for the frontend (one-shot + `--watch`)
- `seed.sql` — sample watched rows for local dev (uses the generic `user-N` ids)
- `wrangler.toml`, `package.json`, `eslint.config.js`

## Technology Stack

- **Backend**: Cloudflare Workers + [Hono](https://hono.dev/) router with [Zod](https://zod.dev/) validation
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: [Preact](https://preactjs.com/) + [htm](https://github.com/developit/htm), bundled with esbuild
- **Authentication**: Cloudflare Access (zero-code, dashboard-configured), with its JWT verified in the Worker using [jose](https://github.com/panva/jose)
- **Testing**: Vitest + `@cloudflare/vitest-pool-workers`

## Build & Bundling

The frontend lives in `frontend/` and is bundled to `public/script.js` by
`build.js` (esbuild). The bundle, its sourcemap, and the minified `styles.css`
are gitignored.

- `npm run build` — one-shot production bundle (minified)
- `npm run dev` — `node build.js --watch` + `wrangler dev` concurrently
- `npm run deploy` — builds, then `wrangler deploy`
- `npm test` — Vitest once; frontend tests import from `frontend/utils.js` and `shared/session.js` directly, so no bundle is needed
- `npm run test:watch` — Vitest in watch mode
- `npm run lint` — ESLint
- `npm run format` / `npm run format:check` — Prettier, write or check

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

Two pre-commit hooks also run locally, and neither is a substitute for the checks
above — they format and sanity-check, they do not build, test, or lint:

- `.husky/pre-commit` runs `npx lint-staged`, which Prettier-formats staged
  `.js`/`.css` files in place (`lint-staged` config in `package.json`)
- `.pre-commit-config.yaml` runs the `pre-commit` framework's generic hooks
  (merge-conflict markers, TOML/YAML/JSON syntax, AWS credentials, trailing
  whitespace, end-of-file newline, sorted `.gitignore`)

Never bypass either with `--no-verify`.

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
- `GET /api/seasons/:season_id/discussion` — `{ season, me, now, episodes }`; each episode carries `episode`, `readable`, `count`, `authors` (now `[{ name, mine }]`, one per distinct individual rather than per user id), gated `posts`, and the caller's timer `session`. Each post still carries `user_id`, plus `author_name`, `author_index` (a viewer-independent position in the roster of individuals, used for the accent stripe; `null` when the author can't be placed), `mine` (server-computed ownership), `edited_at`, `reply_to`, and `reactions` (`[{ emoji, count, mine, names }]`, in set order, omitting unused emoji, attached only to posts that pass the visibility filter so a locked board carries no counts or names); emails are never serialized. **The spoiler rule**: an episode's foreign post bodies are readable only once the caller has watched the whole season or explicitly revealed that episode, and this is enforced server-side — a locked body is never serialized into the response. `reply_to` has three forms: `null` (an ordinary note or one whose parent was later deleted), `{ id, author_name, author_index, mine, body }` (the parent is currently visible to the caller), or `{ id, locked: true }` (the parent exists but is not — e.g. a season was marked watched, unlocking every episode without a `reveals` row, then unmarked, re-locking episodes the caller never explicitly revealed while their own reply, and its now-unreadable parent id, remain). `reply_to_post_id` is frozen at write time while visibility is recomputed on every read, so the two can disagree — the locked form exists for exactly that disagreement, and a locked parent's body is never serialized.
- `POST /api/seasons/:season_id/episodes/:episode/reveal` — opens one episode for reading; permanent and idempotent (`INSERT OR IGNORE`); watching the season has the same effect for all of its episodes without writing a row per episode
- `DELETE /api/posts/:post_id` — deletes one of the caller's own notes, scoped to the individual author who wrote it; a note with no recorded `author_email` predates attribution and stays deletable by the column. Ownership is checked with a `SELECT` before anything is written, then cleanup runs in a `DB.batch` in dependency order: a reply to this note is detached (`reply_to_post_id` set to `NULL`) rather than deleted or left dangling — delete is the author's explicit "unsay it," and a `[deleted]` ghost would preserve exactly what they removed — its reactions are deleted, then the note itself. A post that isn't theirs and one that doesn't exist both 404, so the route can't be used to probe which post ids are real.
- `POST /api/seasons/:season_id/episodes/:episode/timer` — `{ action: "start" | "pause" | "resume" }`; drives the caller's watch timer for that episode. `start` always zeroes the session; `pause`/`resume` return 409 both when there is no session to act on and when one exists but has gone stale (three hours idle) — either way nothing is written and the caller starts a new session instead of reviving the old one.

### Frontend

- `App` fetches `/api/board` on load and owns `users`, `seasons`, `me` state; it refetches when the tab regains focus/visibility so other people's changes show up without a reload.
- The `Board` component supports two sort modes toggled by a button group:
    - `sortSeasons` (default, "Season" mode) — sinks fully-watched seasons to the bottom, then sorts by season number.
    - `sortBySeenCount` ("Seen Count" mode) — sinks fully-watched seasons to the bottom, then sorts by ascending watcher count (ties broken by season number).
      Both functions live in `utils.js` and are shared with tests.
- Checkbox toggles are optimistic: the cell flips immediately, then reconciles
  with the server and reverts on failure.
- Optimistic mutations race the focus refetch, so both `App` and `SeasonView`
  route every fetch through `useRefreshGuard` (`hooks.js`), whose rules live in
  `createRefreshGuard` (`refresh-guard.js`): only the newest fetch may apply its
  response, and a refresh asked for while a mutation is in flight is queued for
  the last mutation to settle rather than started against pre-mutation state.
  The state machine is a plain factory so `test/frontend/refresh-guard.test.js`
  can drive it directly — keep the rules there, not in the hook.
- Only the current user's column checkboxes are enabled; others are read-only.
- `styles.css` themes via CSS `light-dark()`, which needs a mid-2024 browser
  (Chrome 123+, Safari 17.5+, Firefox 120+); older browsers render with no
  theme colors at all.
- In `styles.css`, keep the `@media (max-width: 640px)` block positioned
  after every un-gated base rule it might otherwise be overridden by — media
  queries add no specificity, so a mobile rule ahead of a same-specificity
  base rule loses on source order and is silently dead. The
  `@media (hover: hover)` and ungated `:active` blocks that follow it need no
  such care: every selector in them carries a pseudo-class, which
  out-specifies the mobile block's overlapping rules regardless of order.
- Below `640px` that block switches the layout to a phone variant: the season
  column pins to the left of `.table-wrapper` while the checkbox columns
  scroll under it (pinning only engages once the grid overflows the wrapper,
  which the current 3-column roster does not — it's a safety net for a
  longer name or a fourth column); `seasonParts` splits the label so the
  subtitle sits on its own line; each header swaps its full name for
  `abbreviateName`'s initials (`Bob & Carol` renders `B & C`) and hides the
  `(you)` suffix — both leave the accessibility tree, not just the layout, but
  each checkbox's own `aria-label` still names its owner in full. A shared
  column is the only kind that needed this: check columns size to their
  longest word, so a name containing `&` wrapped to two or three lines at
  every phone width while a single name always fit on one. The initials span
  needs `white-space: nowrap`, or the column would size to one character and
  break `B & C` across three lines;
  each checkbox sits in a `.check-hit` label (`min-height: 44px`, width
  unconstrained) that needs `td.check-cell { height: 1px }` plus
  `height: 100%` on the label to fill the cell, since `td` is
  `vertical-align: middle`; and a note's body wraps to full width below its
  meta line. The text controls specifically — `.post-input` and `.nw-select` —
  are at least `16px`, since Safari zooms the page in on focusing a form
  control below that and never zooms back out; buttons are not affected and
  stay smaller. Every `:hover` rule sits behind
  `@media (hover: hover)`, with `.sort-btn:hover` scoped `:not(.active)` so
  hovering the selected sort button keeps its style. No DOM test suite
  exists; this layout is verified with an ad-hoc Playwright script, not CI.
- The hash route `#/season/N` (`useHashRoute` in `hooks.js`) swaps the board for
  `SeasonView`, that season's per-episode discussion boards — a hash beats a
  router library for the app's one extra route, and it also makes Back work,
  survives a reload, and gives each season a link you can paste into chat.
- `SeasonView` fetches only `/api/seasons/:season_id/discussion` — the response
  already names each post's author, so there's no separate `/api/board` fetch
  or roster to merge here, and the season view is a single request.
  `authorAccent` (`utils.js`) takes a post (`{ mine, author_index }`) and reads
  those fields for its stripe colour, rather than searching the roster with a
  `(userId, meId, users)` triple.
- `SeasonView` renders one `EpisodeBoard` per episode. A locked board (not
  `readable`) shows only the note count, the authors, and the caller's own
  notes; opening it (`POST .../reveal`) is permanent. Marking a whole season
  watched has the same effect on every one of its episodes.
- The boards are an accordion: `SeasonView` owns a single `openEpisode` (an
  episode number or `null`) and `EpisodeBoard` is controlled via `open` /
  `onToggle`, so expanding one collapses the rest rather than burying it in a
  tall stack. Keying on the episode number rather than component identity means
  the open board survives the focus refetch.
- `SeasonView` renders a fetch/mutation error as a banner **above** the view,
  the way `App` does; only a failure with no data yet (the initial load) gets
  the view to itself. It must not early-return on `error`, which would unmount
  the whole view — discussion, open episode, and the text sitting unposted in
  the box — on a transient failure, with only a reload or a tab-out to get it
  back.
- Posting shows its progress in the button (spinner + "Posting…", full contrast
  via `aria-busy`) and leaves the textarea **enabled** throughout: disabling a
  focused textarea blurs it, which on a phone tears down the keyboard mid-post
  and never restores it. `busy` gates the submit path instead, so Enter can't
  double-post. Because the box stays editable in flight, the success path clears
  only the text that actually posted (`current === trimmed`), preserving
  anything typed on top of it.
- An open board reads controls → discussion → compose box: the
  `.episode-actions` row leads `.episode-body`, then the notes, then the
  `hidden-note` count, then `PostForm`. The controls sit above the list because
  the list grows — as people post and as revealing unhides notes — and anything
  below it moves every time it does.
- The reveal button and the watch timer share one row (`.episode-actions`):
  reveal left, timer pushed right by `margin-left: auto`. The row pins its own
  height to `--control-height` rather than taking it from its tallest child,
  because that child is the reveal button and it vanishes on reveal — a
  content-sized row would shrink by a few pixels and pull the timer up under
  the cursor mid-click. The row is `flex-wrap: wrap-reverse`, not `wrap`: only
  genuinely narrow widths (below roughly `430px`) fail to fit both, and the
  reversed cross axis puts the wrapped-off timer _above_ the button rather
  than below it, so revealing still removes the button from under the timer.
  Deliberately width-driven rather than gated on the `640px` breakpoint — the
  controls fit on one line well below it, and a breakpoint would stack them
  where they didn't need stacking.
- Within an opened board, `orderPosts` (`utils.js`) places every note on one
  synced timeline by watch-timer offset instead of wall-clock time, using
  three cases per author: a real `offset_secs` is used as-is; an author who
  never ran a timer gets an inferred offset of zero, anchored to their own
  earliest note on that episode, so their notes still interleave; and an
  untimed note from an author who _did_ time other notes on the episode (their
  session went stale and they posted again later) is dropped to the tail
  sorted by wall-clock time, rather than given a fabricated offset.
- A reply renders as a quote block (`Quote` in `post.js`) above the note's own
  body, not as an indented thread — `orderPosts` is untouched by replies, so a
  reply sits wherever its own watch offset places it on the shared timeline,
  same as any other note. The quote takes the _quoted_ author's accent class,
  not the replier's, since it's read as "this is what they said," and it
  handles the server's three `reply_to` shapes: absent (no quote block), the
  parent's live `{ author_name, body, ... }` (so an edit to the parent shows
  through here — the reply stores an id, not a copy), and `{ id, locked: true }`
  when the caller can no longer read the parent (the season was unmarked after
  the reply was written) — that shape never carries a body, and the locked
  stub must not expect one. `replyTo` (the reply target's id/author/snippet,
  via `quoteSnippet`) is state owned by `EpisodeBoard`, not `SeasonView`: it's
  episode-scoped, `EpisodeBoard` is the common parent of `PostList` (whose
  reply button starts it) and `PostForm` (whose chip displays it and whose
  submit clears it), and scoping it there keeps a half-written reply from
  following you to a different episode.
- Editing a note is inline (`EditForm` in `post.js`): the ✎ button on one of
  your own notes, shown via the server-computed `mine` flag, swaps the body for
  a textarea with Save and Cancel in place, so the surrounding conversation
  stays visible while you rewrite. `PATCH /api/posts/:post_id` never touches
  `created_at`, `offset_secs`, or `reply_to_post_id`, so a saved edit keeps the
  note's position on the shared watch-offset timeline and only its body and an
  `edited_at` marker (`· edited`) change. `editingId` is state owned by
  `EpisodeBoard`, for the same reason `replyTo` is — episode-scoped, one note
  editable per board at a time. The edit box shares `useAutoSize` (`hooks.js`)
  with `PostForm`'s compose box, extracted from `PostForm.fit` rather than
  duplicated, and stays enabled while saving for the same reason `PostForm`'s
  does.
- Reacting is one emoji picker button (`☺+`, third in the action row: `↰ ☺+ ✎
×`) plus a `ReactionBar` of chips (`post.js`), both driven by the four-emoji
  set in `shared/reactions.js` — the same module the Worker
  validates against, so the picker can never offer an emoji the server would
  reject. A note's `reactions` array arrives from the server already in set
  order with counts and names resolved, so the client only draws it; `mine`
  fills a chip in and is what tapping it toggles. Reactions are per
  individual, not per column, matching the `reactions` table's key — both
  halves of a shared login react separately, and a note's author reacting to
  their own note is allowed. `PUT /api/posts/:post_id/reactions` takes an
  explicit `on` boolean rather than being a toggle, so the client always
  computes it from what the server last said (`!r.mine` for a chip, the
  picker's own `chosen` set for a picker button) instead of flipping a local
  value — idempotent in both directions, so a double tap or a retried request
  can't desync from the server. The picker (`EmojiPicker` in `post.js`) is
  inline inside `.post-content`, below the note, not a popover: nothing to
  clip inside a scrolling board, and its 44px touch targets fall out of a CSS
  grid rather than fighting absolute positioning. `pickerFor` is state owned
  by `EpisodeBoard`, for the same episode-scoped, one-at-a-time reason as
  `replyTo` and `editingId`; choosing an emoji closes the picker unconditionally,
  whether the mutation that follows succeeds or not, so unlike `saveEdit` there
  is no response-driven close for a late answer to race against.
- The optional watch timer (`WatchTimer` in `discussion.js`, rule in
  `shared/session.js`) starts, pauses, and resumes per (user, episode); a
  session goes stale after three hours without a start/pause/resume/post, and
  `pause`/`resume` on a stale session 409 without writing.
- The manifest link in `index.html` carries `crossorigin="use-credentials"`,
  which is load-bearing behind Cloudflare Access: a manifest is fetched without
  credentials by default, so Access would redirect it to a login page, the
  browser would fail to parse HTML as JSON, and the install would silently
  never be offered. There is deliberately no service worker — a cached board is
  a stale board — and deliberately no `viewport-fit=cover`, since iOS insets a
  standalone app clear of the notch on its own and opting in would mean
  threading `env(safe-area-inset-*)` through `styles.css` for nothing.

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
