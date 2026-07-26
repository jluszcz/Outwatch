export async function api(path, options = {}) {
    const r = await fetch(path, options);
    if (!r.ok) {
        let msg = `${options.method || 'GET'} ${path} failed: ${r.status}`;
        try {
            msg = (await r.json()).error || msg;
        } catch {}
        throw new Error(msg);
    }
    return r.json();
}
