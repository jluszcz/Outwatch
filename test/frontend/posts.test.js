import { describe, it, expect } from 'vitest';
import {
    orderPosts,
    formatOffset,
    formatOffsetShort,
    episodeNumbers,
} from '../../frontend/utils.js';

const timed = (id, user_id, offset_secs, created_at) => ({
    id,
    user_id,
    body: `note ${id}`,
    created_at,
    offset_secs,
});
const untimed = (id, user_id, created_at) => timed(id, user_id, null, created_at);
const replying = (id, user_id, offset_secs, created_at, parentId) => ({
    ...timed(id, user_id, offset_secs, created_at),
    reply_to: { id: parentId, author_name: 'Someone', author_index: 0, mine: false, body: 'x' },
});
const names = (placed) => placed.map((p) => `${p.post.user_id}@${p.offset}`);

describe('orderPosts', () => {
    it('interleaves two timed viewers by their own offsets', () => {
        // The spec's worked example: Alice watches at 9pm and posts at +10, +30,
        // +45, +50; Bob watches days later and posts at +5, +11, +35.
        const posts = [
            timed(1, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            timed(2, 'alice', 1800, '2026-07-20T21:30:00.000Z'),
            timed(3, 'alice', 2700, '2026-07-20T21:45:00.000Z'),
            timed(4, 'alice', 3000, '2026-07-20T21:50:00.000Z'),
            timed(5, 'bob', 300, '2026-07-23T06:05:00.000Z'),
            timed(6, 'bob', 660, '2026-07-23T06:11:00.000Z'),
            timed(7, 'bob', 2100, '2026-07-23T06:35:00.000Z'),
        ];
        expect(names(orderPosts(posts))).toEqual([
            'bob@300',
            'alice@600',
            'bob@660',
            'alice@1800',
            'bob@2100',
            'alice@2700',
            'alice@3000',
        ]);
    });

    it('infers a zero from an untimed author’s earliest note', () => {
        const posts = [
            timed(1, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            untimed(2, 'carol', '2026-07-22T20:00:00.000Z'),
            untimed(3, 'carol', '2026-07-22T20:13:00.000Z'),
        ];
        const placed = orderPosts(posts);
        expect(names(placed)).toEqual(['carol@0', 'alice@600', 'carol@780']);
        expect(placed[0].inferred).toBe(true);
        expect(placed[1].inferred).toBe(false);
    });

    it('drops an untimed straggler from a timed author to the tail', () => {
        // Alice ran a timer, then came back two days later. Inventing an offset
        // of +51:10:00 for that note would be a lie dressed as data.
        const posts = [
            timed(1, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            untimed(2, 'alice', '2026-07-22T21:10:00.000Z'),
            timed(3, 'bob', 300, '2026-07-23T06:05:00.000Z'),
        ];
        const placed = orderPosts(posts);
        expect(names(placed)).toEqual(['bob@300', 'alice@600', 'alice@null']);
        expect(placed[2].tail).toBe(true);
        expect(placed[2].offset).toBeNull();
    });

    it('breaks ties on equal offsets by post time', () => {
        const posts = [
            timed(1, 'bob', 600, '2026-07-23T06:10:00.000Z'),
            timed(2, 'alice', 600, '2026-07-20T21:10:00.000Z'),
        ];
        expect(orderPosts(posts).map((p) => p.post.id)).toEqual([2, 1]);
    });

    it('orders several tail notes among themselves by post time', () => {
        const posts = [
            timed(1, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            untimed(2, 'alice', '2026-07-24T10:00:00.000Z'),
            untimed(3, 'alice', '2026-07-23T10:00:00.000Z'),
        ];
        expect(orderPosts(posts).map((p) => p.post.id)).toEqual([1, 3, 2]);
    });

    it('handles an empty board and does not mutate its input', () => {
        expect(orderPosts([])).toEqual([]);
        const posts = [
            timed(2, 'alice', 600, '2026-07-20T21:10:00.000Z'),
            timed(1, 'bob', 300, '2026-07-23T06:05:00.000Z'),
        ];
        const snapshot = posts.map((p) => p.id);
        orderPosts(posts);
        expect(posts.map((p) => p.id)).toEqual(snapshot);
    });

    // A reply is an ordinary note on the timeline: it sorts by its own offset, not
    // next to the note it answers. This pins the not-threaded decision.
    it('orders a reply by its own offset, not beside its parent', () => {
        const posts = [
            { id: 1, user_id: 'u1', offset_secs: 10, created_at: '2026-01-01T00:00:00Z' },
            {
                id: 2,
                user_id: 'u2',
                offset_secs: 900,
                created_at: '2026-01-01T00:20:00Z',
                reply_to_post_id: 1,
            },
            { id: 3, user_id: 'u1', offset_secs: 60, created_at: '2026-01-01T00:05:00Z' },
        ];
        expect(orderPosts(posts).map((p) => p.post.id)).toEqual([1, 3, 2]);
    });

    // Two people whose timers disagree can stamp a reply earlier than the note it
    // answers, which put the quote block above the note it quotes.
    it('pulls a reply down to sit directly after an earlier-stamped parent', () => {
        const posts = [
            timed(1, 'alice', 900, '2026-07-20T21:15:00.000Z'),
            replying(2, 'bob', 300, '2026-07-23T06:05:00.000Z', 1),
            timed(3, 'alice', 1200, '2026-07-20T21:20:00.000Z'),
        ];
        const placed = orderPosts(posts);
        expect(placed.map((p) => p.post.id)).toEqual([1, 2, 3]);
        expect(placed[1].clamped).toBe(true);
    });

    it('resolves a chain of replies, each stamped before the last', () => {
        const posts = [
            timed(1, 'alice', 900, '2026-07-20T21:15:00.000Z'),
            replying(2, 'bob', 600, '2026-07-23T06:10:00.000Z', 1),
            replying(3, 'carol', 300, '2026-07-24T06:05:00.000Z', 2),
        ];
        expect(orderPosts(posts).map((p) => p.post.id)).toEqual([1, 2, 3]);
    });

    // Nothing to do with drift: a stray untimed note from a timed author sits in
    // the tail, and a timed reply to it must follow it down there.
    it('follows a tail parent into the tail', () => {
        const posts = [
            timed(1, 'alice', 900, '2026-07-20T21:15:00.000Z'),
            untimed(2, 'alice', '2026-07-22T21:10:00.000Z'),
            replying(3, 'bob', 300, '2026-07-23T06:05:00.000Z', 2),
        ];
        const placed = orderPosts(posts);
        expect(placed.map((p) => p.post.id)).toEqual([1, 2, 3]);
        expect(placed[2].clamped).toBe(true);
    });

    it('leaves a reply that already follows its parent unclamped', () => {
        const posts = [
            timed(1, 'alice', 300, '2026-07-20T21:05:00.000Z'),
            replying(2, 'bob', 900, '2026-07-23T06:15:00.000Z', 1),
        ];
        const placed = orderPosts(posts);
        expect(placed.map((p) => p.post.id)).toEqual([1, 2]);
        expect(placed[1].clamped).toBe(false);
    });

    // A locked parent is not rendered at all, so there is no ordering to violate;
    // a deleted one leaves reply_to null. Both leave the reply where it fell.
    it('leaves a reply alone when the parent is not in the list', () => {
        const locked = {
            ...timed(2, 'bob', 300, '2026-07-23T06:05:00.000Z'),
            reply_to: { id: 99, locked: true },
        };
        const posts = [timed(1, 'alice', 900, '2026-07-20T21:15:00.000Z'), locked];
        const placed = orderPosts(posts);
        expect(placed.map((p) => p.post.id)).toEqual([2, 1]);
        expect(placed[0].clamped).toBe(false);
    });
});

describe('formatOffset', () => {
    it('formats sub-hour offsets without an hour part', () => {
        expect(formatOffset(0)).toBe('+0:00');
        expect(formatOffset(300)).toBe('+5:00');
        expect(formatOffset(65)).toBe('+1:05');
    });

    it('pads minutes once an hour part appears', () => {
        expect(formatOffset(3900)).toBe('+1:05:00');
        expect(formatOffset(3600)).toBe('+1:00:00');
    });

    it('never renders a negative offset', () => {
        expect(formatOffset(-30)).toBe('+0:00');
    });
});

describe('formatOffsetShort', () => {
    it('uses seconds below a minute', () => {
        expect(formatOffsetShort(0)).toBe('0s');
        expect(formatOffsetShort(45)).toBe('45s');
    });

    it('truncates to whole minutes rather than rounding up', () => {
        expect(formatOffsetShort(60)).toBe('1m');
        expect(formatOffsetShort(242)).toBe('4m'); // 4:02
        expect(formatOffsetShort(3599)).toBe('59m');
    });

    it('truncates to whole hours rather than rounding up', () => {
        expect(formatOffsetShort(3600)).toBe('1h');
        expect(formatOffsetShort(18569)).toBe('5h'); // 5:09:29
    });

    it('never renders a negative offset', () => {
        expect(formatOffsetShort(-30)).toBe('0s');
    });
});

describe('episodeNumbers', () => {
    it('counts from one', () => {
        expect(episodeNumbers(3)).toEqual([1, 2, 3]);
    });

    it('is empty for a season with no episode count', () => {
        expect(episodeNumbers(0)).toEqual([]);
    });
});
