# Phone-Optimized Layout

**Date**: 2026-07-26
**Status**: Approved, not yet implemented

## Problem

Most of the group uses Outwatch from a phone, but the interface was built for a
desktop browser and only ever received a padding tweak below 640px. On a 390px
screen today:

- The board's checkbox columns scroll horizontally away from the season name, so
  you cannot see which season a checkbox belongs to while tapping it.
- Checkboxes are 17px — well under the ~44px touch target every mobile platform
  guideline asks for. The same is true of the sort buttons, the theme toggle, the
  timer buttons, and the post-delete `×`.
- Focusing the note input or the "now watching" select makes iOS Safari zoom the
  whole page in and never zoom back out, because both are styled under 16px.
- `:hover` styles latch on after a tap, leaving rows and buttons highlighted
  until you tap somewhere else.
- `min-height: 100vh` does not account for mobile browser chrome, so the page is
  taller than the visible viewport.
- A discussion note renders as one flex row — a 4.5rem offset column, the author,
  the body, and a delete button — leaving the body roughly half-width.

## Solution

Extend the existing hand-written CSS rather than adopting a framework, and make
the phone layout a variation of the desktop one rather than a second layout.

**Bootstrap was considered and rejected.** The app has 595 lines of CSS built on
a `light-dark()` token system. Bootstrap would add roughly 200KB to a Worker
serving a five-person tracker, duplicate and fight that theming, and require
rewriting every component's markup — to solve problems that are a few dozen
lines of CSS.

## Constraints

- One breakpoint: the existing `@media (max-width: 640px)`. Below it is the
  phone layout.
- Supported width range: 320px to 430px.
- Desktop rendering does not change. Every rule below lives inside the phone
  breakpoint, the `@media (hover: hover)` gate, or is a strict improvement at
  all widths (the `dvh` fallback).
- CSS-first. Markup changes only where CSS cannot reach; two are needed, each
  named below, plus one new pure helper to support the first.

## Board

### Pinned season column

`th.season-head` and `td.season-cell` become `position: sticky; left: 0` inside
the existing `.table-wrapper` scroller, with an opaque background matching their
row state and a `box-shadow: 1px 0 0 var(--border)` right edge so the seam reads
as a divider while the grid scrolls under it. The header cell takes a higher
`z-index` than the body cells so it wins where the two sticky axes meet.

`.table-wrapper` also gets `overscroll-behavior-x: contain`, so scrolling the
grid to its end does not hand the gesture to the browser's back-swipe.

### Two-line season label

`seasonLabel()` returns a single string, so the label cannot be split by CSS
alone.

**Markup change 1** — add a pure helper to `frontend/utils.js`:

```js
// Display parts of a season label, for layouts that put the number and the
// subtitle on separate lines. `subtitle` is '' when the season has none.
export function seasonParts(season) {
    return { number: `Season ${season.id}`, subtitle: season.subtitle ?? '' };
}
```

`SeasonRow` in `frontend/board.js` renders `<span class="season-num">` and
`<span class="season-sub">` inside the existing `.season-link` anchor. Desktop
joins them with `.season-sub::before { content: ': ' }`; the phone breakpoint
sets both to `display: block` and clears that `::before`.

The label keeps its full `Season 45` form on phones. The approved mockup showed
`S45`, but the two-line layout has room for the full form, and abbreviating
would introduce a third label variant to keep in sync.

`seasonLabel()` is unchanged and keeps its other callers: the row's aria-label,
the season view title, the "now watching" chips, and the select options.

### Touch targets

The checkbox grows from 17px to 24px.

**Markup change 2** — in `SeasonRow`, wrap the `▶` watching indicator and the
`<input type="checkbox">` in a `<label>` that fills the cell
(`display: flex; min-height: 44px`, centered). Clicking a label toggles the
checkbox it contains natively, so the whole cell becomes the tap target with no
JavaScript change, and the label is inert on the disabled columns — you still
cannot toggle someone else's box.

## Discussion

### Stacked notes

`.post` becomes `flex-wrap: wrap` with `.post-body { flex-basis: 100% }`. The
offset, author, and delete button stay on a meta line; the body wraps to the
full width beneath it. `.post-time` drops its `min-width: 4.5rem` on phones.

The synced-timeline order from `orderPosts` is untouched — this is a reflow of
each row, not a change to how rows are sequenced.

### Wrapping rows

`flex-wrap: wrap` is added to `.episode-head`, `.season-view-head`, `.timer`,
and `.sort-controls`. The timer is the forcing case: a chip plus three buttons
cannot fit 320px on one line.

### Touch targets

`min-height: 44px` on `.reveal-btn`, `.post-submit`, `.post-input`,
`.timer-btn`, `.episode-head`, `.theme-btn`, and `.sort-btn`.

`.post-delete` is the deliberate exception at 32px. It is destructive and sits
inline with notes you scroll past, so a target that is comfortable but not
effortless is the right trade.

## Cross-Cutting Fixes

**iOS zoom.** `.post-input` and `.nw-select` go to `font-size: 16px` within the
phone breakpoint. Safari auto-zooms on focusing any control under 16px and does
not restore the previous zoom afterward. `.nw-select` also gets
`max-width: 100%`, replacing its fixed 220px cap.

**Sticky hover.** Every `:hover` rule moves inside `@media (hover: hover)` —
`.theme-btn`, `.sort-btn`, `tbody tr` (both variants), `.season-cell a`,
`.back-link`, `.season-link`, and `.post-delete`. Each affected control gains an
`:active` state so taps still give feedback on touch.

**Viewport units.** `body` and `.container` keep `min-height: 100vh` and add
`min-height: 100dvh` on the following line, so browsers without `dvh` fall back
to the current behavior.

## Testing

`seasonParts` is a pure function and gets unit tests in
`test/frontend/utils.test.js`: a season with a subtitle, and one without. It is
the only part of this change the logic-only suite can cover; the rest is layout.

Layout is verified with a throwaway Playwright script in the session scratchpad,
driving installed Chrome (`channel: 'chrome'` — no browser download) against
`npm run dev`. It is **not** added to `package.json` and **not** committed;
Playwright is a verification tool for this change, not a project dependency.

The script loads the board and a season view at 320px, 390px, and 430px, and
asserts:

1. `document.documentElement.scrollWidth <= window.innerWidth` — no page-level
   horizontal scroll at any width.
2. The season cell's left edge stays at the wrapper's left edge after the grid
   is scrolled right — the pinned column holds.
3. Every interactive control's bounding box clears its minimum: 44px, or 32px
   for `.post-delete`.
4. `.post-input` and `.nw-select` compute to a font size of at least 16px.

It also captures screenshots at each width for review.

Before committing, the full CI gate runs locally and must pass: `npm run build`,
`npm test`, `npm run lint`, `npm run format:check`.

## Files Touched

| File                          | Change                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| `frontend/styles.css`         | The bulk — sticky column, touch targets, hover gating, `dvh`, wrapping |
| `frontend/board.js`           | Two-span season label; `<label>` wrapper around the checkbox           |
| `frontend/utils.js`           | New `seasonParts` helper                                               |
| `test/frontend/utils.test.js` | Tests for `seasonParts`                                                |
| `CLAUDE.md`                   | Document the phone layout under Frontend                               |

Work happens on a feature branch with an upstream, per the project's git rules.

## Out of Scope

- Any change to the Worker, the API, or the database.
- Pull-to-refresh, a sticky post form, install/PWA support, or gesture
  navigation. The focus-refetch in `hooks.js` already covers returning to the
  tab.
- Restyling the desktop layout.
- A card-based mobile board. It was considered and set aside: it needs a second
  layout in `board.js` to maintain, and the pinned-column table solves the same
  problem without one.
