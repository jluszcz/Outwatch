// The watch-timer rule, shared by the Worker (which stamps posts) and the
// browser (which renders the ticking chip). Both must agree exactly: if the
// client kept counting past the point the server stops stamping, the UI would
// promise an offset that never lands on the post.

// Three hours without a start, pause, resume, or post ends a session. Without
// this a timer left running overnight would stamp the next morning's note
// +19:42:11 into an episode that ran 45 minutes.
export const SESSION_IDLE_LIMIT_SECS = 3 * 60 * 60;

// Accumulated watch time right now, or null when there is no live session.
// `nowMs` is a millisecond epoch so callers can pass the server clock rather
// than a possibly-skewed local one.
export function sessionOffsetSecs(session, nowMs) {
    if (!session) return null;

    const idleSecs = (nowMs - Date.parse(session.last_activity_at)) / 1000;
    if (idleSecs > SESSION_IDLE_LIMIT_SECS) return null;

    // Paused sessions bank their total in elapsed_secs and contribute no
    // running segment. Clamp the segment at zero so a skewed clock cannot wind
    // the timer backwards.
    const runningSecs = session.running_since
        ? Math.max(0, (nowMs - Date.parse(session.running_since)) / 1000)
        : 0;

    return Math.round(session.elapsed_secs + runningSecs);
}
