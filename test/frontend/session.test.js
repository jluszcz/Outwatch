import { describe, it, expect } from 'vitest';
import { sessionOffsetSecs, SESSION_IDLE_LIMIT_SECS } from '../../shared/session.js';

const T0 = Date.parse('2026-07-25T21:00:00.000Z');
const at = (secs) => T0 + secs * 1000;
const iso = (secs) => new Date(at(secs)).toISOString();

describe('sessionOffsetSecs', () => {
    it('is null when there is no session', () => {
        expect(sessionOffsetSecs(null, T0)).toBeNull();
        expect(sessionOffsetSecs(undefined, T0)).toBeNull();
    });

    it('counts time since running_since for a fresh session', () => {
        const session = { elapsed_secs: 0, running_since: iso(0), last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(600))).toBe(600);
    });

    it('adds banked elapsed time to the running segment', () => {
        const session = { elapsed_secs: 1200, running_since: iso(300), last_activity_at: iso(300) };
        expect(sessionOffsetSecs(session, at(360))).toBe(1260);
    });

    it('freezes at the banked total while paused', () => {
        const session = { elapsed_secs: 1200, running_since: null, last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(60))).toBe(1200);
    });

    it('is null once three hours pass with no activity', () => {
        const session = { elapsed_secs: 600, running_since: iso(0), last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(SESSION_IDLE_LIMIT_SECS + 1))).toBeNull();
    });

    it('is still live exactly at the three hour boundary', () => {
        const session = { elapsed_secs: 600, running_since: null, last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(SESSION_IDLE_LIMIT_SECS))).toBe(600);
    });

    it('never returns a negative offset when clocks disagree', () => {
        const session = { elapsed_secs: 0, running_since: iso(30), last_activity_at: iso(30) };
        expect(sessionOffsetSecs(session, at(0))).toBe(0);
    });
});
