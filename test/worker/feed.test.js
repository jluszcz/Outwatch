import { describe, it, expect } from 'vitest';
import { groupNotes, FEED_GROUP_GAP_MS } from '../../src/feed.js';

// A row as the feed query returns it. author_key is what the SQL computes:
// the lowercased email for an attributed note, 'user:<id>' for one written
// before authorship was recorded.
function row(overrides = {}) {
    return {
        author_key: 'alice@example.com',
        author_email: 'alice@example.com',
        user_id: 'user-alice',
        season_id: 45,
        episode: 3,
        created_at: '2026-08-02T00:00:00.000Z',
        ...overrides,
    };
}

// Named offsetAt rather than `at` so it does not shadow the `at` parameter the
// route tests below destructure.
const offsetAt = (ms) => new Date(Date.parse('2026-08-02T00:00:00.000Z') + ms).toISOString();

describe('groupNotes', () => {
    it('returns nothing for no rows', () => {
        expect(groupNotes([])).toEqual([]);
    });

    it('folds one sitting on one episode into a single group', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(10 * 60 * 1000) }),
            row({ created_at: offsetAt(40 * 60 * 1000) }),
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].season_id).toBe(45);
        expect(groups[0].episode).toBe(3);
    });

    it('stamps a group with its newest note', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(40 * 60 * 1000) }),
        ]);
        expect(groups[0].at).toBe(offsetAt(40 * 60 * 1000));
    });

    it('splits when consecutive notes are further apart than the gap', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(FEED_GROUP_GAP_MS + 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('keeps a note exactly on the gap in the same group', () => {
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(FEED_GROUP_GAP_MS) }),
        ]);
        expect(groups).toHaveLength(1);
    });

    // The reason the gap rule replaced a calendar-day rule: created_at is UTC,
    // and UTC midnight is 8pm Eastern, so an evening session straddles it.
    it('does not split an evening session that crosses UTC midnight', () => {
        const groups = groupNotes([
            row({ created_at: '2026-08-02T23:40:00.000Z' }),
            row({ created_at: '2026-08-03T00:20:00.000Z' }),
        ]);
        expect(groups).toHaveLength(1);
    });

    it('measures the gap from the previous note, not the group start', () => {
        const hour = 60 * 60 * 1000;
        const groups = groupNotes([
            row({ created_at: offsetAt(0) }),
            row({ created_at: offsetAt(5 * hour) }),
            row({ created_at: offsetAt(10 * hour) }),
        ]);
        expect(groups).toHaveLength(1);
    });

    it('does not group two people together', () => {
        const groups = groupNotes([
            row({ author_key: 'alice@example.com', created_at: offsetAt(0) }),
            row({
                author_key: 'bob@example.com',
                author_email: 'bob@example.com',
                user_id: 'user-bob',
                created_at: offsetAt(60 * 1000),
            }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('does not group two episodes together', () => {
        const groups = groupNotes([
            row({ episode: 3, created_at: offsetAt(0) }),
            row({ episode: 4, created_at: offsetAt(60 * 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('does not group two seasons together', () => {
        const groups = groupNotes([
            row({ season_id: 45, created_at: offsetAt(0) }),
            row({ season_id: 46, created_at: offsetAt(60 * 1000) }),
        ]);
        expect(groups).toHaveLength(2);
    });

    it('carries the fields the byline is resolved from', () => {
        const groups = groupNotes([row()]);
        expect(groups[0].author_email).toBe('alice@example.com');
        expect(groups[0].user_id).toBe('user-alice');
    });

    it('never carries a note body', () => {
        const groups = groupNotes([{ ...row(), body: 'no way he played that idol' }]);
        expect(JSON.stringify(groups)).not.toContain('idol');
    });
});
