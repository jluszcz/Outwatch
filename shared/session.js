// The watch-timer rule, shared by the Worker (which stamps posts) and the
// browser (which renders the ticking chip). Both must agree exactly: if the
// client kept counting past the point the server stops stamping, the UI would
// promise an offset that never lands on the post.

// Three hours without a start, pause, resume, or post ends a session. Without
// this a timer left running overnight would stamp the next morning's note
// +19:42:11 into an episode that ran 45 minutes.
export const SESSION_IDLE_LIMIT_SECS = 3 * 60 * 60;

// The largest correction anyone may apply to an episode's zero point, in
// seconds either direction. An hour is already far past any plausible mistake
// about where an episode started; beyond it the caller has a bug, and failing
// loudly beats storing it. Lives here rather than in the Worker so the UI's
// clamp and the API's 400 are the same number.
export const MAX_OFFSET_ADJUST_SECS = 3600;

// The largest single skip anyone may apply to a live timer, in seconds either
// direction. Its own constant rather than reusing MAX_OFFSET_ADJUST_SECS: the
// two bound different things — one a correction to an episode's zero point,
// the other a single live jump — and only happen to start out at the same
// value.
export const MAX_SKIP_DELTA_SECS = 3600;

// Accumulated watch time right now, or null when there is no live session.
// `nowMs` is a millisecond epoch so callers can pass the server clock rather
// than a possibly-skewed local one.
//
// `adjustSecs` is the reader's correction for this episode (see
// migration 0008): timers drift by a constant shift, so a correction is a
// constant added at the end. It deliberately does not participate in the
// staleness check above — a correction says where the episode started, not
// when the app was last touched, so it can never revive a dead session. It is
// also deliberately not clamped at zero: a backwards correction can push an
// early note negative, which sorts truthfully while formatOffset and
// formatOffsetShort clamp what is shown.
export function sessionOffsetSecs(session, nowMs, adjustSecs = 0) {
    if (!session) return null;

    const idleSecs = (nowMs - Date.parse(session.last_activity_at)) / 1000;
    if (idleSecs > SESSION_IDLE_LIMIT_SECS) return null;

    // Paused sessions bank their total in elapsed_secs and contribute no
    // running segment. Clamp the segment at zero so a skewed clock cannot wind
    // the timer backwards.
    const runningSecs = session.running_since
        ? Math.max(0, (nowMs - Date.parse(session.running_since)) / 1000)
        : 0;

    return Math.round(session.elapsed_secs + runningSecs) + adjustSecs;
}
