import { describe, it, expect } from 'vitest';
import { seasonLabel, isFullyWatched, sortSeasons } from '../../frontend/utils.js';

// ---------------------------------------------------------------------------
// seasonLabel
// ---------------------------------------------------------------------------

describe('seasonLabel', () => {
    it('includes the subtitle when present', () => {
        expect(seasonLabel({ id: 20, subtitle: 'Heroes vs. Villains' })).toBe('Season 20: Heroes vs. Villains');
    });

    it('omits the colon when there is no subtitle', () => {
        expect(seasonLabel({ id: 41, subtitle: '' })).toBe('Season 41');
    });

    it('formats season 1', () => {
        expect(seasonLabel({ id: 1, subtitle: 'Borneo' })).toBe('Season 1: Borneo');
    });
});

// ---------------------------------------------------------------------------
// isFullyWatched
// ---------------------------------------------------------------------------

describe('isFullyWatched', () => {
    it('is true when every user has watched', () => {
        expect(isFullyWatched({ watched_by: ['a', 'b'] }, 2)).toBe(true);
    });

    it('is false when some users have not watched', () => {
        expect(isFullyWatched({ watched_by: ['a'] }, 2)).toBe(false);
    });

    it('is false when nobody has watched', () => {
        expect(isFullyWatched({ watched_by: [] }, 2)).toBe(false);
    });

    it('is false when there are no users', () => {
        expect(isFullyWatched({ watched_by: [] }, 0)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// sortSeasons
// ---------------------------------------------------------------------------

describe('sortSeasons', () => {
    const seasons = [
        { id: 3, subtitle: 'Africa', watched_by: ['a', 'b'] },   // fully watched
        { id: 1, subtitle: 'Borneo', watched_by: ['a'] },        // partial
        { id: 2, subtitle: 'Outback', watched_by: [] },          // none
        { id: 4, subtitle: 'Marquesas', watched_by: ['a', 'b'] },// fully watched
    ];

    it('does not mutate the input', () => {
        const copy = [...seasons];
        sortSeasons(seasons, 2);
        expect(seasons).toEqual(copy);
    });

    it('sinks fully-watched seasons to the bottom, keeping number order within groups', () => {
        const out = sortSeasons(seasons, 2).map(s => s.id);
        expect(out).toEqual([1, 2, 3, 4]);
    });

    it('orders purely by season number when none are fully watched', () => {
        const out = sortSeasons(seasons, 3).map(s => s.id);
        expect(out).toEqual([1, 2, 3, 4]);
    });

    it('keeps natural order when there are no users (nothing sinks)', () => {
        const out = sortSeasons(seasons, 0).map(s => s.id);
        expect(out).toEqual([1, 2, 3, 4]);
    });
});
