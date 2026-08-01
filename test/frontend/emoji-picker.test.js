import { describe, it, expect } from 'vitest';
import { searchEmoji, emojiName } from '../../frontend/emoji-picker.js';
import { isReactionEmoji, REACTIONS, MAX_REACTIONS_PER_POST } from '../../shared/reactions.js';

// Logic only, no DOM — the picker component itself is verified the way the rest
// of the layout is, with an ad-hoc Playwright script rather than in CI.

describe('searchEmoji', () => {
    it('returns null for an empty or whitespace query, meaning "browse the groups"', () => {
        expect(searchEmoji('')).toBeNull();
        expect(searchEmoji('   ')).toBeNull();
    });

    it('matches on a substring of the name', () => {
        const found = searchEmoji('grinning').map(([emoji]) => emoji);
        expect(found).toContain('😀');
    });

    it('is case-insensitive', () => {
        expect(searchEmoji('SNAKE')).toEqual(searchEmoji('snake'));
        expect(searchEmoji('SNAKE').map(([e]) => e)).toContain('🐍');
    });

    it('requires every term but not their order', () => {
        const forward = searchEmoji('grinning face').map(([e]) => e);
        const reversed = searchEmoji('face grinning').map(([e]) => e);
        expect(forward).toEqual(reversed);
        expect(forward).toContain('😀');
        // "grinning" alone is a strictly looser query than "grinning face".
        expect(searchEmoji('grinning').length).toBeGreaterThanOrEqual(forward.length);
    });

    it('returns an empty array, not null, when nothing matches', () => {
        expect(searchEmoji('zzzznotanemoji')).toEqual([]);
    });
});

describe('emojiName', () => {
    it('names a known emoji', () => {
        expect(emojiName('🐍')).toBe('snake');
    });

    it('falls back to the character for an emoji the bundled data does not know', () => {
        // Stands in for a reaction stored before this data was generated, or one
        // from a newer Unicode version than the committed set.
        expect(emojiName('🧑‍🚀🧑‍🚀')).toBe('🧑‍🚀🧑‍🚀');
    });

    it('names every emoji in the quick row, since those label the menu buttons', () => {
        for (const { emoji } of REACTIONS) {
            expect(emojiName(emoji)).not.toBe(emoji);
        }
    });
});

// The picker must never offer a button the server would reject — the reason the
// rule lives in shared/ at all. The module now holds this by construction, by
// filtering emoji-data.json on load; this is the guard that the filter is
// actually applied, since the committed file genuinely does contain emoji this
// engine's `\p{RGI_Emoji}` refuses.
describe('the offered set against the server rule', () => {
    it('offers no emoji the server would reject', () => {
        // Every name in the set contains one of these two letters, so the union
        // is the whole searchable set without exporting it just for a test.
        const all = searchEmoji('e').concat(searchEmoji('a'));
        expect(all.length).toBeGreaterThan(1000);
        const rejected = all.filter(([emoji]) => !isReactionEmoji(emoji));
        expect(rejected).toEqual([]);
    });

    it('accepts the quick row', () => {
        for (const { emoji } of REACTIONS) {
            expect(isReactionEmoji(emoji)).toBe(true);
        }
    });
});

describe('isReactionEmoji', () => {
    it('accepts a single emoji, including multi-codepoint sequences', () => {
        for (const emoji of ['👍', '❤️', '👨‍👩‍👧‍👦', '🏳️‍🌈', '👍🏽']) {
            expect(isReactionEmoji(emoji)).toBe(true);
        }
    });

    it('rejects anything that is not exactly one emoji', () => {
        // '❤' is U+2764 with no variation selector, so it is not RGI — which is
        // what keeps '❤' and '❤️' from becoming two spellings of one reaction.
        for (const value of ['', ' ', 'x', 'a👍', '👍👍', '👍 ', '❤', '‍']) {
            expect(isReactionEmoji(value)).toBe(false);
        }
    });

    it('rejects non-strings rather than throwing', () => {
        for (const value of [null, undefined, 1, true, {}, ['👍']]) {
            expect(isReactionEmoji(value)).toBe(false);
        }
    });
});

describe('MAX_REACTIONS_PER_POST', () => {
    it('is a positive integer the server and the client agree on', () => {
        expect(Number.isInteger(MAX_REACTIONS_PER_POST)).toBe(true);
        expect(MAX_REACTIONS_PER_POST).toBeGreaterThan(REACTIONS.length);
    });
});
