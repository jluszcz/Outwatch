import { describe, it, expect } from 'vitest';
import { createRefreshGuard } from '../../frontend/refresh-guard.js';

// The bookkeeping behind useRefreshGuard: which in-flight fetch may apply its
// response, and when a refetch has to be deferred until mutations settle.
// Tested here as a plain state machine, with no DOM or Preact involved.

// ---------------------------------------------------------------------------
// startFetch / isCurrent / endFetch
// ---------------------------------------------------------------------------

describe('createRefreshGuard fetch generations', () => {
    it('starts a fetch when nothing else is in flight', () => {
        const guard = createRefreshGuard();
        expect(guard.startFetch()).not.toBeNull();
    });

    it('lets the only in-flight fetch apply its response', () => {
        const guard = createRefreshGuard();
        const token = guard.startFetch();
        expect(guard.isCurrent(token)).toBe(true);
    });

    it('discards an older fetch once a newer one starts', () => {
        const guard = createRefreshGuard();
        const first = guard.startFetch();
        guard.startFetch();
        expect(guard.isCurrent(first)).toBe(false);
    });

    it('still lets the newest of two overlapping fetches apply', () => {
        const guard = createRefreshGuard();
        guard.startFetch();
        const second = guard.startFetch();
        expect(guard.isCurrent(second)).toBe(true);
    });

    it('discards a fetch that a mutation started under it', () => {
        const guard = createRefreshGuard();
        const token = guard.startFetch();
        guard.beginMutation();
        expect(guard.isCurrent(token)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Deferral while mutations are in flight
// ---------------------------------------------------------------------------

describe('createRefreshGuard deferral', () => {
    it('refuses to start a fetch while a mutation is in flight', () => {
        const guard = createRefreshGuard();
        guard.beginMutation();
        expect(guard.startFetch()).toBeNull();
    });

    it('runs the refresh a deferred fetch asked for once the mutation settles', () => {
        const guard = createRefreshGuard();
        guard.beginMutation();
        guard.startFetch();
        expect(guard.endMutation()).toBe(true);
    });

    it('runs no refresh when a mutation settles having queued nothing', () => {
        const guard = createRefreshGuard();
        guard.beginMutation();
        expect(guard.endMutation()).toBe(false);
    });

    it('queues a refetch when a mutation invalidates an in-flight fetch', () => {
        const guard = createRefreshGuard();
        guard.startFetch();
        guard.beginMutation();
        expect(guard.endMutation()).toBe(true);
    });

    it('queues nothing when a mutation starts with no fetch in flight', () => {
        const guard = createRefreshGuard();
        guard.startFetch();
        guard.endFetch();
        guard.beginMutation();
        expect(guard.endMutation()).toBe(false);
    });

    it('starts fetches again once the last mutation settles', () => {
        const guard = createRefreshGuard();
        guard.beginMutation();
        guard.endMutation();
        expect(guard.startFetch()).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Overlapping mutations
// ---------------------------------------------------------------------------

describe('createRefreshGuard overlapping mutations', () => {
    it('holds the queued refresh until the last mutation settles', () => {
        const guard = createRefreshGuard();
        guard.beginMutation();
        guard.beginMutation();
        guard.startFetch();
        expect(guard.endMutation()).toBe(false);
    });

    it('runs the queued refresh exactly once, on the last mutation to settle', () => {
        const guard = createRefreshGuard();
        guard.beginMutation();
        guard.beginMutation();
        guard.startFetch();
        guard.endMutation();
        expect(guard.endMutation()).toBe(true);
    });

    it('defers a fetch while any mutation is still in flight', () => {
        const guard = createRefreshGuard();
        guard.beginMutation();
        guard.beginMutation();
        guard.endMutation();
        expect(guard.startFetch()).toBeNull();
    });

    it('clears the queue after running it, so the next mutation runs nothing', () => {
        const guard = createRefreshGuard();
        guard.beginMutation();
        guard.startFetch();
        guard.endMutation();
        guard.beginMutation();
        expect(guard.endMutation()).toBe(false);
    });
});
