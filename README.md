# Outwatch

A shared tracker for which seasons of _Survivor_ a small group has watched. One
row per season ("Season X: Subtitle", linked to Wikipedia) and one checkbox
column per person. You can only toggle your own column — identity comes from
Cloudflare Access. Once everyone has checked a season, it grays out and sorts to
the bottom.

Built on Cloudflare Workers with a D1 SQLite database, behind Cloudflare Access.

## Features

- All 50 U.S. seasons of _Survivor_ seeded with official subtitles + Wikipedia links
- One checkbox column per person/couple; you can only change your own (Access-derived identity)
- Couples share a column — either partner's login can toggle it
- Discussion notes are bylined to the individual who wrote them, so a shared column speaks with two voices
- Fully-watched seasons gray out and sink to the bottom
- Per-episode discussion boards, write-only until you open them
- Light/dark theme toggle
- Zero-code authentication via Cloudflare Access

## Discussion Boards

Every episode of every season has its own discussion board, so friends
watching at different paces don't spoil each other.

- **Write-only until revealed.** You can always post your own notes and see
  them, but everyone else's notes on an episode stay hidden until you
  deliberately open that episode's board for reading.
- **Revealing is per-episode and permanent.** There's no re-locking — once
  you've opened a board, it stays open.
- **Watching a season opens all of its episodes.** Marking a season fully
  watched has the same effect as revealing every episode in it, so you don't
  have to open each one by hand.
- **An optional watch timer.** Start it when you press play, and your notes
  are stamped with how far into the episode you were, so once a board is
  opened everyone's notes sort into one synced timeline by that offset
  instead of by when they happened to be typed. Pausing or resuming fails
  (409) if the timer was never started, or if it was but has gone three
  hours idle and is now considered stale — either way you start a new one.

## Stack

| Layer    | Technology                                  |
| -------- | ------------------------------------------- |
| Backend  | Cloudflare Workers + Hono + Zod             |
| Database | Cloudflare D1 (SQLite)                      |
| Frontend | Preact + htm, bundled with esbuild          |
| Auth     | Cloudflare Access, JWT verified with `jose` |
| Testing  | Vitest + `@cloudflare/vitest-pool-workers`  |

## Getting Started

### Prerequisites

- Node.js and npm
- A Cloudflare account with Workers and D1 access

### Setup

```bash
npm install

# Create the D1 database (first time only)
npx wrangler d1 create outwatch
# Paste the database_id output into wrangler.toml

# Apply schema + season data locally
npx wrangler d1 migrations apply outwatch --local

# Apply schema + season data to production
npx wrangler d1 migrations apply outwatch

# Add the roster — the people and their login emails (not committed; see "The roster")
cp roster.example.sql roster.sql   # then edit in the real names + emails
npx wrangler d1 execute outwatch --local  --file=roster.sql
npx wrangler d1 execute outwatch --remote --file=roster.sql

# Seed sample watched state for local dev (optional)
npx wrangler d1 execute outwatch --local --file=seed.sql

# Tell the Worker how to verify Access tokens (production only; see "Authentication")
npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. https://your-team.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # the application's AUD tag

# Start dev server
npm run dev
```

### Local dev identity

`wrangler dev` bypasses Cloudflare Access, so there's no signed-in user by
default. Copy `.dev.vars.example` to `.dev.vars` and set `DEV_USER_EMAIL` to one
of the login emails from your `roster.sql` to act as that person locally. There
is no Access token to verify locally, so `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
are not needed for local dev.

### The roster

The roster — who the board's columns are and which login emails may act as each
one — contains real names and email addresses, so it is **not committed**. It
lives in `roster.sql`, which is gitignored; `roster.example.sql` is the committed
template with fake placeholders.

- **Columns** (`users`) — one row per person or couple; `name` is the column header.
- **Login emails** (`user_emails`) — maps each Cloudflare Access email to a
  column (a couple's column has two emails).
- **Byline name** (`user_emails.name`) — the individual's display name on a
  discussion note. It's optional: leave it `NULL` and the note falls back to
  the column's own name. Set it for each half of a shared column so their
  notes read as two voices instead of one.
- **User ids** are deliberately generic (`user-1`, `user-2`, …) so nothing in
  source control reveals who the real people are. Keep these ids; change only the
  names and emails.

`roster.example.sql` upserts login emails on conflict rather than ignoring
them, so re-editing a name (or moving an email to a different column) and
re-running it updates the existing row instead of silently doing nothing.

```bash
cp roster.example.sql roster.sql
# edit roster.sql — real names + emails, keeping the generic user-N ids

# apply to local and production (separate from `migrations apply`)
npx wrangler d1 execute outwatch --local  --file=roster.sql
npx wrangler d1 execute outwatch --remote --file=roster.sql
```

### Validation

CI runs these checks on every push and pull request to `main`.
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) is a thin caller of the
shared `jluszcz/github-utils` `node-ci` workflow, which runs them on Node 22.
Run them locally before committing — any failure fails the build:

```bash
npm ci                  # install from the lockfile
npm run build           # frontend bundle must build
npm test                # all tests must pass
npm run lint            # ESLint
npm run format:check    # Prettier (run `npm run format` to fix)
```

### Build

The frontend is bundled from `frontend/` to `public/script.js` by `build.js`
(esbuild). The bundle is gitignored. `npm run dev` runs the bundler in watch mode
alongside `wrangler dev`; `npm run deploy` builds before deploying. Bundling
happens only through these npm scripts — `wrangler.toml` has no `[build]` hook —
so a bare `wrangler dev` or `wrangler deploy` serves whatever is already in
`public/`.

```bash
npm run build    # one-shot production bundle
```

### Deploy

```bash
npm run deploy
```

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` must both be set as secrets before anyone
can sign in: without them the Worker cannot verify an Access token and refuses
every request that carries one (500, "Access verification is not configured")
rather than trusting it unchecked.

## API

All routes derive the caller's identity from the signed Cloudflare Access token in
the `Cf-Access-Jwt-Assertion` header (or `DEV_USER_EMAIL` locally). Clients never
send a user id, and the plaintext `Cf-Access-Authenticated-User-Email` header is
never trusted — see [Authentication](#authentication).

| Method   | Path                                               | Description                                                                                                                                                                                                                 |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/board`                                       | Current user, all users, and all seasons with watched state, episode counts, and post counts                                                                                                                                |
| `POST`   | `/api/watched`                                     | Mark the caller as having watched a season (`{ season_id }`)                                                                                                                                                                |
| `DELETE` | `/api/watched/:season_id`                          | Unmark the caller for a season                                                                                                                                                                                              |
| `PUT`    | `/api/currently-watching`                          | Set the caller's currently-watching season, or clear it (`{ season_id }`, nullable)                                                                                                                                         |
| `POST`   | `/api/seasons/:season_id/episodes/:episode/posts`  | Add a discussion note, stamped with the caller's live watch-timer offset (`{ body }`)                                                                                                                                       |
| `GET`    | `/api/seasons/:season_id/discussion`               | Per-episode discussion state for a season, gated by the spoiler rule; each post carries `author_name`, `author_index`, and `mine`, and each episode's `authors` names its bylined individuals — emails are never serialized |
| `POST`   | `/api/seasons/:season_id/episodes/:episode/reveal` | Open one episode's discussion board for reading (permanent)                                                                                                                                                                 |
| `DELETE` | `/api/posts/:post_id`                              | Delete one of the caller's own discussion notes, scoped to the individual author; a note from before individual attribution stays deletable by the column                                                                   |
| `POST`   | `/api/seasons/:season_id/episodes/:episode/timer`  | Start, pause, or resume the caller's watch timer for an episode (`{ action }`)                                                                                                                                              |

## Database Schema

**`users`** — board columns (a person or a couple)

| Column                         | Type    | Notes                                                      |
| ------------------------------ | ------- | ---------------------------------------------------------- |
| `id`                           | TEXT PK | Generic id, e.g. `user-1`                                  |
| `name`                         | TEXT    | Column header (e.g. `Bob & Carol`)                         |
| `sort_order`                   | INTEGER | Column order                                               |
| `currently_watching_season_id` | INTEGER | References `seasons.id`; `NULL` when not watching a season |

**`user_emails`** — maps each Access login email to a column

| Column    | Type    | Notes                                                                 |
| --------- | ------- | --------------------------------------------------------------------- |
| `email`   | TEXT PK | Cloudflare Access email; `COLLATE NOCASE`                             |
| `user_id` | TEXT    | References `users.id`; a couple's column has two rows                 |
| `name`    | TEXT    | Display name on a discussion note; NULL falls back to the column name |

Both tables are populated from the gitignored `roster.sql`, not a migration —
see [The roster](#the-roster).

**`seasons`** — _Survivor_ seasons (reference data, seeded in migration `0002`)

| Column          | Type       | Notes                                                                   |
| --------------- | ---------- | ----------------------------------------------------------------------- |
| `id`            | INTEGER PK | The season number                                                       |
| `subtitle`      | TEXT       | Official subtitle without the `Survivor: ` prefix; empty for 41–49      |
| `wikipedia_url` | TEXT       | Link to the season's Wikipedia article                                  |
| `episode_count` | INTEGER    | Episode count from Wikipedia's episode table; added in migration `0005` |

**`watched`** — one row per (user, season) watched; presence means watched

| Column       | Type    | Notes                   |
| ------------ | ------- | ----------------------- |
| `user_id`    | TEXT    | References `users.id`   |
| `season_id`  | INTEGER | References `seasons.id` |
| `created_at` | TEXT    | ISO timestamp           |

Primary key is `(user_id, season_id)`.

**`posts`** — one row per discussion note

| Column         | Type       | Notes                                                                                              |
| -------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `id`           | INTEGER PK | Autoincrement                                                                                      |
| `season_id`    | INTEGER    | References `seasons.id`                                                                            |
| `episode`      | INTEGER    | Episode number within the season                                                                   |
| `user_id`      | TEXT       | References `users.id`; the note's author                                                           |
| `body`         | TEXT       | Note text                                                                                          |
| `created_at`   | TEXT       | ISO timestamp                                                                                      |
| `offset_secs`  | INTEGER    | Author's watch-timer offset at post time; `NULL` if no timer was running                           |
| `author_email` | TEXT       | References `user_emails.email`; who wrote the note. NULL on notes predating individual attribution |

**`reveals`** — presence means that user opened that episode's board for reading (one-way)

| Column       | Type    | Notes                   |
| ------------ | ------- | ----------------------- |
| `user_id`    | TEXT    | References `users.id`   |
| `season_id`  | INTEGER | References `seasons.id` |
| `episode`    | INTEGER | Episode number          |
| `created_at` | TEXT    | ISO timestamp           |

Primary key is `(user_id, season_id, episode)`.

**`watch_sessions`** — a running or paused watch timer, stale after three hours idle

| Column             | Type    | Notes                                                          |
| ------------------ | ------- | -------------------------------------------------------------- |
| `user_id`          | TEXT    | References `users.id`                                          |
| `season_id`        | INTEGER | References `seasons.id`                                        |
| `episode`          | INTEGER | Episode number                                                 |
| `elapsed_secs`     | INTEGER | Banked time from completed segments                            |
| `running_since`    | TEXT    | Start of the current segment; `NULL` while paused              |
| `last_activity_at` | TEXT    | Touched by start/pause/resume/post; drives the staleness clock |

Primary key is `(user_id, season_id, episode)`.

## Authentication

Sign-in is handled entirely by Cloudflare Access at the edge — no application
code, no password to store. Access forwards each authenticated request with a
signed JWT in the `Cf-Access-Jwt-Assertion` header; the Worker verifies that
token and maps its `email` claim through `user_emails` to a board column. That
column is the unit of identity for everything the app does — checkboxes, watch
timers, episode reveals — except discussion note authorship: a note is bylined
to the individual, so the verified email itself is recorded on the post,
letting a shared column's two people post under their own names. Local
development bypasses Access (see "Local dev identity").

### Why the token and not the header

Access also sets a plaintext `Cf-Access-Authenticated-User-Email` header, and
reading it is the shorter path. This app ignores it, because that header is only
trustworthy on a hostname the Access application actually fronts — Access
overwrites whatever the client sent, but only where Access is in the request path.
A Worker answers on _every_ hostname bound to it, `*.workers.dev` included, and on
one Access does not cover anybody could send that header and act as any member of
the roster. So the Worker verifies the token instead:

- the RS256 signature, against the team's published keys at
  `<team domain>/cdn-cgi/access/certs` (fetched and cached by `jose`, which
  refetches on key rotation),
- the `iss` claim, against `ACCESS_TEAM_DOMAIN`,
- the `aud` claim, against `ACCESS_AUD` — the AUD tag is per-application, so
  without this a valid token for any _other_ Access application in the same Zero
  Trust account would be accepted here,
- and `exp`, so an expired token is not reusable.

A token that fails any of these is a 403; identity never falls back to the
plaintext header. That holds no matter which hostname the request arrived on, so
Access misconfiguration is no longer an impersonation risk. (Access is still what
keeps strangers off the site — a request with no token at all is treated as signed
out, and can read the board but change nothing.)

### Setting up accounts in Cloudflare Access

There are **no accounts to create** — Access just allow-lists email addresses and
verifies ownership with a one-time emailed code. This works for any email
(Gmail, Yahoo, etc.) with no identity provider to configure. After deploying:

1. **Enable a login method.** Cloudflare dashboard → **Zero Trust** → **Settings**
   → **Authentication** → **Login methods** → add **One-time PIN** (it's the
   default). This emails each person a 6-digit code to sign in.
2. **Create the Access application.** Zero Trust → **Access** → **Applications** →
   **Add an application** → **Self-hosted**. Set the application domain to your
   deployed Worker's hostname (your `*.workers.dev` URL or a custom domain routed
   through Cloudflare).
3. **Add an Allow policy.** In the application, add a policy named e.g. `Watchers`
   with action **Allow** and a rule: Selector **Emails**, listing every address
   from your `roster.sql` (e.g. `alice@example.com`, `bob@example.com`,
   `carol@example.com`, …). Save.
4. **Point the Worker at the application.** In the application's **Additional
   settings**, copy the **Application Audience (AUD) Tag** — it never changes
   unless the application is recreated — and set both secrets:

    ```bash
    npx wrangler secret put ACCESS_TEAM_DOMAIN   # https://your-team.cloudflareaccess.com
    npx wrangler secret put ACCESS_AUD           # the AUD tag from above
    ```

    These are what the Worker verifies each token against. Until they're set,
    every signed-in request fails with a 500 (see "Why the token and not the
    header").

5. **Share the link.** Each person visits the site, enters their email, gets a
   code, and they're in. Their email must also exist in `user_emails` (loaded
   from `roster.sql`) for the board to know which column is theirs.

The allow-list in step 3 and the `user_emails` table must agree: Access decides
_who can get in_; `user_emails` decides _which column they are_.

If you later move the Worker to a custom domain, create or extend the Access
application to cover that hostname too. Token verification means an uncovered
hostname is no longer an impersonation risk, but a hostname Access doesn't front
sends no token at all, so nobody signed in can do anything there.

## Cost

Designed to run within Cloudflare's free tier:

- **Workers**: 100,000 requests/day
- **D1**: 5M reads/day, 100K writes/day, 5 GB storage
- **Access**: up to 50 users

## License

MIT
