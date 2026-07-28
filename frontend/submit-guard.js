// The submit-once rules shared by the compose box and the edit box, as a plain
// factory so they can be driven directly by a test — the same shape, and for
// the same reason, as createRefreshGuard in refresh-guard.js. Both rules were
// learned from bugs:
//
//   - A submit may not start while one is in flight. Enter can be pressed
//     twice before the first request answers, and a double-posted note is
//     worse than a dropped keystroke.
//   - A form may not be abandoned while a submit is in flight. The request is
//     already gone; letting the user cancel it means a late success applies an
//     edit they believe they discarded, with nothing on screen to say so.
//
// The guard is the authority on `busy`; useSubmitGuard mirrors it into
// component state only so a spinner can render, exactly as useRefreshGuard
// holds its guard in a ref while the component holds the data.
export function createSubmitGuard() {
    let busy = false;

    return {
        // Trimmed, because the trimmed text is what actually gets sent — a box
        // holding only spaces has nothing to submit.
        canSubmit: (text) => !busy && text.trim().length > 0,
        canCancel: () => !busy,
        begin() {
            if (busy) return false;
            busy = true;
            return true;
        },
        end() {
            busy = false;
        },
    };
}
