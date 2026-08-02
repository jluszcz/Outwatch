# What's New — a bell with a feed of recent comments

## Goal

A bell in the header shows what has happened on the board since you last
checked. It carries a count of unread activity and opens a short, timestamped
list:

> Alice commented on Season 45 Episode 3 — 3 hours ago

Clicking a line takes you to that episode's discussion board.

## Scope

The feed lists **discussion comments only**, grouped per person per episode per
day. Your own comments are excluded — the feed is about what other people did.

"Bob & Carol started watching Season X" is deliberately **not** in the feed.
`users.currently_watching_season_id` is a single nullable column with no
timestamp and no history: there is no record of when it was set, and switching
seasons overwrites the previous value without a trace. Dating that event needs
either an append-only log or a new timestamp column, and neither is worth a
migration for one line in a panel. Comments are already timestamped in `posts`,
so they cost no new structure at all.

Reactions and reveals are out for the same reason the discussion view does not
announce them: a reaction is chatty (one note collects several) and a reveal is
a reading action rather than something said.

## Data

One migration, `0009_feed_seen.sql`:

```sql
ALTER TABLE user_emails ADD COLUMN feed_seen_at TEXT;
```

`NULL` means the person has never opened the bell.

It goes on `user_emails`, not `users`, so the seen mark is **per individual**.
A couple shares a board column, and marking the feed read is a thing a person
does with their own eyes — Bob opening the bell must not clear Carol's
badge. This matches the split the rest of the schema already draws: authorship
and reactions are per individual, everything about watching is per column.

There is **no event table**. Events are read from `posts.created_at` live. The
consequence that makes this the right call: a deleted note leaves the feed on
its own, and no denormalized row can drift from the note it describes. A
generic `events` log would leave a stale "Alice commented" line behind after
Alice deleted the note — preserving exactly what they unsaid, the same objection
that made `DELETE /api/posts/:post_id` detach replies rather than leave a
`[deleted]` ghost.

### Grouping

The group key is `(author, season, episode, sitting)` — one line per person per
episode per sitting, however many notes they left. A sitting ends after
`FEED_GROUP_GAP_MS` (6 hours) with no further note from that person on that
episode.

The line carries **no count**. "Alice commented on Season 45 Episode 3" already
implies one or more, and the number is not something you would act on
differently: two notes and five notes both mean go read the episode. Leaving it
out also keeps the line to one phrase with nothing trailing it, which is what
lets the panel stay a list of sentences rather than a table.

Grouping by author and episode alone would fold a note from three weeks ago
into today's group and stamp the pair with today's time, so the line would
claim two notes arrived three hours ago when one arrived three weeks ago.
Something has to end a group, and the obvious candidate — a calendar day — is
wrong here. `posts.created_at` is always UTC, so a "day" boundary falls at
8:00pm Eastern and 5:00pm Pacific, which is inside the evening someone actually
watches an episode. A session running 7:30–8:30pm ET straddles it and splits
into two lines showing the same sentence at two times, which reads as a bug
because it is one.

A gap between consecutive notes has no timezone in it at all, so it is right
wherever the viewer is, and it still separates the three-week-old note the day
rule was introduced to separate. Six hours is far longer than any pause inside
one sitting and far shorter than the gap to a later thought.

This is more precise than a day and no harder to compute, because it is not
computed in SQL: the route reads the window's rows and groups them in a single
pass in JavaScript (`groupNotes`, `src/feed.js`), which is also what lets the
unread count and the ten shown groups come from the same pass rather than two
queries that could disagree about what a group is.

The group's timestamp is its **newest** note.

The author key is the individual: `posts.author_email` when present, falling
back to the column's `user_id` for a note predating individual attribution
(migration `0006`). That is the same fallback the discussion route's byline
already uses, so a note groups and bylines under the same name.

### Window and caps

- **Window**: 30 days. Nothing older ever appears.
- **Panel**: at most 10 groups, newest first.
- **Unread with `feed_seen_at` NULL**: everything in the window counts unread.

## API

### `GET /api/feed`

```json
{
    "now": "2026-08-02T15:04:05.000Z",
    "unread_count": 3,
    "events": [
        {
            "author_name": "Alice",
            "season_id": 45,
            "episode": 3,
            "at": "2026-08-02T12:01:00.000Z",
            "unread": true
        }
    ]
}
```

- `events` holds at most 10 groups from the past 30 days, newest first,
  regardless of read state. The panel always has something to show — opening
  the bell on a quiet day lists recent activity rather than an empty box.
- `unread` marks a group whose newest note is later than the caller's
  `feed_seen_at`.
- `unread_count` counts **unread groups in the window**, not unread notes and
  not only the ten shown, so a badge of 14 over 10 visible lines is possible
  and deliberately unexplained — see the no-footer note under Rendering.
- The group's note count is deliberately **not** in the response. Nothing
  renders it, and a field the client ignores is a field that will drift.
- `now` is the server clock, echoed the way
  `GET /api/seasons/:season_id/discussion` already echoes one, so the client
  can render relative times without trusting the device clock.
- **No note bodies, ever.**

403 for a caller who is not on the roster, like every other route.

### `POST /api/feed/seen`

Stamps `user_emails.feed_seen_at` to the server's current time for the caller's
own email. No request body — the server uses its own clock rather than a
client-supplied timestamp, so the route cannot be used to backdate or
forward-date someone's seen mark. Idempotent. Returns `{ feed_seen_at }`.

403 off-roster.

### Disclosure

This exposes no new class of information. `GET /api/board` already carries a
`post_count` per season, and `GET /api/seasons/:season_id/discussion` already
names an episode's `authors` on a board the caller has not revealed — the
project's existing, deliberate position that knowing _who said something_ is
not a spoiler on a small household board, while knowing _what they said_ is.
The feed carries names, seasons, episodes, and times, and never a body, so the
spoiler rule needs no per-line enforcement here. Dropping the per-group note
count narrows it further than the discussion route, which does serialize a
`count` per episode.

## Frontend

### Components

New file `frontend/feed.js`, split in two the way `PostMenu`/`PostMenuPanel`
is in `post.js`:

- `FeedBell` — the trigger button and its unread badge. Always mounted.
- `FeedPanel` — the scrim, the list, and the close button. Mounts only while
  open, so its Escape listener and scrim are subscribed only when they can act.

The bell sits in `Header` beside the theme toggle. `Header` renders on both
routes (`App` draws it outside the route switch), so the bell is reachable from
a season view as well as the board.

### Layout

Two layouts, one DOM, following the rules `PostMenu` established:

- Pointer device: a dropdown absolutely positioned inside a
  `position: relative` wrapper in the header, with
  `position-try-fallbacks: flip-block` in an `@supports` block so the browser
  measures rather than the app.
- Below 640px: the same element becomes a `position: fixed` bottom sheet with
  a dimmed scrim and a close button in its top-right corner — the furthest
  point from the bottom edge iOS Safari's collapsed toolbar owns.

The scrim renders in both layouts (transparent on a pointer device) and is what
dismisses on an outside click, covering the trigger so clicking it while open
reaches the scrim rather than the trigger's own toggle.

### Data flow

`FeedBell` fetches `/api/feed` on mount and on focus, routed through
`useRefreshGuard` like every other fetch in the app, so a slow response cannot
overwrite a newer one.

Opening the panel fires `POST /api/feed/seen` and clears the badge
optimistically. The lines already rendered **keep** their unread marking until
the next fetch — otherwise every mark would vanish from under you at the moment
you opened the panel to read them. A failed `seen` restores the badge and
surfaces nothing: it is not worth an error banner, and the next open retries it.

### Rendering

A line reads:

```
Alice commented on Season 45 Episode 3
3 hours ago
```

The season subtitle is omitted — `seasonLabel`'s full form is too long for the
panel's width. Unread lines carry a marker (a dot in the leading gutter) rather
than a different background, so the list reads as one list.

Each line is a link to `#/season/45/episode/3` — a real anchor, not a click
handler, so it can be opened in a new tab and shows its destination on hover.

Empty state: "Nothing new yet."

There is deliberately **no "and N more" footer**. When the 10-line cap hides
older unread groups there is nothing useful to do about it — the panel has no
second page and the hidden groups are the least recent ones — so the footer
would only report a number and then decline to act on it. The badge already
says how much is unread; the list says what is worth opening.

### Relative time

`relativeTime(iso, nowMs)` in `frontend/utils.js`, pure and tested:

| Age          | Renders                      |
| ------------ | ---------------------------- |
| ≤ 5 minutes  | `just now`                   |
| < 60 minutes | `N minutes ago`              |
| < 24 hours   | `N hours ago` (`1 hour ago`) |
| otherwise    | `N days ago` (`1 day ago`)   |

Each tier truncates toward zero, so 119 minutes is "1 hour ago", not "2 hours
ago".

The five-minute floor is what keeps the panel from being wrong in the most
visible way: a note posted while you were reading the board reads "just now"
rather than ticking through "1 minute ago" at a precision nothing else here
claims. It also means the minutes tier never renders below `5 minutes ago`, so
`1 minute ago` is unreachable and the singular case exists only at the hours
and days tiers.

`nowMs` comes from the server's `now` field rather than `Date.now()`, so a
device with a wrong clock cannot render "in 3 hours" or age everything by a
day. The client computes the skew once per fetch and applies it.

Nothing older than the 30-day window reaches this function, so there is no
weeks-or-months tier to design.

## Routing

`useHashRoute` (`frontend/hooks.js`) gains an optional episode segment:

- `#/season/45` → `{ seasonId: 45, episode: null }` — unchanged meaning
- `#/season/45/episode/3` → `{ seasonId: 45, episode: 3 }`
- anything else → `{ seasonId: null, episode: null }`

The parse moves out of the hook into a pure `parseHashRoute(hash)` in
`utils.js`, so the regex is testable directly — the same split
`refresh-guard.js` and `submit-guard.js` already use for their rules. Both
segments keep the existing `[1-9]\d*` guard: no leading zeros and no bare `0`,
which would otherwise mount the view and surface the API's raw validation
error instead of falling back to the board.

`SeasonView` seeds its `openEpisode` state from the route's episode. The
accordion stays user-controlled after that — landing on an episode opens it,
and collapsing it does not rewrite the hash.

### Arriving at a locked episode

Following a feed line **expands** that episode's board and does nothing else.
It must never fire `POST .../reveal`.

This is the one place the feature could quietly undo the spoiler rule, and the
tempting reasoning is right there in the interaction: you clicked a
notification about a note, so surely you meant to read it. You did not — a
reveal is permanent and one-way, and spending someone's reveal on a tap they
made from a header panel is exactly the kind of thing they cannot undo. The
existing code already draws this line correctly: `onToggle` sets `openEpisode`
and `onReveal` posts the reveal, and they are separate handlers
(`frontend/discussion.js`). Seeding `openEpisode` from the route rides the
first and must not touch the second.

So a feed line pointing at an episode the caller has not watched or revealed
lands them on the locked board — 🔒, the note count, the authors, their own
notes, and the Reveal button — with the bodies absent because the server never
serialized them, not because the client is hiding them. That is a coherent
destination rather than a dead end: the feed told them something was said and
who said it, which is what the discussion route already discloses about a
locked board, and the Reveal button is right there if they want the rest.

## Testing

### Worker — `test/worker/feed.test.js`

- Groups a person's several notes on one episode on one day into a single
  event, stamped with the newest note's time, carrying no count
- Does **not** group notes on the same episode from different days
- Does not group two people's notes on the same episode together
- Excludes the caller's own notes
- A note with no `author_email` groups under its column's name
- `unread_count` counts every unread group in the window, including groups
  beyond the ten returned
- With `feed_seen_at` NULL, everything in the window is unread
- Notes older than 30 days do not appear
- At most 10 events are returned, newest first
- A deleted note drops out of the feed
- `POST /api/feed/seen` clears unread for that individual and leaves their
  partner's badge alone
- Both routes 403 for a caller who is not on the roster
- No response field carries a note body

### Frontend

- `relativeTime` tier boundaries in `test/frontend/utils.test.js`: 0s, 5m exactly
  (still "just now"), 5m01s (first `5 minutes ago`), 59m, 60m, 23h59m, 24h,
  multi-day; singular vs plural at the hours and days tiers; truncation toward
  zero
- `parseHashRoute` in `test/frontend/utils.test.js`: both accepted forms, the
  rejected `0` and leading-zero cases, and unrelated hashes

There is no DOM test suite, so "arriving at a locked episode does not reveal
it" cannot be asserted in CI. It is instead a property of the wiring: seeding
`openEpisode` is the only change to `SeasonView`, and `reveal` keeps its single
caller. A reviewer should check that `reveal`'s call sites still number one.

### Migration

`test/worker/migrations.test.js` covers the schema; extend it for the new
column if it asserts one per migration.

## Documentation

- Root `CLAUDE.md`: the `user_emails.feed_seen_at` column in Database Schema,
  and `GET /api/feed` / `POST /api/feed/seen` in API Routes
- `frontend/CLAUDE.md`: the bell's split, its two layouts, the
  keep-marks-until-refetch rule, and the extended hash route
- `README.md`: the feature, in the same voice as the discussion and reactions
  sections

## Out of scope

- Push notifications, email, or any delivery outside the page
- A per-event read state (the feed has one seen timestamp, not a per-line mark)
- Started-watching, reaction, and reveal events
- Marking the feed unread again
