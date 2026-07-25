# Per-Episode Discussion Boards

**Date**: 2026-07-25
**Status**: Approved, not yet implemented

## Problem

The group watches Survivor at different cadences. Discussing an episode means
either spoiling someone who is behind or saying nothing. A shared board that
shows _who has watched what_ already exists; what is missing is somewhere to put
the reactions.

## Solution

Every episode of every season gets a discussion board. Boards are **write-only by
default**: you can post to one, and you see your own posts, but everyone else's
bodies stay hidden until you deliberately open that episode for reading. Opening
is per-episode, permanent, and one-way.

A board also carries an optional **watch timer**. Start it when you press play and
your posts are stamped with how far into the episode you were. When the board is
read, posts from everyone sort into a single synced timeline by that offset, so a
conversation reads in episode order even though it was written days apart.

## Definitions

- **Locked** — an episode board whose foreign post bodies are hidden from you.
- **Readable** — the opposite; you have opened it, or you have watched the season.
- **Offset** — seconds of accumulated watch time when a post was written.
- **Timed post** — a post with a stored offset. **Untimed** — one without.

## Data Model

New migration `migrations/0005_discussions.sql`.

```sql
ALTER TABLE seasons ADD COLUMN episode_count INTEGER NOT NULL DEFAULT 0;
UPDATE seasons SET episode_count = 13 WHERE id = 1;   -- ×50, sourced from Wikipedia

CREATE TABLE posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id   INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    offset_secs INTEGER,          -- running time when posted; NULL if no live timer
    FOREIGN KEY (season_id) REFERENCES seasons (id),
    FOREIGN KEY (user_id)   REFERENCES users (id)
);
CREATE INDEX idx_posts_board ON posts (season_id, episode, id);

-- Presence = "this user opened this episode's board for reading." One-way.
CREATE TABLE reveals (
    user_id    TEXT    NOT NULL,
    season_id  INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

CREATE TABLE watch_sessions (
    user_id          TEXT    NOT NULL,
    season_id        INTEGER NOT NULL,
    episode          INTEGER NOT NULL,
    elapsed_secs     INTEGER NOT NULL DEFAULT 0,  -- banked, before current segment
    running_since    TEXT,                        -- NULL while paused
    last_activity_at TEXT    NOT NULL,            -- start/resume/pause/post touch this
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);
```

Episodes are a validated integer, not a table. They have no attributes of their
own beyond the number, so a row per episode would carry no information.

Sessions are per `(user, episode)` and are not mutually exclusive: a stale session
on another episode is harmless because offsets freeze at post time and an
untouched session expires on its own.

### Episode counts

`episode_count` is the number of episodes listed in each season's Wikipedia
episode table, **excluding the reunion special**. A two-hour premiere counts as
the single episode Wikipedia lists. Counts range 13–16.

This is the only hand-transcribed data in the feature and therefore the most
likely place for a quiet error. Spot-check a few well-known seasons after it
lands.

## The Spoiler Rule

One predicate, evaluated **server-side only**. Hidden bodies are excluded by the
SQL and never leave the Worker — this is not a `display: none`.

```
readable(me, season, ep) = me has watched season
                       OR  (me, season, ep) ∈ reveals
```

|                     | readable   | locked         |
| ------------------- | ---------- | -------------- |
| Post bodies         | everyone's | **yours only** |
| Post count          | shown      | shown          |
| Author names        | shown      | shown          |
| Can post, run timer | yes        | yes            |

Author names on a locked board are deliberate: the main board already shows who
has watched which season, so naming who posted reveals nothing new.

Consequences, all intentional:

- Marking a season watched retroactively opens every episode in it.
- **Un**marking a season does not re-lock anything. Reveal rows are independent,
  and an un-mark is far more likely a mis-click correction than a memory wipe.
- Reveal is one-way. There is no re-lock button; you cannot unsee it anyway.
- Posting does not reveal. You can drop a note on episode 7 and stay blind to the
  other four.
- A caller who is not on the roster gets a coherent read with nothing in it: no
  roster row means no `watched` and no `reveals`, so every board is locked with
  zero own-posts. Mutations return 403.

## The Watch Timer

Three actions: `start`, `pause`, `resume`. There is no stop button. **Three hours
without any activity ends a session**, where activity is any of start, pause,
resume, or posting. Restarting is `start` again, which zeroes the session.

Offset is computed on the server at write time and frozen onto the post. It is
never recomputed.

```
live   = now − last_activity_at ≤ 3h
offset = live ? elapsed_secs + (running_since ? now − running_since : 0) : NULL
```

Posting while paused is a first-class case — pause, type, resume is the natural
rhythm — and the post carries the frozen offset.

Once three hours have passed since the last activity the client stops ticking and
shows the session as expired, rather than displaying a growing offset the server
would no longer apply.

## Ordering a Revealed Board

Every post receives an offset, real or inferred. Per `(author, episode)`:

- **The author has at least one timed post** — those posts use their stored
  `offset_secs`. Any untimed post of theirs (the session expired; they came back
  days later) sorts to the tail of the board by wall-clock and is displayed with
  an absolute timestamp rather than a fabricated offset.
- **The author has no timed posts** — their earliest post on that episode becomes
  their `0:00`, and every post of theirs is placed at `created_at − that zero`,
  displayed as `~+13:00` with a marker showing the offset is inferred.

Sort by offset ascending; ties break by `created_at`.

Worked example. Alice starts watching at 9:00pm and posts at 9:10, 9:30, 9:45,
9:50. Bob starts at 6:00am days later and posts at 6:05, 6:11, 6:35.

```
Bob    +5:00
Alice  +10:00
Bob    +11:00
Alice  +30:00
Bob    +35:00
Alice  +45:00
Alice  +50:00
```

This ordering is a pure function over the post list, lives in `frontend/utils.js`,
and is unit-tested against exactly this scenario plus the inferred and tail cases.

## API

All routes resolve the caller through the existing `callerUser(c)`. Validation
uses Zod with the existing `onInvalid` handler, so failures return
`{ error: "…" }` with a 400.

| Route                                       | Body         | Behaviour                                                          |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `GET /api/seasons/:id/discussion`           | —            | The whole season in one response                                   |
| `POST /api/seasons/:id/episodes/:ep/posts`  | `{ body }`   | 201, returns the created post; touches `last_activity_at`          |
| `DELETE /api/posts/:id`                     | —            | Yours only; **404** if not yours, so it cannot probe for existence |
| `POST /api/seasons/:id/episodes/:ep/reveal` | —            | `INSERT OR IGNORE`; idempotent                                     |
| `POST /api/seasons/:id/episodes/:ep/timer`  | `{ action }` | `start` \| `pause` \| `resume`; returns session state              |

`GET /api/seasons/:id/discussion` response shape:

```json
{
    "season": { "id": 45, "subtitle": "", "wikipedia_url": "…", "episode_count": 13 },
    "me": { "id": "user-1", "name": "Alice" },
    "now": "2026-07-25T21:10:00.000Z",
    "episodes": [
        {
            "episode": 1,
            "readable": true,
            "count": 4,
            "authors": ["user-1", "user-2"],
            "posts": [
                {
                    "id": 17,
                    "user_id": "user-1",
                    "body": "called it",
                    "created_at": "2026-07-24T21:10:00.000Z",
                    "offset_secs": 600
                }
            ],
            "session": { "elapsed_secs": 0, "running_since": "…", "live": true }
        }
    ]
}
```

`posts` holds everyone's posts when `readable`, and only the caller's when locked.
`count` and `authors` always cover everyone. `session` is `null` when the caller
has none. `now` is the server clock, so a device with a skewed clock still renders
a correct ticking timer.

One request per season view is deliberate — the data is tiny for a group of four,
and it matches the existing all-at-once shape of `GET /api/board`.

Validation rules:

- `body` — trimmed, 1–2000 characters.
- `episode` — positive integer, `≤ seasons.episode_count`; otherwise 404.
- `action` — enum of `start`, `pause`, `resume`.
- Unknown season — 404.

`GET /api/board` gains `episode_count` and a `post_count` per season — the total
across every episode of that season, by every author — so the board can show a
badge. Without it there is no way to tell which seasons have any discussion at
all.

`DELETE /api/posts/:id` returns 404 both for a post that does not exist and for
one belonging to someone else; the two cases are deliberately indistinguishable.

## Frontend

### File split

`frontend/script.js` is 520 lines today; a season view plus timer would push it
past 900. Splitting along seams that already exist:

```
frontend/
  script.js      App, hash routing, shared state          (~250)
  board.js       Header, NowWatching, SeasonRow, Board     (~200, moved)
  discussion.js  SeasonView, EpisodeBoard, PostList, PostForm, WatchTimer
  api.js         the api() fetch helper                    (moved)
  utils.js       + orderPosts, sessionOffset, formatOffset
```

The generation/deferral guard in `App` (`boardGen`, `boardFetches`,
`mutationsInFlight`, `refreshQueued`) is extracted into a `useRefreshGuard()` hook
so the season view reuses it instead of growing a second, subtly different copy.

### Routing

`useHashRoute()` parses `#/season/N` from `location.hash` and listens for
`hashchange`. Anything unparseable falls back to the board. No router library.

On the board, the season title becomes the link into the season view; the
Wikipedia link moves into the season-view header.

### Season view

One collapsible card per episode, `1..episode_count`.

- Card header: `Episode N`, post count, author names, and a lock icon when locked.
- Locked body: your own posts, `— 3 notes hidden —`, and `[ Show discussion ]`.
- Readable body: the ordered timeline with offset labels.
- Either way: the compose box and the timer controls.

### Timer UI

`[ Start watching ]` becomes a chip ticking `▶ +12:34` with `[Pause]` /
`[Resume]`, driven client-side from the server's `elapsed_secs` and
`running_since` plus the delta between `now` and the local clock.

### Mutations

Posting is not optimistic — the offset is server-assigned, so the compose box
disables while the request is in flight and the returned post is appended.
Checkbox toggles keep their existing optimistic behaviour.

The season view refetches on focus and visibility change, exactly as the board
does, so other people's posts arrive without a reload.

## Testing

### Worker — `test/worker/discussion.test.js`

The gate is the part worth being paranoid about.

- A locked board returns the correct `count` and `authors` and leaks **no** foreign
  bodies, while still returning the caller's own posts.
- Revealing opens the board; revealing twice is idempotent.
- A watched season auto-opens every one of its episodes.
- Un-marking a watched season preserves existing reveals.
- Post validation: empty body, whitespace-only body, over 2000 characters,
  episode 0, episode past `episode_count`, unknown season.
- Deleting your own post works; deleting another user's returns 404 and the row
  survives.
- A caller who is not on the roster can read (seeing nothing) but cannot mutate.

Timer behaviour:

- `start` yields an offset of approximately zero.
- `pause` banks elapsed time; `resume` continues from it.
- A post written while paused carries the frozen offset.
- A session seeded with `last_activity_at` four hours in the past yields
  `offset_secs = NULL`.

Seeding `last_activity_at` directly avoids introducing a clock abstraction.

### Frontend — `test/frontend/posts.test.js`

- `orderPosts` against the Alice/Bob worked example, asserting the exact order.
- The inferred-zero case for an author with no timed posts.
- The tail placement for an author with both timed and untimed posts.
- Tie-breaking by `created_at` when two offsets match.
- `formatOffset` for `+0:00`, `+5:00`, and `+1:05:00`.

## Out of Scope

Deliberately excluded to keep the surface small:

- Editing posts. Delete and re-post instead.
- Re-locking a revealed episode.
- Replies, threading, reactions, or mentions.
- Unread counts and notifications.
- Episode titles and air dates.

## Documentation

`CLAUDE.md` and `README.md` are updated as part of the work: repository
structure, schema, API routes, and the frontend notes.

Per the project rule, every committed file uses fake placeholders only — the
`user-N` ids and the Alice / Bob / Carol names already established in
`roster.example.sql`.
