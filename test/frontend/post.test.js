import { describe, it, expect } from 'vitest';
import { accentClass, postTimeText, postTimeTitle } from '../../frontend/post.js';

// accentClass wraps authorAccent (fully covered in utils.test.js) into the CSS
// class string a note or quote block actually applies. These three cases pin
// the string mapping itself, not authorAccent's slot-assignment rules.
describe('accentClass', () => {
    it("marks the caller's own notes with post-mine", () => {
        expect(accentClass({ mine: true, author_index: 2 })).toBe(' post-mine');
    });

    it('maps a numeric author_index to a post-aN class', () => {
        expect(accentClass({ mine: false, author_index: 0 })).toBe(' post-a1');
    });

    it('leaves an unplaceable author unstriped rather than inventing a colour', () => {
        expect(accentClass({ mine: false, author_index: null })).toBe('');
    });
});

const entry = (over = {}) => ({
    post: { id: 1, created_at: '2026-07-20T21:10:00.000Z' },
    offset: 600,
    inferred: false,
    tail: false,
    clamped: false,
    ...over,
});

describe('postTimeText', () => {
    it('shows a timed note as its offset', () => {
        expect(postTimeText(entry())).toBe('10m');
    });

    it('marks an inferred offset with a tilde', () => {
        expect(postTimeText(entry({ inferred: true }))).toBe('~10m');
    });

    it('shows a tail note as its calendar date', () => {
        expect(postTimeText(entry({ tail: true, offset: null }))).toBe(
            new Date('2026-07-20T21:10:00.000Z').toLocaleDateString(),
        );
    });

    // A clamped reply was pulled below its parent, so its own stamp now reads
    // lower than the note above it. A marker beats a number that reads
    // backwards — and beats a blank, which left a phone with nothing at all,
    // since the suppressed stamp lives in the hover-only title.
    it('marks a reply that was pulled below its parent', () => {
        expect(postTimeText(entry({ clamped: true }))).toBe('↳');
    });

    // The clamp applies in the tail too (a timed reply follows a stranded
    // untimed parent down), and the marker replaces the date there as well
    // rather than falling through to it.
    it('marks a clamped tail note the same way', () => {
        expect(postTimeText(entry({ clamped: true, tail: true, offset: null }))).toBe('↳');
    });
});

describe('postTimeTitle', () => {
    it('is the wall-clock time for an ordinary note', () => {
        expect(postTimeTitle(entry())).toBe(new Date('2026-07-20T21:10:00.000Z').toLocaleString());
    });

    // The chip shows only a marker, so the stamp it would have shown moves into
    // the title rather than being lost.
    it('adds the suppressed stamp for a clamped reply', () => {
        expect(postTimeTitle(entry({ clamped: true }))).toContain('stamped 10m');
    });

    // An inferred offset was synthesized by orderPosts for an author who never
    // ran a timer, so "stamped" would assert a timer reading that never
    // existed — the same fabrication the chip's `~` prefix exists to avoid.
    it('does not call an inferred offset a stamp', () => {
        const title = postTimeTitle(entry({ clamped: true, inferred: true }));
        expect(title).toContain('estimated 10m');
        expect(title).not.toContain('stamped');
    });

    // Reachable: a reply in the tail (no timer, so offset is null) clamped to
    // a later tail parent. There is no offset to append, so the title falls
    // back to the bare wall-clock time rather than a title with nothing after it.
    it('is the bare wall-clock time for a clamped reply with no offset', () => {
        expect(postTimeTitle(entry({ clamped: true, offset: null }))).toBe(
            new Date('2026-07-20T21:10:00.000Z').toLocaleString(),
        );
    });
});
