// How long a request may take before it is abandoned.
//
// A request that never settles is worse than one that fails. `useSubmitGuard`
// (hooks.js) holds `busy` until the promise it is awaiting settles, and the
// compose box's submit path is gated on it — so a fetch left hanging greys the
// Post button out and silently refuses Enter, for the life of the mounted form.
// That is unrecoverable from inside the app: closing and reopening it is the
// only way back, which is exactly how it was reported. A phone is where this
// happens, since a backgrounded page can be suspended mid-request and its fetch
// never resumes.
//
// Deliberately generous. A timeout the server would have beaten is not free —
// the request may already have been delivered, so retrying the note posts it
// twice — and every route here answers in well under a second when it answers
// at all.
export const REQUEST_TIMEOUT_MS = 20_000;

// A failure with no response behind it: the fetch itself rejected. Browsers
// report both cases as a bare TypeError whose message ("Load failed" on Safari,
// "Failed to fetch" on Chrome) names nothing the reader can act on, so the two
// are separated and given words here.
function networkError(cause) {
    const timedOut = cause?.name === 'TimeoutError';
    const err = new Error(
        timedOut
            ? "Timed out — the server didn't answer. Check your connection and try again."
            : "Couldn't reach the server. Check your connection and try again.",
    );
    err.timeout = timedOut;
    err.cause = cause;
    return err;
}

// Whether this response is Access turning the request away rather than the app
// answering it. Two shapes, and no others:
//
//   - An opaque redirect. Access answers an expired session with a redirect to
//     its login page; `redirect: 'manual'` below leaves it unfollowed, which a
//     browser surfaces as `type: 'opaqueredirect'` with status 0.
//   - A 401. This API never issues one — someone off the roster gets a 403 with
//     a message saying so — so a 401 can only have come from the edge.
//
// A 403 is deliberately not here: that one is ours, and it means something the
// user cannot fix by signing in again.
function signedOut(r) {
    return r.type === 'opaqueredirect' || r.status === 0 || r.status === 401;
}

export async function api(path, options = {}) {
    // `timeoutMs` is a seam for the test, which cannot wait out the real one;
    // every caller in the app takes the default.
    const { timeoutMs = REQUEST_TIMEOUT_MS, ...init } = options;

    let r;
    try {
        r = await fetch(path, {
            ...init,
            // Following the Access redirect lands on a cross-origin login page
            // with no CORS headers, so the fetch rejects with the same untyped
            // TypeError as being offline and an expired session reads as a
            // network blip. Unfollowed, it is a shape signedOut() can name.
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        throw networkError(err);
    }

    if (signedOut(r)) {
        // Nothing in the app can recover this: every later request fails the
        // same way, and only a top-level navigation re-runs the Access
        // handshake. So the message is the instruction, naming the app as well
        // as the page — installed to a home screen, there is no reload button
        // to point at.
        const err = new Error('Signed out — reload the page, or reopen the app, to sign back in.');
        err.status = r.status;
        err.signedOut = true;
        throw err;
    }

    if (!r.ok) {
        let msg = `${options.method || 'GET'} ${path} failed: ${r.status}`;
        try {
            msg = (await r.json()).error || msg;
        } catch {}
        // Carries the HTTP status so callers can distinguish an expected,
        // already-explained failure (e.g. a 409 for a stale timer session)
        // from a real one, without matching on message text.
        const err = new Error(msg);
        err.status = r.status;
        throw err;
    }
    return r.json();
}
