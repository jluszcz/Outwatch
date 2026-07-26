# Phone-Optimized Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Outwatch comfortable to use on a phone — the season name stays visible while checkbox columns scroll, every control is a real touch target, and no interaction triggers iOS's focus-zoom or leaves a hover state stuck on.

**Architecture:** All work happens inside the existing `@media (max-width: 640px)` breakpoint in `frontend/styles.css`, plus one new `@media (hover: hover)` gate. Two markup changes in `frontend/board.js` reach what CSS cannot: a two-span season label and a `<label>` wrapper that turns each checkbox cell into a 44px tap target. Desktop rendering does not change.

**Tech Stack:** Preact + htm, esbuild, plain CSS with `light-dark()` tokens, Vitest for the one pure helper, Playwright (scratchpad-only, never a project dependency) for layout verification.

## Global Constraints

- **Never commit real names or email addresses.** The real roster lives only in the gitignored `roster.sql`. Committed files use the placeholders from `roster.example.sql`: `user-N` ids, the names `Alice`, `Bob & Carol`, `Dave & Erin`, and `@example.com` emails. **Screenshots captured during verification show the real roster — keep them in the scratchpad and never commit them or paste the names into a tracked file.**
- **Before every commit run all four checks and confirm they pass:** `npm run build`, `npm test`, `npm run lint`, `npm run format:check`. These are exactly what CI runs. A commit that fails any of them must not be made.
- Never use `--no-verify`. Never amend an existing commit. If a hook modifies files, restage and run a fresh `git commit`.
- Indentation is 4 spaces for JS and CSS, `singleQuote: true`, `printWidth: 100`, per `.prettierrc`. Let Prettier settle formatting; do not hand-format.
- Do not edit `public/script.js` or `public/styles.css` — they are build output and gitignored. Edit `frontend/`.
- Playwright is **not** added to `package.json`. It is installed into the session scratchpad only.
- Work happens on branch `phone-optimized-layout-design`, which already exists and holds the design spec.
- The spec this implements is `docs/superpowers/specs/2026-07-26-mobile-responsive-design.md`.

## File Structure

**Created:**

| Path                                         | Responsibility                                               |
| -------------------------------------------- | ------------------------------------------------------------ |
| `<scratchpad>/mobile-check.js`               | Playwright layout assertions + screenshots. Never committed. |
| `<scratchpad>/package.json`, `node_modules/` | Isolated Playwright install. Never committed.                |

**Modified:**

| Path                          | Change                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `frontend/utils.js`           | New `seasonParts` helper                                                            |
| `test/frontend/utils.test.js` | Tests for `seasonParts`                                                             |
| `frontend/board.js`           | Two-span season label; `<label class="check-hit">` around the checkbox              |
| `frontend/styles.css`         | The bulk — pinned column, touch targets, hover gating, `dvh`, wrapping, 16px inputs |
| `CLAUDE.md`                   | Document the phone layout under Frontend                                            |

### Deviation from the spec

The spec did not anticipate the column headers. A baseline capture at 390px showed `.table-wrapper` already overflowing with only **three** user columns, and the dominant cause is `th { white-space: nowrap }` (`styles.css:199`) applied to a shared couple's column whose name is two words joined by `&`. That forces an ~85px column and squeezes the season name into three or four wrapped lines.

Task 3 therefore also lets check-column headers wrap on phones and hides the `(you)` suffix there. This serves the approved pinned-column direction rather than changing it: without it, the pinned column would be pinned but only a few characters wide.

---

### Task 1: Verification harness

Builds the tool every later task uses. Nothing in this task is committed.

**Files:**

- Create: `<scratchpad>/package.json` (via `npm init -y`)
- Create: `<scratchpad>/mobile-check.js`

Throughout this plan, `<scratchpad>` means the session scratchpad directory given in the environment.

**Interfaces:**

- Consumes: nothing.
- Produces: `node <scratchpad>/mobile-check.js` — exits `0` when every assertion passes, exits `1` and prints each failure otherwise. Writes `<scratchpad>/shots/<view>-<width>.png` for each view/width pair. Later tasks run this after every CSS change.

- [ ] **Step 1: Install Playwright into the scratchpad**

```bash
cd <scratchpad>
npm init -y
npm install playwright --no-audit --no-fund
```

Chrome is already installed on this machine, so the script launches it with `channel: 'chrome'` and no browser download is needed. Do **not** run `npx playwright install`.

- [ ] **Step 2: Seed sample discussion posts into the local dev database**

The local D1 has 50 seasons and 3 users but zero posts, so the season view would render with nothing to lay out. Add sample posts through the API rather than SQL, so they get realistic `created_at` values.

Start the dev server first:

```bash
cd <project root>
npm run dev > <scratchpad>/dev.log 2>&1 &
sleep 12
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/board   # expect 200
```

Then post three notes to season 2, episode 1, and start a timer so an offset is stamped:

```bash
curl -s -X POST http://localhost:8787/api/seasons/2/episodes/1/timer \
  -H 'Content-Type: application/json' -d '{"action":"start"}'
curl -s -X POST http://localhost:8787/api/seasons/2/episodes/1/posts \
  -H 'Content-Type: application/json' -d '{"body":"the challenge edit gave this away immediately"}'
curl -s -X POST http://localhost:8787/api/seasons/2/episodes/1/posts \
  -H 'Content-Type: application/json' \
  -d '{"body":"a deliberately long note so the body wrapping and the stacked meta line can both be checked at 320px wide"}'
curl -s -X POST http://localhost:8787/api/seasons/2/episodes/2/posts \
  -H 'Content-Type: application/json' -d '{"body":"second episode note"}'
```

`DEV_USER_EMAIL` in `.dev.vars` decides who these are attributed to; whoever that is, they are the caller, so all three are the caller's own notes and render unlocked.

- [ ] **Step 3: Write the harness script**

Create `<scratchpad>/mobile-check.js`:

```js
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://localhost:8787';
const WIDTHS = [320, 390, 430];
const SHOTS = `${__dirname}/shots`;

// Minimum bounding-box size, in px, for each interactive control. 44 is the
// platform touch-target guideline; post-delete is deliberately smaller because
// it is destructive and sits inline with notes you scroll past.
const TARGETS = [
    ['.check-hit', 44],
    ['.sort-btn', 40],
    ['.theme-btn', 44],
    ['.episode-head', 44],
    ['.reveal-btn', 44],
    ['.timer-btn', 44],
    ['.post-input', 44],
    ['.post-submit', 44],
    ['.post-delete', 32],
];

const failures = [];
const fail = (msg) => failures.push(msg);

async function checkPage(page, name, width) {
    // 1. No page-level horizontal scroll at any supported width.
    const doc = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
    }));
    if (doc.scrollW > doc.innerW) {
        fail(`${name}@${width}: page scrolls horizontally (${doc.scrollW} > ${doc.innerW})`);
    }

    // 2. Every present control clears its minimum. Absent controls are skipped,
    //    not failed — the board has no .timer-btn and the season view has no
    //    .check-hit.
    for (const [sel, min] of TARGETS) {
        const boxes = await page.$$eval(sel, (els) =>
            els.map((e) => {
                const b = e.getBoundingClientRect();
                return [Math.round(b.width), Math.round(b.height)];
            }),
        );
        for (const [w, h] of boxes) {
            if (h < min) fail(`${name}@${width}: ${sel} is ${w}x${h}, height under ${min}`);
        }
    }

    // 3. Text inputs compute to >= 16px, or iOS Safari zooms on focus and does
    //    not zoom back out.
    const small = await page.$$eval('input, select, textarea', (els) =>
        els
            .filter((e) => e.type !== 'checkbox')
            .map((e) => [e.className, parseFloat(getComputedStyle(e).fontSize)])
            .filter(([, size]) => size < 16),
    );
    for (const [cls, size] of small) {
        fail(`${name}@${width}: "${cls}" font-size ${size}px, under 16px`);
    }

    await page.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: false });
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome' });

    for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });

        // --- Board ---
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
        await page.waitForSelector('#board');
        await checkPage(page, 'board', width);

        // 4. The pinned season column holds when the grid is scrolled right.
        const wrapper = await page.$('.table-wrapper');
        const overflows = await wrapper.evaluate((w) => w.scrollWidth > w.clientWidth);
        if (overflows) {
            await wrapper.evaluate((w) => (w.scrollLeft = w.scrollWidth));
            await page.waitForTimeout(100);
            const drift = await page.evaluate(() => {
                const w = document.querySelector('.table-wrapper');
                const cell = document.querySelector('td.season-cell');
                return Math.round(
                    cell.getBoundingClientRect().left - w.getBoundingClientRect().left,
                );
            });
            if (Math.abs(drift) > 1) {
                fail(`board@${width}: season column drifted ${drift}px when scrolled`);
            }
            await page.screenshot({ path: `${SHOTS}/board-${width}-scrolled.png` });
            await wrapper.evaluate((w) => (w.scrollLeft = 0));
        }

        // --- Season view, with an episode board opened ---
        await page.goto(`${BASE}/#/season/2`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.episode-card');
        await page.click('.episode-card:first-child .episode-head');
        await page.waitForSelector('.post-form');
        await checkPage(page, 'season', width);

        await page.close();
    }

    await browser.close();

    if (failures.length) {
        console.error(`FAIL (${failures.length})`);
        for (const f of failures) console.error(`  - ${f}`);
        process.exit(1);
    }
    console.log(`PASS — screenshots in ${SHOTS}`);
})();
```

- [ ] **Step 4: Run it against unmodified code to capture the baseline**

```bash
node <scratchpad>/mobile-check.js
```

Expected: **FAIL**, listing at minimum `.check-hit` missing (the selector does not exist yet, so no boxes are measured — this one reports nothing), `.sort-btn` and `.theme-btn` under their minimums, and `.post-input` / `.nw-select` under 16px.

This failing run is the point of the task: it proves the harness measures the right things before anything is fixed. Keep the baseline screenshots for comparison.

- [ ] **Step 5: Nothing to commit**

The scratchpad is outside the repo. Confirm the working tree is still clean:

```bash
git status --porcelain   # expect no output
```

---

### Task 2: `seasonParts` helper and the two-span label

Pure-logic TDD. Desktop rendering must be byte-identical after this task; only the DOM structure changes.

**Files:**

- Modify: `frontend/utils.js`
- Modify: `test/frontend/utils.test.js`
- Modify: `frontend/board.js:64-76` (`SeasonRow`'s season cell)
- Modify: `frontend/styles.css` (one new rule)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `seasonParts(season) -> { number: string, subtitle: string }`. Task 3 styles the `.season-num` and `.season-sub` spans this task introduces.

- [ ] **Step 1: Write the failing tests**

Add to `test/frontend/utils.test.js`. Put the block immediately after the existing `seasonLabel` describe block (which ends at line 30), matching the file's `// ---` section-comment style:

```js
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
```

Add `seasonParts` to the existing import list at the top of the file (lines 2-10), keeping it next to `seasonLabel`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/frontend/utils.test.js
```

Expected: FAIL — `seasonParts is not a function` (or an import error naming `seasonParts`).

- [ ] **Step 3: Implement the helper**

Add to `frontend/utils.js`, directly below `seasonLabel` (which ends at line 5):

```js
// The same label split for layouts that put the number and the subtitle on
// separate lines. `subtitle` is '' when the season has none, so callers can
// test it directly rather than checking the season object again.
export function seasonParts(season) {
    return { number: `Season ${season.id}`, subtitle: season.subtitle ?? '' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/frontend/utils.test.js
```

Expected: PASS, including the three pre-existing `seasonLabel` tests — `seasonLabel` must not have been touched.

- [ ] **Step 5: Render the two spans**

In `frontend/board.js`, add `seasonParts` to the import from `./utils.js` (lines 4-10). Then replace the anchor in `SeasonRow`'s season cell. The current cell is:

```js
<td class="season-cell">
    <a class="season-link" href=${`#/season/${season.id}`}>${seasonLabel(season)}</a>
```

Replace with:

```js
<td class="season-cell">
    <a class="season-link" href=${`#/season/${season.id}`}
        ><span class="season-num">${number}</span
        >${subtitle ? html`<span class="season-sub">${subtitle}</span>` : null}</a
    >
```

and add this as the first line of the `SeasonRow` function body, before the `return`:

```js
const { number, subtitle } = seasonParts(season);
```

**The `><` line breaks are load-bearing.** htm preserves whitespace between elements, so putting the spans on separate indented lines normally would render `Season 20 : Heroes vs. Villains` with a stray space before the colon. Prettier produces exactly the form above when it wraps a long JSX-like line, so `npm run format` will keep it.

`seasonLabel(season)` is still used two lines below for the checkbox `aria-label` — leave that call alone.

- [ ] **Step 6: Restore the desktop appearance**

The two spans are inline elements, so they already render on one line — but the `: ` separator is gone. Add to `frontend/styles.css`, immediately after the `.season-cell a:hover` rule (which ends at line 336):

```css
/* The label is two spans so the phone layout can stack them (see the 640px
   block). On a wide screen they read as one line, colon and all. */
.season-sub::before {
    content: ': ';
}
```

- [ ] **Step 7: Verify desktop is unchanged**

```bash
npm run build
node <scratchpad>/mobile-check.js
```

The harness still fails on touch targets — expected, nothing has been fixed yet. What matters here: open `<scratchpad>/shots/board-430.png` and confirm season labels still read `Season 2: The Australian Outback` on one logical line, with exactly one space after the colon.

- [ ] **Step 8: Run the full gate and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
```

All four must pass.

```bash
git add frontend/utils.js frontend/board.js frontend/styles.css test/frontend/utils.test.js
git commit -m "refactor(board): split the season label into number and subtitle spans" -m "Groundwork for the phone layout, which stacks the two so a long subtitle cannot widen the pinned season column. Rendering is unchanged at desktop widths."
```

---

### Task 3: Board phone layout

**Files:**

- Modify: `frontend/board.js:81-104` (`SeasonRow`'s checkbox cell)
- Modify: `frontend/styles.css` — the base `.table-wrapper`, `td.check-cell`, `.watching-indicator` rules, and the `@media (max-width: 640px)` block at line 364

**Interfaces:**

- Consumes: `.season-num` / `.season-sub` from Task 2.
- Produces: `.check-hit` — the label wrapping each checkbox. Task 1's harness already asserts it is at least 44px tall.

- [ ] **Step 1: Wrap each checkbox in a label**

In `frontend/board.js`, replace the body of the `<td>` inside `SeasonRow`'s `users.map(...)`. Currently the `td` holds the `watching-indicator` span and the `input` as siblings. Wrap both in a label:

```js
<td key=${u.id} class=${'check-cell' + (isMe ? ' mine' : '')}>
    <label class="check-hit">
        ${
            isCurrentlyWatching
                ? html`<span
                      class="watching-indicator"
                      role="img"
                      aria-label=${`${u.name} is currently watching this season`}
                      >▶</span
                  >`
                : null
        }
        <input
            type="checkbox"
            checked=${checked}
            disabled=${!isMe}
            aria-label=${`${u.name} watched ${seasonLabel(season)}`}
            title=${isMe ? '' : `Only ${u.name} can change this`}
            onChange=${isMe ? (e) => onToggle(season.id, e.target.checked) : undefined}
        />
    </label>
</td>
```

Nothing else changes — same attributes, same handler, same `aria-label`s. A click on a `<label>` toggles the checkbox it contains natively, so the whole cell becomes tappable with no JavaScript. On the other users' columns the input is `disabled`, and a label click on a disabled control does nothing, so this does **not** let anyone toggle someone else's box.

- [ ] **Step 2: Give the label the cell's padding**

In `frontend/styles.css`, add after the `th.check-head, td.check-cell` rule (which ends at line 208):

```css
/* The padding moves from the cell to the label so the label fills the cell and
   the whole thing is one tap target. The desktop values match the `td, th`
   padding it replaces, so row height does not change. */
td.check-cell {
    padding: 0;
}

.check-hit {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 11px 16px;
    cursor: pointer;
}

.check-hit:has(input:disabled) {
    cursor: default;
}
```

Then delete `margin-right: 3px` from the `.watching-indicator` rule (line 304) — the label's `gap` now provides that spacing, and keeping both would double it.

- [ ] **Step 3: Write the phone board rules**

Replace the entire existing `@media (max-width: 640px)` block (lines 364-375) with:

```css
@media (max-width: 640px) {
    .header {
        padding: 14px 16px;
    }

    .app {
        padding: 20px 16px;
    }

    td,
    th {
        padding: 12px 8px;
    }

    /* The season name stays put while the checkbox columns scroll under it —
       otherwise you cannot see which season a checkbox belongs to while
       tapping it. The cells need an opaque background for the same reason. */
    th.season-head,
    td.season-cell {
        position: sticky;
        left: 0;
        z-index: 1;
        background: var(--surface);
        box-shadow: 1px 0 0 var(--border);
    }

    th.season-head {
        background: var(--surface-subtle);
        z-index: 2;
    }

    /* Number over subtitle, so a long subtitle cannot widen the pinned column. */
    .season-num,
    .season-sub {
        display: block;
    }

    .season-sub {
        font-size: 0.85em;
        color: var(--text-subtle);
    }

    .season-sub::before {
        content: none;
    }

    /* A shared column's name is two names joined by "&". Left unwrapped it
       forces an ~85px column and squeezes the season name to a few characters
       per line, which is what made the board unreadable at 390px. */
    th.check-head {
        white-space: normal;
        max-width: 4.5rem;
    }

    /* The column is already tinted; the suffix only costs width here. */
    th.check-head .you {
        display: none;
    }

    .check-hit {
        min-height: 44px;
        padding: 8px;
    }

    .check-cell input {
        width: 24px;
        height: 24px;
    }
}
```

- [ ] **Step 4: Stop the grid's scroll from triggering the browser's back-swipe**

Add to the base `.table-wrapper` rule (line 170), which currently has only `overflow-x`, `border`, and `border-radius`:

```css
overscroll-behavior-x: contain;
```

This is correct at every width, so it goes in the base rule, not the media query.

- [ ] **Step 5: Verify**

```bash
npm run build
node <scratchpad>/mobile-check.js
```

Expected: the `.check-hit` and season-column-drift assertions now pass at all three widths. `.sort-btn`, `.theme-btn`, the season-view targets, and the 16px font checks still fail — Tasks 4 and 5 fix those.

Open `<scratchpad>/shots/board-320-scrolled.png` and confirm by eye that the season name is still fully visible with the grid scrolled to its right end.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
```

```bash
git add frontend/board.js frontend/styles.css
git commit -m "feat(board): pin the season column and enlarge checkbox tap targets on phones" -m "Below 640px the season cell sticks to the left edge while the checkbox columns scroll under it, the label stacks over its subtitle, and each checkbox cell becomes a 44px label. Check-column headers wrap rather than forcing a wide column — a shared column's two-part name was the main reason the board overflowed at 390px."
```

---

### Task 4: Discussion phone layout

**Files:**

- Modify: `frontend/styles.css` — additions inside the `@media (max-width: 640px)` block from Task 3

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Stack the note rows**

Append inside the `@media (max-width: 640px)` block, after the `.check-cell input` rule:

```css
/* Offset, author and delete stay on a meta line; the body takes the full
       width beneath it. Without the `order`, the body's 100% basis would push
       the delete button — which follows it in the DOM — onto a third line. */
.post {
    flex-wrap: wrap;
}

.post-time {
    min-width: 0;
}

.post-body {
    flex-basis: 100%;
    order: 1;
}
```

The order in which notes appear is decided by `orderPosts` in `utils.js` and is untouched — this reflows each row, it does not resequence rows.

- [ ] **Step 2: Let the crowded rows wrap**

Append:

```css
/* The timer is the forcing case: a chip plus three buttons cannot fit
       320px on one line. */
.episode-head,
.season-view-head,
.timer,
.sort-controls {
    flex-wrap: wrap;
}
```

- [ ] **Step 3: Grow the controls to real tap targets**

Append:

```css
.episode-head {
    min-height: 44px;
    align-items: center;
}

.reveal-btn,
.post-submit,
.post-input,
.timer-btn {
    min-height: 44px;
}

.sort-btn {
    min-height: 40px;
    padding: 0.5rem 0.9rem;
    font-size: 0.85rem;
}

.theme-btn {
    min-width: 44px;
    min-height: 44px;
    justify-content: center;
}

/* Deliberately smaller than 44px: this deletes a note and sits inline with
       notes you scroll past, so it should be reachable but not effortless. */
.post-delete {
    min-width: 32px;
    min-height: 32px;
    font-size: 1.1rem;
}
```

- [ ] **Step 4: Verify**

```bash
npm run build
node <scratchpad>/mobile-check.js
```

Expected: every touch-target assertion now passes at all three widths. Only the 16px font-size failures for `.post-input` and `.nw-select` remain — Task 5 fixes those.

Open `<scratchpad>/shots/season-320.png` and confirm the long sample note from Task 1 renders with its body on its own full-width line and the `×` still on the meta line above it.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
```

```bash
git add frontend/styles.css
git commit -m "feat(discussion): stack note rows and enlarge controls on phones" -m "Below 640px a note's offset, author and delete button share a meta line and the body wraps to full width beneath it. The episode head, timer, season head and sort controls wrap, and every control clears a 44px tap target apart from post-delete, which stays at 32px because it is destructive."
```

---

### Task 5: Cross-cutting fixes

Three problems that are not specific to either view.

**Files:**

- Modify: `frontend/styles.css` — `body` (line 45), `.container` (line 53), every `:hover` rule, and the `@media (max-width: 640px)` block

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Fix the iOS focus-zoom**

Append inside the `@media (max-width: 640px)` block:

```css
/* Safari zooms the page in when a control under 16px takes focus, and does
       not zoom back out afterwards. 16px is the threshold, not a preference. */
.post-input,
.nw-select {
    font-size: 16px;
}

.nw-select {
    max-width: 100%;
}
```

The `max-width: 100%` replaces the fixed `220px` cap from the base `.nw-select` rule (line 290), which at 320px would otherwise push the chip past the viewport edge.

- [ ] **Step 2: Handle the dynamic viewport**

In the `body` rule (line 45), replace `min-height: 100vh;` with:

```css
min-height: 100vh;
min-height: 100dvh;
```

Do the same in the `.container` rule (line 53). The `100vh` line stays as the fallback for browsers without `dvh`; browsers that support it take the second declaration.

- [ ] **Step 3: Gate hover behind a pointer that can hover**

On a touch device a `:hover` rule latches after a tap and stays until you tap elsewhere, leaving rows and buttons stuck highlighted. Move every `:hover` rule into one gate.

Remove these eight rules from where they currently sit:

| Rule                                | Line |
| ----------------------------------- | ---- |
| `.theme-btn:hover`                  | 89   |
| `.sort-btn:hover`                   | 159  |
| `tbody tr:hover td`                 | 316  |
| `tbody tr:hover td.check-cell.mine` | 320  |
| `.season-cell a:hover`              | 333  |
| `.back-link:hover`                  | 385  |
| `.season-link:hover`                | 413  |
| `.post-delete:hover`                | 500  |

Add them, bodies unchanged, in one block at the end of `frontend/styles.css`:

```css
/* Hover effects only where a pointer can actually hover. On a touch device a
   :hover rule latches after a tap and stays until you tap something else. */
@media (hover: hover) {
    .theme-btn:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    .sort-btn:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    tbody tr:hover td {
        background: var(--surface-hover);
    }

    tbody tr:hover td.check-cell.mine {
        background: var(--surface-accent);
    }

    .season-cell a:hover {
        color: var(--blue);
        border-bottom-color: var(--blue);
    }

    .back-link:hover {
        color: var(--text);
    }

    .season-link:hover {
        color: var(--blue);
    }

    .post-delete:hover {
        color: var(--red);
    }
}

/* Touch gets no hover, so taps need their own feedback. */
.sort-btn:active,
.timer-btn:active,
.reveal-btn:active,
.post-submit:active,
.theme-btn:active {
    background: var(--surface-hover);
}
```

Copy each body from the original rule rather than retyping it, and confirm the eight originals are gone — a leftover ungated duplicate would defeat the whole step.

- [ ] **Step 4: Verify**

```bash
npm run build
node <scratchpad>/mobile-check.js
```

Expected: **PASS**, with `PASS — screenshots in <scratchpad>/shots` printed and exit code 0. This is the first fully green run.

- [ ] **Step 5: Confirm the desktop layout did not regress**

The `@media (hover: hover)` move touches rules that apply at desktop widths, so check that separately:

```bash
node -e "
const {chromium}=require('playwright');
(async()=>{
  const b=await chromium.launch({channel:'chrome'});
  const p=await b.newPage({viewport:{width:1280,height:900}});
  await p.goto('http://localhost:8787/',{waitUntil:'networkidle'});
  await p.waitForSelector('#board');
  await p.screenshot({path:process.env.SHOTS+'/desktop-1280.png'});
  await p.hover('tbody tr:first-child td.season-cell');
  await p.screenshot({path:process.env.SHOTS+'/desktop-1280-hover.png'});
  await b.close();
})();
"
```

Run it with `SHOTS=<scratchpad>/shots` and `NODE_PATH=<scratchpad>/node_modules`. Compare the two images: the hovered row must visibly change background, proving the gated rules still fire on a real pointer.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run build && npm test && npm run lint && npm run format:check
```

```bash
git add frontend/styles.css
git commit -m "fix(styles): stop iOS focus-zoom, sticky hover, and 100vh overflow" -m "Inputs go to 16px on phones, below which Safari zooms the page in on focus and never restores it. Every :hover rule moves behind @media (hover: hover) so a tap does not leave a control highlighted, with :active states added for touch feedback. body and .container gain a 100dvh line after their 100vh fallback."
```

---

### Task 6: Documentation and handoff

**Files:**

- Modify: `CLAUDE.md` — the Frontend section under Architecture Notes

**Interfaces:**

- Consumes: everything above.
- Produces: the pull request.

- [ ] **Step 1: Document the phone layout**

In `CLAUDE.md`, the Frontend section is a bullet list. Add this bullet after the existing one about `styles.css` theming via `light-dark()`:

```markdown
- Below `640px` the layout switches to a phone variant in the same stylesheet:
  the season column pins to the left of `.table-wrapper` while the checkbox
  columns scroll under it, `seasonParts` splits the label so the subtitle sits
  on its own line, each checkbox is wrapped in a 44px `.check-hit` label, and a
  discussion note's body wraps to full width below its meta line. Two rules are
  load-bearing rather than cosmetic: controls are at least `16px` (Safari zooms
  the page in on focusing anything smaller and never zooms back out), and every
  `:hover` rule sits behind `@media (hover: hover)` (a tap otherwise leaves the
  control highlighted). There is no DOM test suite, so this layout is verified
  with an ad-hoc Playwright script rather than in CI.
```

Do not add Playwright to the Validation section — it is not part of CI and not a project dependency.

- [ ] **Step 2: Run the full gate**

```bash
npm run build && npm test && npm run lint && npm run format:check
```

- [ ] **Step 3: Final end-to-end verification**

With the dev server running:

```bash
node <scratchpad>/mobile-check.js
```

Expected: PASS, exit code 0.

Confirm the scratchpad has screenshots for all six view/width pairs plus the scrolled and desktop captures, and review `board-390.png` against the Task 1 baseline to see the change.

- [ ] **Step 4: Commit and open the pull request**

```bash
git add CLAUDE.md
git commit -m "docs: describe the phone layout in CLAUDE.md"
git push -u origin phone-optimized-layout-design
gh pr create --title "Phone-optimized layout" --body "..."
```

The PR body should state what changed, that desktop rendering is unchanged, and how it was verified. **It must not paste any screenshot or any roster name** — the captures show the real roster.

- [ ] **Step 5: Stop the dev server**

```bash
pkill -f "wrangler dev"; pkill -f "build.js --watch"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section             | Task                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| Pinned season column     | 3                                                                         |
| Two-line season label    | 2                                                                         |
| Board touch targets      | 3                                                                         |
| Stacked notes            | 4                                                                         |
| Wrapping rows            | 4                                                                         |
| Discussion touch targets | 4                                                                         |
| iOS zoom                 | 5                                                                         |
| Sticky hover             | 5                                                                         |
| Viewport units           | 5                                                                         |
| Testing                  | 1, and a verify step in every task                                        |
| Files touched            | all                                                                       |
| Out of scope             | nothing in this plan touches the Worker, API, database, or desktop layout |

**Type consistency** — `seasonParts` is defined once in Task 2 as `{ number, subtitle }` and destructured with those names in Task 2 Step 5. `.check-hit` is introduced in Task 3 and is the same name the Task 1 harness asserts on. `.season-num` / `.season-sub` are created in Task 2 and styled in Task 3 under those names.

**Known gap** — Task 1's harness cannot detect a _missing_ selector, only an undersized present one, so a typo in a class name would show as a silently skipped assertion rather than a failure. The per-task screenshot review steps are what cover that; do not skip them.
