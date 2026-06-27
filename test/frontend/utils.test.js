import { describe, it, expect } from 'vitest';
import {
    seasonLabel,
    isFullyWatched,
    sortSeasons,
    sortBySeenCount,
    selectableSeasons,
    clearsCurrentlyWatching,
} from '../../frontend/utils.js';

// ---------------------------------------------------------------------------
// seasonLabel
// ---------------------------------------------------------------------------

describe('seasonLabel', () => {
    it('includes the subtitle when present', () => {
        expect(seasonLabel({ id: 20, subtitle: 'Heroes vs. Villains' })).toBe(
            'Season 20: Heroes vs. Villains',
        );
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
        { id: 3, subtitle: 'Africa', watched_by: ['a', 'b'] }, // fully watched
        { id: 1, subtitle: 'Borneo', watched_by: ['a'] }, // partial
        { id: 2, subtitle: 'Outback', watched_by: [] }, // none
        { id: 4, subtitle: 'Marquesas', watched_by: ['a', 'b'] }, // fully watched
    ];

    it('does not mutate the input', () => {
        const copy = [...seasons];
        sortSeasons(seasons, 2);
        expect(seasons).toEqual(copy);
    });

    it('sinks fully-watched seasons to the bottom, keeping number order within groups', () => {
        const out = sortSeasons(seasons, 2).map((s) => s.id);
        expect(out).toEqual([1, 2, 3, 4]);
    });

    it('orders purely by season number when none are fully watched', () => {
        const out = sortSeasons(seasons, 3).map((s) => s.id);
        expect(out).toEqual([1, 2, 3, 4]);
    });

    it('keeps natural order when there are no users (nothing sinks)', () => {
        const out = sortSeasons(seasons, 0).map((s) => s.id);
        expect(out).toEqual([1, 2, 3, 4]);
    });
});

// ---------------------------------------------------------------------------
// sortBySeenCount
// ---------------------------------------------------------------------------

describe('sortBySeenCount', () => {
    const seasons = [
        { id: 3, subtitle: 'Africa', watched_by: ['a', 'b'] }, // fully watched (2/2)
        { id: 1, subtitle: 'Borneo', watched_by: ['a'] }, // partial
        { id: 2, subtitle: 'Outback', watched_by: [] }, // none
        { id: 4, subtitle: 'Marquesas', watched_by: ['a', 'b'] }, // fully watched (2/2)
    ];

    it('does not mutate the input', () => {
        const copy = [...seasons];
        sortBySeenCount(seasons, 2);
        expect(seasons).toEqual(copy);
    });

    it('sinks fully-watched seasons to the bottom, then sorts by watcher count ascending', () => {
        const out = sortBySeenCount(seasons, 2).map((s) => s.id);
        expect(out).toEqual([2, 1, 3, 4]);
    });

    it('seasons with equal watcher counts are ordered by season number', () => {
        const tied = [
            { id: 5, watched_by: ['a'] },
            { id: 2, watched_by: ['a'] },
            { id: 8, watched_by: [] },
        ];
        const out = sortBySeenCount(tied, 2).map((s) => s.id);
        expect(out).toEqual([8, 2, 5]);
    });

    it('keeps natural order when there are no users (nothing sinks)', () => {
        const out = sortBySeenCount(seasons, 0).map((s) => s.id);
        expect(out).toEqual([2, 1, 3, 4]);
    });
});

// ---------------------------------------------------------------------------
// selectableSeasons
// ---------------------------------------------------------------------------

describe('selectableSeasons', () => {
    const seasons = [
        { id: 1, watched_by: ['me'] }, // watched by me
        { id: 2, watched_by: ['other'] }, // watched by someone else
        { id: 3, watched_by: [] }, // unwatched
        { id: 4, watched_by: ['me', 'other'] }, // watched by me (and others)
    ];

    it('excludes seasons the user has already watched', () => {
        const out = selectableSeasons(seasons, 'me').map((s) => s.id);
        expect(out).toEqual([2, 3]);
    });

    it('returns every season when the user has watched none', () => {
        const out = selectableSeasons(seasons, 'nobody').map((s) => s.id);
        expect(out).toEqual([1, 2, 3, 4]);
    });

    it('does not mutate the input', () => {
        const copy = [...seasons];
        selectableSeasons(seasons, 'me');
        expect(seasons).toEqual(copy);
    });
});

// ---------------------------------------------------------------------------
// clearsCurrentlyWatching
// ---------------------------------------------------------------------------

describe('clearsCurrentlyWatching', () => {
    const me = { id: 'me', currently_watching_season_id: 7 };

    it('is true when checking the season you are currently watching', () => {
        expect(clearsCurrentlyWatching(me, 7, true)).toBe(true);
    });

    it('is false when unchecking that same season', () => {
        expect(clearsCurrentlyWatching(me, 7, false)).toBe(false);
    });

    it('is false when checking a different season', () => {
        expect(clearsCurrentlyWatching(me, 3, true)).toBe(false);
    });

    it('is false when you have no currently-watching season', () => {
        expect(
            clearsCurrentlyWatching({ id: 'me', currently_watching_season_id: null }, 7, true),
        ).toBe(false);
    });

    it('is false when the user is missing', () => {
        expect(clearsCurrentlyWatching(undefined, 7, true)).toBe(false);
    });
});
