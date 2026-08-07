import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, REQUEST_TIMEOUT_MS } from '../../frontend/api.js';

afterEach(() => vi.unstubAllGlobals());

// Enough of a Response for api() to read: it touches .type, .ok, .status and
// .json() and nothing else.
const response = (over = {}) => ({
    type: 'basic',
    ok: true,
    status: 200,
    json: async () => ({}),
    ...over,
});

const stubFetch = (impl) => {
    const spy = vi.fn(impl);
    vi.stubGlobal('fetch', spy);
    return spy;
};

describe('api', () => {
    it('returns the parsed body of a successful response', async () => {
        stubFetch(async () => response({ json: async () => ({ me: { id: 'user-1' } }) }));
        expect(await api('/api/board')).toEqual({ me: { id: 'user-1' } });
    });

    it("carries the server's message and status on a failure", async () => {
        stubFetch(async () =>
            response({ ok: false, status: 409, json: async () => ({ error: 'Already watched' }) }),
        );
        await expect(api('/api/watched', { method: 'POST' })).rejects.toMatchObject({
            message: 'Already watched',
            status: 409,
        });
    });

    // The bug this whole change exists for: useSubmitGuard holds `busy` until
    // the promise it awaits settles, so a request that never answers greys the
    // Post button out until the app is closed and reopened. Every request must
    // settle on its own.
    it('abandons a request that never answers rather than hanging forever', async () => {
        stubFetch(
            (path, init) =>
                new Promise((_, reject) => {
                    init.signal.addEventListener('abort', () => reject(init.signal.reason));
                }),
        );
        await expect(api('/api/board', { timeoutMs: 20 })).rejects.toMatchObject({
            timeout: true,
        });
    });

    it('gives every request a timeout by default', async () => {
        const spy = stubFetch(async () => response());
        await api('/api/board');
        expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
        expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    });

    // Access answers an expired session with a redirect to its login page.
    // Unfollowed (redirect: 'manual'), a browser surfaces that as an opaque
    // redirect — the one shape that says "signed out" rather than "offline".
    it('leaves an Access redirect unfollowed so it can be recognised', async () => {
        const spy = stubFetch(async () => response());
        await api('/api/board');
        expect(spy.mock.calls[0][1].redirect).toBe('manual');
    });

    it('reads an opaque redirect as a signed-out session', async () => {
        stubFetch(async () => response({ type: 'opaqueredirect', ok: false, status: 0 }));
        await expect(api('/api/board')).rejects.toMatchObject({ signedOut: true });
    });

    // This API never issues a 401 — every route answers 403 for someone off the
    // roster — so a 401 can only have come from the edge.
    it('reads a 401 as a signed-out session', async () => {
        stubFetch(async () => response({ ok: false, status: 401, json: async () => ({}) }));
        await expect(api('/api/board')).rejects.toMatchObject({ signedOut: true });
    });

    it("does not read our own 403 as signed out, since that one is the roster's", async () => {
        stubFetch(async () =>
            response({
                ok: false,
                status: 403,
                json: async () => ({ error: 'Your account is not on the watch list' }),
            }),
        );
        const err = await api('/api/board').catch((e) => e);
        expect(err.message).toBe('Your account is not on the watch list');
        expect(err.status).toBe(403);
        expect(err.signedOut).toBeUndefined();
    });

    // A browser reports an unreachable server as a bare TypeError whose message
    // ("Load failed" on Safari) tells the reader nothing they can act on.
    it('names an unreachable server instead of passing on the browser wording', async () => {
        stubFetch(async () => {
            throw new TypeError('Load failed');
        });
        await expect(api('/api/board')).rejects.toMatchObject({
            message: expect.stringContaining('reach the server'),
            timeout: false,
        });
    });
});
