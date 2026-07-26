export async function api(path, options = {}) {
    const r = await fetch(path, options);
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
