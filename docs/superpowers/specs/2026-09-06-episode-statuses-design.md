# Episode statuses

## Problem

The board records what you have watched at season granularity, and the
discussion boards record what you said at episode granularity. Neither can say
what you *intend* — that Season 3 Episode 8 is a recap you are deliberately
skipping. Without that, the other people watching read your silence on an
episode as "not there yet" when it actually means "not coming."

## Scope

One status, `skipping`, set per board column per episode, visible to everyone.
Display only: it does not reveal the episode, does not appear on the board row,
and does not appear in the what's-new feed.

Deliberately excluded, and why:

- **A per-episode `watched` status.** The season checkbox and the live watch
  timer already answer that, and a third source of truth for "seen it" would
  disagree with the board's gray-out rule.
- **A free-text reason.** A fixed value the UI can reason about beats a line
  it can only print.
- **Auto-revealing a skipped episode.** Plausible — skipping implies you do not
  mind its spoilers — but a reveal is permanent and one-way, so an accidental
  tap on the wrong episode would burn a spoiler gate that cannot be restored.

## Data model

Migration `0011_episode_statuses.sql`:

```sql
CREATE TABLE episode_statuses (
    user_id    TEXT    NOT NULL,
    season_id  INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    status     TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);

CREATE INDEX idx_episode_statuses_season ON episode_statuses (season_id);
```

Shaped after `watch_offsets`:

- **Keyed on `user_id`, not an email.** This is the same split the rest of the
  schema draws — authorship and reactions are per individual, everything about
  watching is per column. A couple shares a screen, so they skip the recap
  together.
- **Indexed on `season_id`.** The read path loads every user's statuses for a
  season at once, filtering on the primary key's second column, which the
  implicit PK index cannot serve.
- **A `status` text column rather than a `reveals`-style presence table.**
  `skipping` is the only legal value today, but a second one is then a change
  to a string set in the route rather than a migration. Absence of a row means
  no status, so there is exactly one representation of "nothing to say."

## API

### `PUT /api/seasons/:season_id/episodes/:episode/status`

Body `{ status }`, either `"skipping"` or `null`. Sets the caller's status for
that episode; `null` deletes the row.

The value is absolute rather than a toggle, the same reason the reactions route
takes an explicit `on` and the offset route takes an absolute `adjust_secs`: a
retried or duplicated request lands on the same state instead of flipping back
out of it.

Requires a real episode and roster membership (`callerAndEpisode`, caller
checked before episode as everywhere else), but deliberately **neither a reveal
nor a live session** — deciding to skip an episode is something you do before
watching it, so gating on either would be backwards. Any value that is not one
of the two legal ones is a 400.

### `GET /api/seasons/:season_id/discussion`

Each episode gains `statuses: [{ user_id, name, status }]` — everyone's, in
roster order, not just the caller's. The caller finds their own by matching
`me.id`, so there is no second per-caller field for the two to drift apart.

`statuses` is **not** subject to the spoiler filter. A status is not content,
and it shows on a locked board for the same reason the `authors` list does:
knowing that someone is skipping an episode reveals nothing about what happens
in it. Emails are never serialized, as everywhere else.

## Frontend

- `discussion.js` — `SeasonView` gains `setStatus(episode, status)`, routed
  through `mutate()` like every other mutation, passed down as `onStatus`.
- `EpisodeBoard` — the collapsed header's meta line gains the skip chip after
  the note summary and author list, so a skip is visible while scanning without
  expanding anything. `.episode-actions` gains a toggle button between
  "Show discussion" and the timer, rendered under the same `meId` guard the
  timer uses. The button is an optimistic toggle through `mutate()` with no
  local state of its own.
- `utils.js` — `skipLabel(statuses, meId)`, returning `Skipping: You, Bob &
  Carol` or the empty string. Pure, "You" first and the rest in roster order.
  Labelling lives in `utils.js` in this repo, which is also where its test can
  reach it.
- `styles.css` — `.episode-skips` for the chip, `.skip-btn` alongside
  `.reveal-btn`.
- `icons.js` — add lucide `SkipForward` as `skipForward`, used in the button.
  The header chip stays plain text: that line already carries a literal `🔒`,
  and adding a second emoji beside it would establish an emoji register that
  competes with `icons.js` being the app's only icon system.

## Testing

Test-driven: each behaviour below gets a failing test before its
implementation.

- `test/worker/discussion.test.js` — setting a status, clearing it with `null`,
  idempotence in both directions, 400 on an unrecognised value, 403 off the
  roster, 404 on an episode that does not exist, statuses present on a locked
  board, and statuses scoped to the season they were set on.
- `test/worker/migrations.test.js` — the new table exists.
- `test/frontend/utils.test.js` — `skipLabel` with no statuses, the caller
  only, the caller plus others, and others only.

## Documentation

- Root `CLAUDE.md` — the new table under Database Schema, and the new route
  plus the `statuses` field under API Routes, which is the API's only
  reference.
- `frontend/CLAUDE.md` — the chip and button, and why a status is not
  spoiler-gated.
- `README.md` — a bullet under the discussion section.
