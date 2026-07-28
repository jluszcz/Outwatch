import { describe, it, expect } from 'vitest';
import { createSubmitGuard } from '../../frontend/submit-guard.js';

describe('createSubmitGuard', () => {
    it('allows a submit with text and nothing in flight', () => {
        expect(createSubmitGuard().canSubmit('hello')).toBe(true);
    });

    it('refuses an empty or whitespace-only submit', () => {
        const guard = createSubmitGuard();
        expect(guard.canSubmit('')).toBe(false);
        expect(guard.canSubmit('   ')).toBe(false);
    });

    it('refuses a second submit while one is in flight', () => {
        const guard = createSubmitGuard();
        expect(guard.begin()).toBe(true);
        expect(guard.canSubmit('hello')).toBe(false);
        expect(guard.begin()).toBe(false);
    });

    it('allows a submit again once the first settles', () => {
        const guard = createSubmitGuard();
        guard.begin();
        guard.end();
        expect(guard.canSubmit('hello')).toBe(true);
    });

    // The Task 7 race: a request already sent cannot be recalled, so letting
    // the user abandon the form means a late success applies an edit they
    // believe they discarded, with nothing on screen to say so.
    it('refuses to cancel while a submit is in flight', () => {
        const guard = createSubmitGuard();
        expect(guard.canCancel()).toBe(true);
        guard.begin();
        expect(guard.canCancel()).toBe(false);
        guard.end();
        expect(guard.canCancel()).toBe(true);
    });
});
