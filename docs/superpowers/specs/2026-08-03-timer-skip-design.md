# Live timer skip

A forward-only correction for drift discovered while watching — skipping a
recap or a montage — that leaves already-posted notes exactly where they are.
It sits alongside the existing retroactive correction (migration `0008`,
`watch_offsets`), which stays unchanged and keeps solving the case it was
built for.

## Problem

The existing `±` correction (`adjust_secs`) is a single constant shift applied
on read to every note in an episode, including ones already posted. That is
exactly right for a wrong zero point discovered after the fact — one person
started the timer before the "previously on," and the whole episode needs to
move by the same amount. It is wrong for drift discovered live: skip five
minutes of filler mid-episode, nudge the correction forward to stay in sync,
and every note already posted before the skip — which was already correctly
placed — moves along with it and lands wrong. The root `CLAUDE.md`'s "Known
limit" section already documents this gap and declines to fix it, calling
per-segment corrections "a great deal of machinery for the one or two notes it
would actually move back into place." The prior spec's "Out of scope" section
similarly declined "setting the timer to the player's elapsed time," reasoning
the nudge covered the same ground with less UI — true for the wrong-start
case, not for this one.

What's needed is a correction that only ever affects posts written **after**
it's applied.

## Mechanism: bake the correction into the session, not into a read-time overlay

Two facts about the existing code make this cheap:

- `posts.offset_secs` is already frozen at write time from
  `currentOffsetSecs`, which reads the raw session (`elapsed_secs` +
  whatever's accumulated since `running_since`) with **no** adjustment baked
  in.
- The existing correction only ever touches a post's displayed offset at read
  time, in `GET .../discussion` (`p.offset_secs + adjustFor(...)`). It never
  rewrites the stored value.

So a correction that changes `watch_sessions.elapsed_secs` directly, rather
than adding a read-time overlay, gets forward-only semantics for free: the
live chip (which derives from `elapsed_secs`) reflects it immediately, the
next post written picks it up automatically because it's stamped fresh from
the session at write time, and every already-frozen `offset_secs` is
untouched because nothing reads or rewrites it. No new table, no history to
track, no per-segment machinery — the frozen `offset_secs` on each existing
post already **is** the record of what was in effect when it was written.

### The write path: a `skip` timer action

A fourth action on the existing `POST /api/seasons/:season_id/episodes/:episode/timer`
route: `{ action: 'skip', delta_secs }`.

- `delta_secs` is a nonzero integer, bounded by a new `MAX_SKIP_DELTA_SECS`
  constant in `shared/session.js` (3600, same value as
  `MAX_OFFSET_ADJUST_SECS` but its own knob — the two bound different things
  and shouldn't be coupled just because they start out equal).
- Requires an existing, non-stale session — the same two 409s `pause` and
  `resume` already return (`No timer to update` / the three-hour expiry
  message), for the same reason: reviving a dead session by writing to it
  would be wrong regardless of which field gets written.
- `elapsed_secs = MAX(0, elapsed_secs + delta_secs)`, `last_activity_at = now`.
  Works identically whether the session is running or paused, and never
  touches `running_since` — `elapsed_secs` is summed with the running segment
  either way (`shared/session.js`), so bumping it moves the total regardless
  of state. The floor at zero mirrors the existing clamp on the running
  segment itself ("a skewed clock cannot wind the timer backwards"):  a skip
  back further than the session has banked lands at zero instead of going
  negative.
- No change to `shared/session.js`, no migration. `sessionOffsetSecs` already
  sums `elapsed_secs` correctly; it doesn't need to know a skip happened.

### A new `stop` action, to reach "no session" on demand

The existing code deliberately has no stop action — "a session simply goes
stale after three hours." That was fine when staleness was the only thing
naming the correction's availability. It isn't anymore: the panel described
below is modal on whether a session is live, and three hours is too long to
wait to reach the other mode on purpose.

`{ action: 'stop' }`: `DELETE FROM watch_sessions WHERE (user_id, season_id,
episode) = ?`. Idempotent regardless of whether a row existed — like `DELETE
/api/watched/:season_id`, calling it on an already-gone session is still a
success, not a 409. The response carries `session: null, offset_secs: null`,
the same shape the client already handles for "no session at all."

## UI

### The panel is modal on session state, not a manual switch

`WatchTimer` already branches on `offset === null` to decide whether the chip
shows "Start watching" or the ticking pill. The `±` panel's contents branch
the same way — no separate mode toggle, because the mode isn't a preference,
it's a consequence of whether there's a live session to skip:

- **Live session** → **Skip**: `−1m −15s +15s +1m`, wired to the new `skip`
  action. No running total and no Reset — there's nothing separate to revert
  to. A skip is folded permanently into `elapsed_secs` the moment it's applied,
  the same way `pause` permanently banks a running segment; undoing an
  overshoot is a tap in the other direction, not a reset to zero.
- **No session** → **Correct**: unchanged from the existing design — running
  total, Reset once it's non-zero, the same four buttons wired to
  `PUT .../offset`.

This covers all three ways "no session" happens today (never started,
manually stopped, gone stale) with the one existing branch, and it means
there's no state where the wrong panel is one accidental tap away from the
right one.

### `Stop`, in the main timer row

A new button beside Restart, visible only while a session is live. It's a
session-lifecycle action like Start/Pause/Resume, not an adjustment, so it
lives with them rather than inside the `±` panel — tapping it is what gates
entry to Correct, and keeping it out of the panel means it can't be tapped by
accident while adjusting.

### An info affordance inside the panel

Because the panel you see depends on state the control doesn't otherwise
narrate, a first-time user watching a note land in the wrong place has no way
to discover the other mode exists without being told. A small ⓘ button inside
each panel variant, toggled open the same way `.timer-adjust-toggle` already
is (`aria-expanded`, tap or keyboard focus — not a bare hover `title`, since
half this app's users are on a phone with no hover), reveals one or two lines:

- **Skip panel**: "Moves your timer without changing notes you've already
  posted. Tap Stop to fix where this episode started instead — that moves
  everything."
- **Correct panel**: "Moves every note on this episode, including ones you've
  already posted. Start the timer again to go back to adjusting live."

`title` can carry the same text as a hover hint on pointer devices, but the
toggle is what makes it reachable on a phone.

### Optimistic taps

Skip reuses the existing `pendingAdjust` / `nudgeSeqRef` / `settledAdjust`
pattern Correct already has for race-safe rapid taps, adapted to a local
`pendingSkip` total. The difference: Correct settles against the server's
echoed absolute `adjust_secs`, a value the client owns and can Reset. Skip has
no such value to converge on — the server's `elapsed_secs`, once a refetch
lands, already reflects every committed skip — so `pendingSkip` simply resets
to `0` whenever the `session` prop's `elapsed_secs` / `last_activity_at`
changes, rather than settling to an echoed total. Failure handling is the same
shape as today: an optimistic bump reverts if its request comes back rejected
and it's still the newest one in flight.

## Known limits

The existing Correct mechanism's limit (root `CLAUDE.md`) doesn't change:
still one constant shift, still exactly right for a wrong start discovered
after the fact. Skip is what solves the complementary case — drift discovered
live — by baking the correction into `elapsed_secs` at the moment it happens
rather than trying to retrofit segment-awareness into a read-time overlay.

A related gap worth naming: fixing a **wrong start** live, before posting
anything, works fine with Skip (nudge, then post — every post from then on is
correct). But if notes have already been posted under the wrong start, Skip
can't reach back and fix them — only Stop-then-Correct can, which is exactly
the split this design draws. There's no single action that fixes both "notes
already posted" and "stay live" at once; that's the tradeoff the two panels
exist to make explicit instead of hiding.

## Testing

Worker (`test/worker/discussion.test.js` or a new `timer.test.js`):

- `skip` moves `elapsed_secs` forward and backward; the floor clamps a
  large backward skip at zero rather than going negative.
- `delta_secs` of `0`, a non-integer, or beyond `±MAX_SKIP_DELTA_SECS` is a
  400.
- `skip` with no session is a 409 (`No timer to update`); with a stale session,
  the same expiry 409 `pause`/`resume` return.
- A post's `offset_secs` written **before** a skip is unchanged by it; one
  written **after** reflects the shift — the core behavior this whole design
  is for.
- `skip` works identically whether the session is running or paused.
- `stop` deletes the session row and is idempotent — calling it twice, or
  with no row to begin with, both succeed.
- After `stop`, `GET .../discussion` reports `session: null` for that episode,
  and a new post written afterward stamps `offset_secs: null` (today's
  existing no-session behavior, unaffected).
- `PUT .../offset` (Correct) still works with no live session — no regression
  from adding `stop`.

Frontend (`test/frontend/`):

- The pure settle helper backing `pendingSkip` (mirroring the existing
  `settledAdjust` tests): advances on success, reverts on failure, and does
  nothing when a newer tap has already taken over.

There's no DOM test suite in this repo (per `frontend/CLAUDE.md`), so the
panel's modal switch (live session → Skip, no session → Correct) and the
Stop button's placement are verified manually, the way the mobile layout
already is.

## Out of scope

- **A history of skip taps.** Only the current `elapsed_secs` total exists;
  there's no log of individual skips to review or undo one at a time.
- **Automatic filler/recap detection.** The user decides what to skip and by
  how much; nothing inspects the episode.
- **Merging Skip and Correct into one control.** Considered — a single panel
  with a mode switch — and declined in favor of the modal design: tying the
  available mode to session state removes an entire class of "tapped the
  wrong mode" mistakes that a manual switch would allow.
