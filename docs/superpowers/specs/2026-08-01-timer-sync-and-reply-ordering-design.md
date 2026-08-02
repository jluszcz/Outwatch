# Timer sync and reply ordering

Two independent changes that land in adjacent code: a retroactive correction for
a watch timer that started at the wrong moment, and a rule that stops a reply
rendering above the note it answers.

## Problem

**Timers drift.** Everyone watches separately, so the drift is never a live
clock-sync problem — it is a wrong zero. One person starts the timer before the
"previously on", another after the cold open, a third skips the recap outright.
The result is a constant shift between two people for the rest of the episode:
notes about the same moment are stamped tens of seconds to a minute apart, and
`orderPosts` interleaves them wrongly around exactly the moments worth talking
about.

The drift is discovered _after the fact_ — you see your note land in the wrong
place — and by then `offset_secs` is frozen onto it. A correction that only
steers the live timer would fix nothing you can see, which is why the design is
retroactive.

**Replies can precede their parents.** `orderPosts` places every note by watch
offset alone. Two people whose timers disagree can produce a reply stamped
earlier than the note it answers, so the quote block appears above the note it
quotes. Drift makes this more likely, but the two are separate: a reply written
from a stale-session tail post can outrank its parent with no drift at all.

## Part 1 — Retroactive timer correction

### The stored fact

Migration `0008` adds:

```sql
CREATE TABLE watch_offsets (
    user_id     TEXT    NOT NULL,
    season_id   INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    adjust_secs INTEGER NOT NULL,
    updated_at  TEXT    NOT NULL,
    PRIMARY KEY (user_id, season_id, episode),
    FOREIGN KEY (user_id)   REFERENCES users (id),
    FOREIGN KEY (season_id) REFERENCES seasons (id)
);
```

One number per `(user, season, episode)`, because one number is all a constant
shift needs.

It deliberately does **not** live on `watch_sessions`. `start` zeroes that row —
it is the "I'm beginning this episode" action — and zeroing a correction would
silently un-shift notes it had already moved. The correction has to outlive the
session that produced it.

Keyed on `user_id` rather than an email, matching `watch_sessions`: a couple
shares a column, shares a screen, and therefore shares a timer and its
correction. This is the same column/individual split already drawn elsewhere —
authorship and reactions are per individual, everything about watching is per
column.

`posts.offset_secs` keeps meaning exactly what it means today: what the writer's
timer read at write time. Nothing is rewritten. Correcting on read is what makes
the adjustment revisable, and what makes a bad nudge undoable.

### The read path

`GET /api/seasons/:season_id/discussion` gains one query in its existing
`Promise.all`, loading every user's adjustments for the season (not just the
caller's — a post is shifted by _its own author's_ correction):

```sql
SELECT user_id, episode, adjust_secs FROM watch_offsets WHERE season_id = ?
```

Each post serializes `offset_secs + adjust_secs` for its author's column, so
`orderPosts` and every renderer stay untouched and the client never learns a
correction exists — the same call the reaction ordering makes, where the server
resolves and the client only draws. A post with a `NULL` `offset_secs` (no timer
was running) stays `null`; there is nothing to shift.

The corrected value may go negative, and that is left alone: `formatOffset` and
`formatOffsetShort` already clamp their display at zero, while the negative sorts
naturally and keeps the author's notes in their true relative order. Clamping the
stored value instead would collapse several early notes onto the same offset.

Each episode also carries its own `adjust_secs` alongside `session`, because the
live chip ticks locally and must add the same number.

### The shared rule

`sessionOffsetSecs(session, nowMs, adjustSecs = 0)` gains a third parameter in
`shared/session.js`, keeping the one rule both sides compute in one place. The
staleness check still runs against the uncorrected session — an adjustment is a
statement about the episode's zero point, not about when you last touched the
app.

Writer stamps raw, reader adds the adjustment, chip shows raw + adjustment. What
you watch tick is what everyone else reads.

### The write path

`PUT /api/seasons/:season_id/episodes/:episode/offset` with an **absolute**
`{ adjust_secs }`, not a delta. Same reasoning the reactions route documents for
its explicit `on` boolean: the client computes the new total from what the server
last reported, so a double-tap, a retry, or a slow network can't accumulate a
correction nobody asked for. Idempotent by construction.

- Its own route rather than a fourth `action` on the timer route: it writes no
  session, and it must work whether or not one is live.
- `|adjust_secs| > 3600` is a 400. An hour is already far past any plausible
  zero-point error; beyond it the caller has a bug, and failing loudly beats
  storing it.
- `adjust_secs === 0` deletes the row rather than storing a zero, so "no
  correction" has one representation.
- Attributed to the caller's own `users.id`, like every other watch mutation —
  there is no client-supplied user id, so you can only correct your own timer.
- Requires a real episode (`resolveEpisode`) and roster membership, matching the
  timer route. It does **not** require a session or a reveal: correcting an
  episode you have already finished is exactly the case that matters.

### The UI

The `.episode-actions` row gains a `±` toggle beside Restart. Expanded, it shows
a second row:

```
−1m   −15s   ·  +0:45  ·   +15s   +1m        Reset
```

Not four more buttons inline: that row already wraps below roughly 430px, and it
is the row whose height is deliberately pinned so the timer does not move under a
cursor mid-click.

The running total is shown because it is persistent stored state, not a momentary
action — you need to see how far you have pushed yourself to know whether to undo
it. Reset renders only when the total is non-zero, and sends `adjust_secs: 0`.

Steps are 15s and 1m: a skipped recap is roughly a minute, and 15s covers the
"started a beat late" case without four taps.

The correction is invisible on the notes themselves. A shifted offset is not
annotated, because the corrected value _is_ the claim — the raw reading was never
the interesting number, and marking corrected notes would invite reading the
stamp as disputed.

### Known limit

One number is a constant shift, so it is exactly right for a wrong zero, and
right for a skipped recap _from the skip onward_. A note posted before the skip
moves along with the rest, and it was already correct.

Modelling that properly means per-segment corrections — a piecewise timeline per
person per episode — which is a great deal of machinery for the one or two notes
written in the first minute of an episode. Accepted rather than solved, and
recorded here so the next person does not mistake it for an oversight.

## Part 2 — A reply never precedes its parent

Entirely `orderPosts` in `frontend/utils.js`. No server change: `reply_to_post_id`
is already constrained to a post in the same season and episode that the caller
can see, so a parent that is visible at all is in the same list.

### The rule

The sort key becomes the tuple `[tail, offset, created, id]`, compared
lexicographically — the same ordering the current comparator expresses, with `id`
appended. Each reply's key is then clamped to at least its parent's
_already-clamped_ key, resolved by memoized recursion so a chain of replies
resolves in one pass.

Three details carry the weight:

- **`id` as the final component** is what breaks an exact tie correctly. A
  parent's id is always smaller than its reply's, because the parent had to exist
  to be replied to. So a reply clamped to precisely its parent's key still lands
  directly after it, never before.
- **`tail` inside the clamp** handles the case that has nothing to do with drift:
  an untimed stray parent sits in the tail while its timed reply would otherwise
  sort up in the timeline. Clamping the whole tuple pulls the reply down into the
  tail with it.
- **An absent parent clamps nothing.** A `reply_to` that is `null` (ordinary
  note, or the parent was deleted) or `{ id, locked: true }` has no placement to
  clamp against — and in the locked case the parent is not rendered at all, so
  there is no ordering to violate.

Cycles are impossible for the same reason `id` works as a tiebreaker, but the
recursion carries an in-progress guard anyway and treats a cycle as "no parent"
rather than recursing forever.

### The display

A placement gains `clamped: true` when the rule actually moved it. `Post` renders
`.post-time` **empty** for a clamped reply rather than showing a stamp that reads
lower than the note above it.

The span itself still renders, so the fixed `2.5rem` gutter that aligns every
body in the board is preserved — this is a blank chip, not a missing one. Its
`title` keeps the wall-clock time and gains the true offset, so the stamp is one
hover away without being asserted in the column.

## Testing

Worker (`test/worker/discussion.test.js`, `test/worker/migrations.test.js`):

- A stored adjustment shifts that author's posts in the discussion response, and
  leaves every other author's alone.
- The adjustment applies to the episode it names and no other.
- A post with a `null` `offset_secs` stays `null` under a non-zero adjustment.
- `PUT .../offset` is idempotent: sending the same absolute value twice leaves one
  row and one value.
- `adjust_secs: 0` removes the row.
- `|adjust_secs| > 3600` is a 400; a non-integer is a 400.
- Correcting without a live session succeeds; correcting an unknown episode 404s;
  a caller off the roster gets 403.
- `start` on the timer route zeroes the session and leaves the adjustment intact —
  the regression the separate table exists to prevent.

Shared (`test/frontend/session.test.js`):

- `sessionOffsetSecs` adds the adjustment, defaults it to zero when omitted, and
  still returns `null` for a stale session regardless of adjustment.

Frontend (`test/frontend/posts.test.js`):

- A reply stamped before its parent sorts directly after it.
- A chain of three replies, each stamped before the last, resolves in order.
- A timed reply to a tail parent follows it into the tail.
- A reply with a locked, deleted, or absent parent is untouched.
- A reply already after its parent is not marked `clamped`, and one that moved is.
- Existing ordering behaviour — inferred zeros, tails, real offsets — is unchanged
  when no replies are involved.

## Out of scope

- **Setting the timer to the player's elapsed time.** Considered and declined; the
  nudge covers the same ground with less UI.
- **Anchoring to another person's note.** Same reason, and it syncs you to a
  person rather than to the show, inheriting their error.
- **Tolerance buckets in the timeline.** Corrects nothing; only hides small drift.
- **Any live co-watch handshake.** The group always watches async, so there is no
  shared moment to hand off.
