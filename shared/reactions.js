// The valid reaction emoji, shared by the Worker (which validates against them)
// and the browser bundle (whose picker renders from them) — the two must agree
// or the client offers a button the server rejects.
//
// The array's order is the picker's order and the display order of a note's
// reaction chips. `label` is each picker button's accessible name.
//
// Matching is exact, not normalized. Every emoji here is a single codepoint
// today, but `❤️` is two (U+2764 U+FE0F) — adding it would make a bare `❤` a
// different string and a 400.
export const REACTIONS = [
    { emoji: '👍', label: 'Thumbs up' },
    { emoji: '👎', label: 'Thumbs down' },
    { emoji: '🤣', label: 'Laughing' },
    { emoji: '😮', label: 'Shocked' },
];
