import { describe, it, expect } from 'vitest';
import { accentClass } from '../../frontend/post.js';

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
