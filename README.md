# Outwatch

A shared tracker for which seasons of _Survivor_ a small group has watched. One
row per season ("Season X: Subtitle", linked to Wikipedia) and one checkbox
column per person. You can only toggle your own column — identity comes from
Cloudflare Access. Once everyone has checked a season, it grays out and sorts to
the bottom.

Built on Cloudflare Workers with a D1 SQLite database, behind Cloudflare Access.

## Features

- Every U.S. season of _Survivor_ seeded with official subtitles + Wikipedia links
- One checkbox column per person/couple; you can only change your own (Access-derived identity)
- Couples share a column — either partner's login can toggle it
- Discussion notes are bylined to the individual who wrote them, so a shared column speaks with two voices
- Fully-watched seasons gray out and sink to the bottom
- Per-episode discussion boards, write-only until you open them
- Notes can be replied to and reacted to, and rewritten or deleted by whoever wrote them
- Light/dark theme toggle
- Installs to a phone home screen as a standalone app, with its own icon
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
  instead of by when they happened to be typed. Click the running time to
  pause, click it again to resume. Pausing or resuming fails
  (409) if the timer was never started, or if it was but has gone three
  hours idle and is now considered stale — either way you start a new one.
  Notice your notes landed in the wrong spot on that timeline? The ± control
  next to the timer corrects it after the fact — one number per episode,
  shifting every note you've already posted there along with it, so you don't
  have to catch the drift in the moment.
- **Replies, reactions, and edits.** A note can answer another note on the same
  episode, and it renders as a quote block above the reply rather than as an
  indented thread. A reply keeps its own place on the watch-offset timeline,
  with one exception: it's never shown above the note it answers, even if its
  offset would otherwise put it there — a reply pulled down like that shows no
  offset rather than one that reads backwards.
  Anyone who can see a note can put any emoji on it — four are one tap away in
  the note's menu and a ＋ opens a searchable picker for the rest, up to twelve
  different emoji per note. Reactions are per person rather than per column, so
  both halves of a shared login count separately. You can rewrite or delete your own notes. An edit
  changes only the body and marks the note edited, leaving its position on the
  timeline alone; a delete detaches any reply to it rather than leaving a
  `[deleted]` tombstone, since deleting is an author's "unsay it" and a
  tombstone preserves what they removed.

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

## Home Screen Icon

The site is installable: add it to a phone's home screen and it launches
standalone, with its own icon and no browser chrome. There is deliberately no
service worker — every load still hits the network, because a cached, stale
board is worse than a spinner for a tracker whose whole point is showing what
everyone else has done.

One caveat, inherent to Cloudflare Access rather than to the manifest: an
installed app on iOS gets its own cookie storage, separate from Safari's. The
first launch from the home screen therefore runs the Access login flow again,
and may bounce out to Safari and back before landing in the app. It is a
one-time cost per install.

### Regenerating the icons

`assets/icon-source.png` is the original artwork; every other icon is derived
from it with macOS's built-in `sips` and committed. Regenerate only if the
artwork changes:

```bash
sips -s format png -Z 512 assets/icon-source.png --out public/icon-512.png
sips -s format png -Z 192 assets/icon-source.png --out public/icon-192.png
sips -s format png -Z 180 assets/icon-source.png --out public/apple-touch-icon.png
sips -s format png -Z 32  assets/icon-source.png --out public/favicon-32.png

# maskable: shrink to 80%, then pad back out, so Android's circular crop only
# ever removes padding. The pad matches the artwork's black background.
sips -s format png -Z 410 assets/icon-source.png --out /tmp/icon-410.png
sips --padToHeightWidth 512 512 --padColor 000000 /tmp/icon-410.png --out public/icon-maskable-512.png
```

There is no build step for this — the icons are committed, so CI never needs an
image toolchain. The source sits in `assets/` rather than `public/` because
everything under `public/` is uploaded as a Workers static asset and answerable
at its own URL; the original is 1.8 MiB that no page links to, so there is no
reason to serve it.

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

`roster.example.sql` upserts both tables on conflict rather than ignoring
them, so re-editing a column name, a byline, or an email (or moving an email
to a different column) and re-running it updates the existing rows instead of
silently doing nothing. To retire a login — someone's address changes, or they
leave the group — repoint its `user_emails` row rather than deleting it: D1
enforces foreign keys unconditionally, so once that email has authored a note,
`DELETE FROM user_emails` fails with an opaque foreign-key error, while an
`UPDATE`/upsert that reassigns the row leaves `posts.author_email` untouched.

```bash
cp roster.example.sql roster.sql
# edit roster.sql — real names + emails, keeping the generic user-N ids

# apply to local and production (separate from `migrations apply`)
npx wrangler d1 execute outwatch --local  --file=roster.sql
npx wrangler d1 execute outwatch --remote --file=roster.sql
```

### Test data

`scripts/insert-test-post.py` inserts one fake discussion post directly into
the local D1 database, for exercising the discussion UI (long notes, old or
future timestamps, different authors) without posting through the app. It's
stdlib-only Python, reads no network, and never touches production — it only
opens the local SQLite file under `.wrangler/state/`, which `npm run dev`
must have created at least once.

```bash
scripts/insert-test-post.py                                     # random author, season 1 episode 1, now
scripts/insert-test-post.py --author Bob --season 5 --episode 3 --length 60
scripts/insert-test-post.py --time 5 --unit hours                # 5 hours ago
scripts/insert-test-post.py --time 2 --unit days --future        # 2 days from now
```

Run it repeatedly (or in a shell loop) to build up more than one post.

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

Apply any new migrations to production before deploying — `npm run deploy`
does not do this for you. Deploying Worker code that reads or writes a column
a migration hasn't added yet breaks outright; `author_email` (migration
`0006`) is the current example, since the Worker both selects and inserts it
on every discussion request.

```bash
npx wrangler d1 migrations apply outwatch
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

| Method   | Path                                               | Description                                                                                                                                                                                                                      |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/board`                                       | Current user, all users, and all seasons with watched state, episode counts, and post counts                                                                                                                                     |
| `POST`   | `/api/watched`                                     | Mark the caller as having watched a season (`{ season_id }`)                                                                                                                                                                     |
| `DELETE` | `/api/watched/:season_id`                          | Unmark the caller for a season                                                                                                                                                                                                   |
| `PUT`    | `/api/currently-watching`                          | Set the caller's currently-watching season, or clear it (`{ season_id }`, nullable)                                                                                                                                              |
| `POST`   | `/api/seasons/:season_id/episodes/:episode/posts`  | Add a discussion note, stamped with the caller's live watch-timer offset and their author email (`{ body, reply_to_post_id? }`)                                                                                                  |
| `PATCH`  | `/api/posts/:post_id`                              | Rewrite one of the caller's own notes and mark it edited (`{ body }`); never touches its timestamp, watch offset, or reply target, so an edit cannot move it on the timeline                                                     |
| `PUT`    | `/api/posts/:post_id/reactions`                    | Add or remove one emoji on a note the caller can see (`{ emoji, on }`); any single emoji is accepted, up to 12 distinct per note; idempotent in both directions and attributed to the individual rather than their column        |
| `GET`    | `/api/seasons/:season_id/discussion`               | Per-episode discussion state for a season, gated by the spoiler rule; each post carries its byline and the caller's own ownership flag, and each episode's `authors` names its bylined individuals — emails are never serialized |
| `POST`   | `/api/seasons/:season_id/episodes/:episode/reveal` | Open one episode's discussion board for reading (permanent)                                                                                                                                                                      |
| `DELETE` | `/api/posts/:post_id`                              | Delete one of the caller's own discussion notes, scoped to the individual author; a note from before individual attribution stays deletable by the column                                                                        |
| `POST`   | `/api/seasons/:season_id/episodes/:episode/timer`  | Start, pause, or resume the caller's watch timer for an episode (`{ action }`)                                                                                                                                                   |
| `PUT`    | `/api/seasons/:season_id/episodes/:episode/offset` | Correct where this episode started for the caller (`{ adjust_secs }`, absolute, within ±3600); shifts every note they have posted on that episode                                                                                |

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

| Column          | Type       | Notes                                                                                    |
| --------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `id`            | INTEGER PK | The season number                                                                        |
| `subtitle`      | TEXT       | Official subtitle without the `Survivor: ` prefix; empty for the modern numbered seasons |
| `wikipedia_url` | TEXT       | Link to the season's Wikipedia article                                                   |
| `episode_count` | INTEGER    | Episode count from Wikipedia's episode table; added in migration `0005`                  |

**`watched`** — one row per (user, season) watched; presence means watched

| Column       | Type    | Notes                   |
| ------------ | ------- | ----------------------- |
| `user_id`    | TEXT    | References `users.id`   |
| `season_id`  | INTEGER | References `seasons.id` |
| `created_at` | TEXT    | ISO timestamp           |

Primary key is `(user_id, season_id)`.

**`posts`** — one row per discussion note

| Column             | Type       | Notes                                                                                                                                                |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | INTEGER PK | Autoincrement                                                                                                                                        |
| `season_id`        | INTEGER    | References `seasons.id`                                                                                                                              |
| `episode`          | INTEGER    | Episode number within the season                                                                                                                     |
| `user_id`          | TEXT       | References `users.id`; the note's column (the individual author, when known, is `author_email`)                                                      |
| `body`             | TEXT       | Note text                                                                                                                                            |
| `created_at`       | TEXT       | ISO timestamp                                                                                                                                        |
| `offset_secs`      | INTEGER    | Author's watch-timer offset at post time; `NULL` if no timer was running                                                                             |
| `author_email`     | TEXT       | References `user_emails.email`; who wrote the note. NULL on notes predating individual attribution                                                   |
| `reply_to_post_id` | INTEGER    | References `posts.id`; the note being answered. NULL for an ordinary note, and for a reply whose parent was later deleted. Added in migration `0007` |
| `edited_at`        | TEXT       | ISO timestamp of the last rewrite; NULL on a note never edited. Added in migration `0007`                                                            |

A reply is always in the same season and episode as the note it answers — the
API enforces that at write time, so no read path re-checks it.

**`reactions`** — one row per (note, person, emoji); presence means that person put that emoji on that note (migration `0007`)

| Column       | Type    | Notes                                                         |
| ------------ | ------- | ------------------------------------------------------------- |
| `post_id`    | INTEGER | References `posts.id`                                         |
| `email`      | TEXT    | References `user_emails.email`; `COLLATE NOCASE`, never NULL  |
| `emoji`      | TEXT    | Any single emoji (`isReactionEmoji` in `shared/reactions.js`) |
| `created_at` | TEXT    | ISO timestamp                                                 |

Primary key is `(post_id, email, emoji)`. Keyed on the email rather than a
column, so both halves of a shared login react separately — the same call as a
note's byline, and the opposite of the column-level watched checkbox.

`created_at` is read, not just recorded: a note's chips are ordered by when each
emoji first appeared on it, so a chip does not change places as counts move.

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

**`watch_offsets`** — one revisable correction to where an episode started, per (user, season, episode)

| Column        | Type    | Notes                                       |
| ------------- | ------- | ------------------------------------------- |
| `user_id`     | TEXT    | References `users.id`                       |
| `season_id`   | INTEGER | References `seasons.id`                     |
| `episode`     | INTEGER | Episode number                              |
| `adjust_secs` | INTEGER | Signed correction, in seconds, within ±3600 |
| `updated_at`  | TEXT    | ISO timestamp                               |

Primary key is `(user_id, season_id, episode)`. Deliberately not a column on
`watch_sessions` — starting a timer zeroes that row, and a correction has to
survive a restart and be writable even when no session exists at all.
Applied on read, not stored into `posts.offset_secs`, so a correction stays
revisable and reaches notes already posted. Added in migration `0008`.

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

Designed to run within Cloudflare's free tier — the daily request cap on
Workers, the read/write/storage caps on D1, and the seat cap on Access are the
limits that apply, and a group this size is orders of magnitude under all of
them. Check Cloudflare's pricing pages for the current numbers.

## License

MIT
