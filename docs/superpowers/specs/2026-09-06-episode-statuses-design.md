# Episode statuses

## Problem

The board records what you have watched at season granularity, and the
discussion boards record what you said at episode granularity. Neither can say
what you *intend* — that Season 3 Episode 8 is a recap you are deliberately
skipping. Without that, the other people watching read your silence on an
episode as "not there yet" when it actually means "not coming."

## Scope

One status, `skipping`, set per board column per episode and carrying a
required reason of `recap` or `reunion`. Visible to everyone. Display only: it
does not reveal the episode, does not appear on the board row, and does not
appear in the what's-new feed.

Deliberately excluded, and why:

- **A per-episode `watched` status.** The season checkbox and the live watch
  timer already answer that, and a third source of truth for "seen it" would
  disagree with the board's gray-out rule.
- **A free-text reason.** A fixed value the UI can reason about — and group by,
  see the chip below — beats a line it can only print.
- **A skip with no reason.** Both kinds of skip this board actually sees have a
  name, and an unlabeled skip is mostly a shrug. Allowing one later means
  making `reason` nullable and adding one branch to the chip.
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
    reason     TEXT    NOT NULL,
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
- **Two enum columns rather than one.** `status` has exactly one legal value
  today, which is why this is not a `reveals`-style presence table: a second
  status later is a change to a string set in the route rather than a
  migration. It also carries real meaning against `reason` — `reason` applies
  to `skipping` and would not apply to a future status, so the route validates
  the *pair*, not two independent fields. Absence of a row means no status, so
  there is exactly one representation of "nothing to say."

`reunion` is a legal reason even though `seasons.episode_count` (migration
`0005`) excludes reunion specials: where a season folds its reunion into the
numbered finale, that finale is a real, numbered, skippable episode.

## API

### `PUT /api/seasons/:season_id/episodes/:episode/status`

Body `{ status, reason }`. Either `status: null` (clears the row, `reason`
absent or `null`) or `status: "skipping"` with `reason` one of `"recap"` or
`"reunion"`.
Anything else — an unrecognised status, a skip with no reason, a reason with no
status — is a 400.

The value is absolute rather than a toggle, the same reason the reactions route
takes an explicit `on` and the offset route takes an absolute `adjust_secs`: a
retried or duplicated request lands on the same state instead of flipping back
out of it. It is also what lets the reason be changed in place — `recap` to
`reunion` is one request, not an unskip followed by a re-skip.

Requires a real episode and roster membership (`callerAndEpisode`, caller
checked before episode as everywhere else), but deliberately **neither a reveal
nor a live session** — deciding to skip an episode is something you do before
watching it, so gating on either would be backwards.

### `GET /api/seasons/:season_id/discussion`

Each episode gains `statuses: [{ user_id, name, status, reason }]` —
everyone's, in roster order, not just the caller's. The caller finds their own
by matching `me.id`, so there is no second per-caller field for the two to
drift apart.

`statuses` is **not** subject to the spoiler filter. A status is not content,
and it shows on a locked board for the same reason the `authors` list does:
knowing that someone is skipping an episode reveals nothing about what happens
in it. Emails are never serialized, as everywhere else.

## Frontend

- `discussion.js` — `SeasonView` gains `setStatus(episode, status, reason)`,
  routed through `mutate()` like every other mutation, passed down as
  `onStatus`.
- `EpisodeBoard` — the collapsed header's meta line gains the skip chip after
  the note summary and author list, so a skip is visible while scanning without
  expanding anything. `.episode-actions` gains a menu button between "Show
  discussion" and the timer, rendered under the same `meId` guard the timer
  uses.
- **The menu.** The button opens a short list: `Recap`, `Reunion`, and — only
  when the caller currently has a status — `Not skipping`, which clears it.
  Picking the reason already in effect closes the menu without a request.
  Clearing is its own item rather than a second tap on the active reason, so
  changing your mind about *why* and changing your mind about *whether* are
  never the same gesture. Open-menu state is episode-scoped in `EpisodeBoard`,
  matching how `menuFor` scopes the per-note `⋯` menu.
- `utils.js` — `skipLabel(statuses, meId)`. Unanimous reasons collapse to
  `Skipping recap: You, Bob & Carol`; mixed reasons fall back to a reason per
  name, `Skipping: You (recap), Bob & Carol (reunion)`. "You" first, the rest
  in roster order, empty string when nobody is skipping. Pure, and labelling
  lives in `utils.js` in this repo, which is also where its test can reach it.
  The mixed branch is the rarer of the two and so the one most likely to rot
  unnoticed — it gets its own tests rather than riding on the common case.
- `styles.css` — `.episode-skips` for the chip, `.skip-btn` and its menu
  alongside `.reveal-btn`.
- `icons.js` — add lucide `SkipForward` as `skipForward`, used in the button.
  The header chip stays plain text: that line already carries a literal `🔒`,
  and adding a second emoji beside it would establish an emoji register that
  competes with `icons.js` being the app's only icon system.

## Testing

Test-driven: each behaviour below gets a failing test before its
implementation.

- `test/worker/discussion.test.js` — setting a skip with each reason; changing
  the reason in place; clearing with `status: null`; idempotence in both
  directions; 400 for an unrecognised status, an unrecognised reason, a skip
  with no reason, and a reason with no status; 403 off the roster; 404 on an
  episode that does not exist; statuses present on a locked board; statuses
  scoped to the season they were set on.
- `test/worker/migrations.test.js` — the new table exists.
- `test/frontend/utils.test.js` — `skipLabel` with no statuses, the caller
  only, several people agreeing on a reason, several people disagreeing, and
  others skipping without the caller.

## Documentation

- Root `CLAUDE.md` — the new table under Database Schema, and the new route
  plus the `statuses` field under API Routes, which is the API's only
  reference.
- `frontend/CLAUDE.md` — the chip, the menu, and why a status is not
  spoiler-gated.
- `README.md` — a bullet under the discussion section.
