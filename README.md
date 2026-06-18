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
- Fully-watched seasons gray out and sink to the bottom
- Light/dark theme toggle
- Zero-code authentication via Cloudflare Access

## Stack

| Layer    | Technology                                 |
| -------- | ------------------------------------------ |
| Backend  | Cloudflare Workers + Hono + Zod            |
| Database | Cloudflare D1 (SQLite)                     |
| Frontend | Preact + htm, bundled with esbuild         |
| Auth     | Cloudflare Access                          |
| Testing  | Vitest + `@cloudflare/vitest-pool-workers` |

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

# Start dev server
npm run dev
```

### Local dev identity

`wrangler dev` bypasses Cloudflare Access, so there's no signed-in user by
default. Copy `.dev.vars.example` to `.dev.vars` and set `DEV_USER_EMAIL` to one
of the login emails from your `roster.sql` to act as that person locally.

### The roster

The roster — who the board's columns are and which login emails may act as each
one — contains real names and email addresses, so it is **not committed**. It
lives in `roster.sql`, which is gitignored; `roster.example.sql` is the committed
template with fake placeholders.

- **Columns** (`users`) — one row per person or couple; `name` is the column header.
- **Login emails** (`user_emails`) — maps each Cloudflare Access email to a
  column (a couple's column has two emails).
- **User ids** are deliberately generic (`user-1`, `user-2`, …) so nothing in
  source control reveals who the real people are. Keep these ids; change only the
  names and emails.

```bash
cp roster.example.sql roster.sql
# edit roster.sql — real names + lowercase emails, keeping the generic user-N ids

# apply to local and production (separate from `migrations apply`)
npx wrangler d1 execute outwatch --local  --file=roster.sql
npx wrangler d1 execute outwatch --remote --file=roster.sql
```

### Running tests

```bash
npm test
```

### Build

The frontend is bundled from `frontend/` to `public/script.js` by `build.js`
(esbuild). The bundle is gitignored. `npm run dev` runs the bundler in watch mode
alongside `wrangler dev`; `npm run deploy` builds before deploying.

```bash
npm run build    # one-shot production bundle
```

### Deploy

```bash
npm run deploy
```

## API

All routes derive the caller's identity from the
`Cf-Access-Authenticated-User-Email` header that Cloudflare Access injects (or
`DEV_USER_EMAIL` locally). Clients never send a user id.

| Method   | Path                      | Description                                                  |
| -------- | ------------------------- | ------------------------------------------------------------ |
| `GET`    | `/api/board`              | Current user, all users, and all seasons with watched state  |
| `POST`   | `/api/watched`            | Mark the caller as having watched a season (`{ season_id }`) |
| `DELETE` | `/api/watched/:season_id` | Unmark the caller for a season                               |

## Database Schema

**`users`** — board columns (a person or a couple)

| Column       | Type    | Notes                              |
| ------------ | ------- | ---------------------------------- |
| `id`         | TEXT PK | Generic id, e.g. `user-1`          |
| `name`       | TEXT    | Column header (e.g. `Bob & Carol`) |
| `sort_order` | INTEGER | Column order                       |

**`user_emails`** — maps each Access login email to a column

| Column    | Type    | Notes                                                 |
| --------- | ------- | ----------------------------------------------------- |
| `email`   | TEXT PK | Cloudflare Access email (lowercase)                   |
| `user_id` | TEXT    | References `users.id`; a couple's column has two rows |

Both tables are populated from the gitignored `roster.sql`, not a migration —
see [The roster](#the-roster).

**`seasons`** — _Survivor_ seasons (reference data, seeded in migration `0002`)

| Column          | Type       | Notes                                                              |
| --------------- | ---------- | ------------------------------------------------------------------ |
| `id`            | INTEGER PK | The season number                                                  |
| `subtitle`      | TEXT       | Official subtitle without the `Survivor: ` prefix; empty for 41–49 |
| `wikipedia_url` | TEXT       | Link to the season's Wikipedia article                             |

**`watched`** — one row per (user, season) watched; presence means watched

| Column       | Type    | Notes                   |
| ------------ | ------- | ----------------------- |
| `user_id`    | TEXT    | References `users.id`   |
| `season_id`  | INTEGER | References `seasons.id` |
| `created_at` | TEXT    | ISO timestamp           |

Primary key is `(user_id, season_id)`.

## Authentication

Authentication is handled entirely by Cloudflare Access at the edge — no
application code. Access forwards each request with a verified
`Cf-Access-Authenticated-User-Email` header, which the Worker maps through
`user_emails` to a board column. Local development bypasses Access (see "Local
dev identity").

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
4. **Share the link.** Each person visits the site, enters their email, gets a
   code, and they're in. Their email must also exist in `user_emails` (loaded
   from `roster.sql`) for the board to know which column is theirs.

The allow-list in step 3 and the `user_emails` table must agree: Access decides
_who can get in_; `user_emails` decides _which column they are_.

## Cost

Designed to run within Cloudflare's free tier:

- **Workers**: 100,000 requests/day
- **D1**: 5M reads/day, 100K writes/day, 5 GB storage
- **Access**: up to 50 users

## License

MIT
