import { describe, it, expect } from 'vitest';
import {
    sessionOffsetSecs,
    SESSION_IDLE_LIMIT_SECS,
    MAX_OFFSET_ADJUST_SECS,
} from '../../shared/session.js';

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

    it('adds a correction to the running total', () => {
        const session = { elapsed_secs: 600, running_since: null, last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(60), 45)).toBe(645);
        expect(sessionOffsetSecs(session, at(60), -45)).toBe(555);
    });

    it('defaults the correction to zero when omitted', () => {
        const session = { elapsed_secs: 600, running_since: null, last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(60))).toBe(600);
    });

    // A correction is a statement about the episode's zero point, not about when
    // the app was last touched, so it cannot revive a session that has gone stale.
    it('is still null for a stale session however large the correction', () => {
        const session = { elapsed_secs: 600, running_since: null, last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(SESSION_IDLE_LIMIT_SECS + 1), 3600)).toBeNull();
    });

    // A correction backwards can push an early note below zero. That is left to
    // sort truthfully; formatOffset and formatOffsetShort clamp the display.
    it('allows a correction to push the total negative', () => {
        const session = { elapsed_secs: 10, running_since: null, last_activity_at: iso(0) };
        expect(sessionOffsetSecs(session, at(0), -60)).toBe(-50);
    });
});

describe('MAX_OFFSET_ADJUST_SECS', () => {
    // Shared so the client clamp and the server's 400 cannot disagree.
    it('is an hour, far past any plausible zero-point error', () => {
        expect(MAX_OFFSET_ADJUST_SECS).toBe(3600);
    });
});
