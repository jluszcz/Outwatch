import { describe, it, expect } from 'vitest';
import {
    seasonLabel,
    seasonParts,
    abbreviateName,
    authorAccent,
    isFullyWatched,
    sortSeasons,
    sortBySeenCount,
    selectableSeasons,
    setWatched,
    clearsCurrentlyWatching,
    quoteSnippet,
    bodyAfterPost,
    formatAdjust,
    clampAdjust,
    settledAdjust,
    relativeTime,
    feedLine,
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
// seasonParts
// ---------------------------------------------------------------------------

describe('seasonParts', () => {
    it('splits the number from the subtitle', () => {
        expect(seasonParts({ id: 20, subtitle: 'Heroes vs. Villains' })).toEqual({
            number: 'Season 20',
            subtitle: 'Heroes vs. Villains',
        });
    });

    it('returns an empty subtitle when the season has none', () => {
        expect(seasonParts({ id: 41, subtitle: '' })).toEqual({
            number: 'Season 41',
            subtitle: '',
        });
    });

    it('returns an empty subtitle when the field is absent', () => {
        expect(seasonParts({ id: 41 })).toEqual({ number: 'Season 41', subtitle: '' });
    });
});

// ---------------------------------------------------------------------------
// abbreviateName
// ---------------------------------------------------------------------------

describe('abbreviateName', () => {
    it('collapses a shared column to initials', () => {
        expect(abbreviateName('Bob & Carol')).toBe('B & C');
    });

    it('leaves a single name alone', () => {
        expect(abbreviateName('Alice')).toBe('Alice');
    });

    it('leaves a multi-word single name alone', () => {
        expect(abbreviateName('Mary Jane')).toBe('Mary Jane');
    });

    it('handles more than two names', () => {
        expect(abbreviateName('Dave & Erin & Alice')).toBe('D & E & A');
    });

    it('tolerates missing spaces around the ampersand', () => {
        expect(abbreviateName('Bob&Carol')).toBe('B & C');
    });

    it('uppercases a lowercased name', () => {
        expect(abbreviateName('bob & carol')).toBe('B & C');
    });

    it('passes a name with a stray ampersand through untouched', () => {
        expect(abbreviateName('Alice &')).toBe('Alice &');
    });
});

// ---------------------------------------------------------------------------
// authorAccent
// ---------------------------------------------------------------------------

describe('authorAccent', () => {
    it("marks the caller's own notes", () => {
        expect(authorAccent({ mine: true, author_index: 2 })).toBe('mine');
    });

    it('keys everyone else off the slot the server assigned', () => {
        expect(authorAccent({ mine: false, author_index: 0 })).toBe(1);
        expect(authorAccent({ mine: false, author_index: 2 })).toBe(3);
    });

    it('gives each half of a shared column its own slot', () => {
        expect(authorAccent({ mine: false, author_index: 1 })).not.toBe(
            authorAccent({ mine: false, author_index: 2 }),
        );
    });

    it('wraps around once the roster outgrows the palette', () => {
        expect(authorAccent({ mine: false, author_index: 5 })).toBe(1);
    });

    it('returns null for an author the server could not place', () => {
        expect(authorAccent({ mine: false, author_index: null })).toBe(null);
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
// setWatched
// ---------------------------------------------------------------------------

describe('setWatched', () => {
    it('adds the user when marking watched', () => {
        expect(setWatched(['other'], 'me', true)).toEqual(['other', 'me']);
    });

    it('does not duplicate a user who is already present', () => {
        expect(setWatched(['me', 'other'], 'me', true)).toEqual(['other', 'me']);
    });

    it('removes the user when unmarking', () => {
        expect(setWatched(['me', 'other'], 'me', false)).toEqual(['other']);
    });

    it('is a no-op removal when the user is absent', () => {
        expect(setWatched(['other'], 'me', false)).toEqual(['other']);
    });

    it('does not mutate the input', () => {
        const watchedBy = ['me', 'other'];
        setWatched(watchedBy, 'me', false);
        expect(watchedBy).toEqual(['me', 'other']);
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

// ---------------------------------------------------------------------------
// quoteSnippet
// ---------------------------------------------------------------------------

describe('quoteSnippet', () => {
    it('leaves a short single-line body alone', () => {
        expect(quoteSnippet('short note')).toBe('short note');
    });

    it('collapses newlines and runs of whitespace to single spaces', () => {
        expect(quoteSnippet('first line\n\nsecond   line')).toBe('first line second line');
    });

    it('trims surrounding whitespace', () => {
        expect(quoteSnippet('  padded  ')).toBe('padded');
    });

    it('truncates a long body with an ellipsis', () => {
        const snippet = quoteSnippet('x'.repeat(200));
        expect(snippet).toHaveLength(61);
        expect(snippet.endsWith('…')).toBe(true);
    });

    it('does not add an ellipsis at exactly the limit', () => {
        expect(quoteSnippet('x'.repeat(60))).toBe('x'.repeat(60));
    });
});

// ---------------------------------------------------------------------------
// bodyAfterPost
// ---------------------------------------------------------------------------

describe('bodyAfterPost', () => {
    it('clears the box when it still holds what was posted', () => {
        expect(bodyAfterPost('a thought', 'a thought')).toBe('');
    });

    it('clears a note posted with surrounding whitespace', () => {
        // The regression this exists for: the body goes out trimmed, but the box
        // holds the raw text, and a phone's predictive keyboard puts a space
        // after every accepted word. Comparing the box against the trimmed text
        // never matched, so the note stayed in the box after it posted.
        expect(bodyAfterPost('a thought ', 'a thought ')).toBe('');
    });

    it('keeps text typed on top of the note while it was in flight', () => {
        expect(bodyAfterPost('a thought and more', 'a thought')).toBe('a thought and more');
    });
});

// ---------------------------------------------------------------------------
// formatAdjust
// ---------------------------------------------------------------------------

describe('formatAdjust', () => {
    it('shows no correction as a plus-minus zero', () => {
        expect(formatAdjust(0)).toBe('±0:00');
    });

    it('signs a forward correction', () => {
        expect(formatAdjust(45)).toBe('+0:45');
        expect(formatAdjust(75)).toBe('+1:15');
    });

    // U+2212, matching the −1m / −15s buttons rather than a hyphen.
    it('signs a backward correction with a real minus', () => {
        expect(formatAdjust(-45)).toBe('−0:45');
    });
});

// ---------------------------------------------------------------------------
// clampAdjust
// ---------------------------------------------------------------------------

describe('clampAdjust', () => {
    it('adds the delta to the current total', () => {
        expect(clampAdjust(0, 15, 3600)).toBe(15);
        expect(clampAdjust(15, 15, 3600)).toBe(30);
    });

    it('accumulates a run of taps against its own result, not a fixed base', () => {
        // The regression this exists for: two rapid nudges must land on 30, not
        // both compute 0 + 15 against a total that hasn't round-tripped to the
        // server yet.
        let pending = 0;
        pending = clampAdjust(pending, 15, 3600);
        pending = clampAdjust(pending, 15, 3600);
        expect(pending).toBe(30);
    });

    it('clamps at the positive limit', () => {
        expect(clampAdjust(3590, 15, 3600)).toBe(3600);
    });

    it('clamps at the negative limit', () => {
        expect(clampAdjust(-3590, -15, 3600)).toBe(-3600);
    });

    it('is a no-op once already at the limit', () => {
        expect(clampAdjust(3600, 15, 3600)).toBe(3600);
    });
});

// ---------------------------------------------------------------------------
// settledAdjust
// ---------------------------------------------------------------------------

describe('settledAdjust', () => {
    it('keeps the optimistic value once the newest request succeeds', () => {
        expect(settledAdjust(true, true, 30, 0)).toBe(30);
    });

    it('reverts to the last known-good value when the newest request fails', () => {
        // The regression this exists for: a failed PUT leaves the server's
        // adjust_secs unchanged, so nothing else notices and undoes the
        // optimistic update — this is the decision that does.
        expect(settledAdjust(true, false, 30, 0)).toBe(0);
    });

    it('ignores a stale failure once a newer request has already settled', () => {
        // The regression this one exists for: two overlapping taps resolve out
        // of order, and an older failure landing after a newer success must not
        // stomp the confirmed result back down.
        expect(settledAdjust(false, false, 30, 0)).toBeUndefined();
    });

    it('ignores a stale success once a newer request has already settled', () => {
        expect(settledAdjust(false, true, 30, 0)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z');
    const ago = (secs) => new Date(now - secs * 1000).toISOString();

    it('calls the present moment just now', () => {
        expect(relativeTime(ago(0), now)).toBe('just now');
    });

    it('still says just now at five minutes exactly', () => {
        expect(relativeTime(ago(300), now)).toBe('just now');
    });

    it('starts counting minutes just past five', () => {
        expect(relativeTime(ago(301), now)).toBe('5 minutes ago');
    });

    it('counts minutes up to the hour', () => {
        expect(relativeTime(ago(59 * 60), now)).toBe('59 minutes ago');
    });

    it('switches to hours at sixty minutes', () => {
        expect(relativeTime(ago(60 * 60), now)).toBe('1 hour ago');
    });

    it('truncates towards zero rather than rounding', () => {
        expect(relativeTime(ago(119 * 60), now)).toBe('1 hour ago');
    });

    it('pluralises hours', () => {
        expect(relativeTime(ago(3 * 60 * 60), now)).toBe('3 hours ago');
    });

    it('counts hours up to the day', () => {
        expect(relativeTime(ago(23 * 60 * 60 + 59 * 60), now)).toBe('23 hours ago');
    });

    it('switches to days at twenty-four hours', () => {
        expect(relativeTime(ago(24 * 60 * 60), now)).toBe('1 day ago');
    });

    it('pluralises days', () => {
        expect(relativeTime(ago(3 * 24 * 60 * 60), now)).toBe('3 days ago');
    });

    // A device clock running fast would otherwise produce "in 3 hours".
    it('clamps a future stamp to just now', () => {
        expect(relativeTime(new Date(now + 60 * 60 * 1000).toISOString(), now)).toBe('just now');
    });
});

// ---------------------------------------------------------------------------
// feedLine
// ---------------------------------------------------------------------------

describe('feedLine', () => {
    it('names the person, the season, and the episode', () => {
        expect(feedLine({ author_name: 'Alice', season_id: 45, episode: 3 })).toBe(
            'Alice commented on Season 45 Episode 3',
        );
    });

    // No count, however many notes the group holds: two and five both mean go
    // read the episode.
    it('says the same thing however many notes are behind it', () => {
        const one = feedLine({ author_name: 'Bob', season_id: 46, episode: 1 });
        expect(one).toBe('Bob commented on Season 46 Episode 1');
    });
});
