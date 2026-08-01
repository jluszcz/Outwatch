// Reactions are open: any emoji can be used. What the Worker and the browser
// bundle share is not a list of the permitted ones but the rule for what counts
// as an emoji at all, so the two cannot disagree about whether a reaction the
// picker offers is one the server will take.
//
// `REACTIONS` is now only the quick row at the top of a note's ⋯ menu — the
// four worth reaching without opening the full picker. Its order is that row's
// order. It is no longer an allow-list, and a note's chips are no longer
// ordered by it (the server orders them by when each emoji first appeared on
// that note; see `reactionsOf` in src/index.js).
export const REACTIONS = [
    { emoji: '👍', label: 'Thumbs up' },
    { emoji: '👎', label: 'Thumbs down' },
    { emoji: '🤣', label: 'Laughing' },
    { emoji: '😮', label: 'Shocked' },
];

// At most this many distinct emoji on one note. Nothing stops five people from
// hanging forty different chips off a single note otherwise, and the reaction
// bar has no room for that. The cap is on distinct emoji, not on reactions:
// toggling one already present is always allowed (see `PUT .../reactions`).
export const MAX_REACTIONS_PER_POST = 12;

// Exactly one emoji, nothing else. `\p{RGI_Emoji}` is the Unicode-defined set
// of "recommended for general interchange" sequences, so this accepts what a
// keyboard or picker actually produces — single codepoints, ZWJ sequences like
// 👨‍👩‍👧‍👦, flags, and skin-tone variants — while rejecting text, whitespace,
// the empty string, and two emoji in a row.
//
// It also settles the normalization question the old exact-match allow-list had
// to warn about: `❤️` is U+2764 U+FE0F and a bare `❤` is not RGI, so the
// variation selector is required rather than optional and the table cannot
// collect two spellings of one reaction. Anchors are required — `\p{RGI_Emoji}`
// is happy to match in the middle of a string.
//
// The `v` flag is what makes `\p{RGI_Emoji}` (a property *of strings*, matching
// more than one codepoint) legal at all; under `u` this is a SyntaxError.
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

export function isReactionEmoji(value) {
    return typeof value === 'string' && RGI_EMOJI.test(value);
}
