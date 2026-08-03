# Frontend

Conventions and gotchas for the Preact frontend under `frontend/`. Split out
of the root `CLAUDE.md` so it loads only when working on these files.

- `App` fetches `/api/board` on load and owns `users`, `seasons`, `me` state; it refetches when the tab regains focus/visibility so other people's changes show up without a reload.
- The `Board` component supports two sort modes toggled by a button group:
    - `sortSeasons` (default, "Season" mode) — sinks fully-watched seasons to the bottom, then sorts by season number.
    - `sortBySeenCount` ("Seen Count" mode) — sinks fully-watched seasons to the bottom, then sorts by ascending watcher count (ties broken by season number).
      Both functions live in `utils.js` and are shared with tests.
- Checkbox toggles are optimistic: the cell flips immediately, then reconciles
  with the server and reverts on failure.
- Optimistic mutations race the focus refetch, so both `App` and `SeasonView`
  route every fetch through `useRefreshGuard` (`hooks.js`), whose rules live in
  `createRefreshGuard` (`refresh-guard.js`): only the newest fetch may apply its
  response, and a refresh asked for while a mutation is in flight is queued for
  the last mutation to settle rather than started against pre-mutation state.
  The state machine is a plain factory so `test/frontend/refresh-guard.test.js`
  can drive it directly — keep the rules there, not in the hook.
- Only the current user's column checkboxes are enabled; others are read-only.
- Each `NowWatching` chip leads with `.nw-jump`, a button that scrolls that
  person's currently-watching season into view down in the board and lights the
  row for `FLASH_MS`. `Board` owns `flashId` and clears it on a timer;
  `SeasonRow` carries `id="season-row-<id>"`, keyed on the season rather than
  the row's position so the anchor survives a re-sort. The jump also focuses
  the row's season link — with `preventScroll`, so `scrollIntoView` alone
  decides where the row lands — since otherwise it would move the viewport and
  nothing else for a keyboard user. The disc is tinted _and_ rimmed: the tint
  alone vanishes against `.nw-chip.mine`, whose background is already
  `--surface-accent`.
- `row-flash` animates an inset `box-shadow` rather than `background-color`,
  because the cells it crosses disagree about their own background —
  `td.check-cell.mine` is tinted and the phone layout's pinned `td.season-cell`
  is opaque — so a background animation would fade each one towards some other
  cell's colour and snap back at the end. Being an animation it also outranks
  those declarations without having to out-specify them, which is what makes
  the pinned cell flash at all. The phone block overrides only
  `animation-name`, since that layout draws its column divider with the same
  `box-shadow` the flash would otherwise replace for the flash's duration.
- A season row's note count is a pill (`.post-badge`) drawing the `chat` icon, not a
  bare `💬 N`. The emoji rendered as a full-colour system glyph that outweighed
  its own number and ignored the theme, and at `0.75rem` beside a `1rem`
  season number the pair was the lightest thing in the row. The chrome supplies
  the weight so the type does not have to, which keeps the season label the
  row's loudest element. `tr.watched-all .post-badge` exists because the pill
  sets its own colours and would otherwise stay at full contrast on a row
  everything else has faded out of.
- `styles.css` themes via CSS `light-dark()`, which needs a mid-2024 browser
  (Chrome 123+, Safari 17.5+, Firefox 120+); older browsers render with no
  theme colors at all.
- In `styles.css`, keep the `@media (max-width: 640px)` block positioned
  after every un-gated base rule it might otherwise be overridden by — media
  queries add no specificity, so a mobile rule ahead of a same-specificity
  base rule loses on source order and is silently dead. The
  `@media (hover: hover)` and ungated `:active` blocks that follow it need no
  such care: every selector in them carries a pseudo-class, which
  out-specifies the mobile block's overlapping rules regardless of order.
  A base rule that needs to hold at _both_ sizes can sidestep the ordering
  question entirely by expressing itself relative to whatever the mobile
  block sets rather than restating an absolute: `.bi` sizes an icon in `em`,
  so it rides the `1.1rem` the mobile block gives `.post-action` instead of
  needing a duplicate `rem` rule down there.
- Below `640px` that block switches the layout to a phone variant: the season
  column pins to the left of `.table-wrapper` while the checkbox columns
  scroll under it (pinning only engages once the grid overflows the wrapper,
  which the current roster does not — it's a safety net for a longer name
  or another column); `seasonParts` splits the label so the
  subtitle sits on its own line; each header swaps its full name for
  `abbreviateName`'s initials (`Bob & Carol` renders `B & C`) and hides the
  `(you)` suffix — both leave the accessibility tree, not just the layout, but
  each checkbox's own `aria-label` still names its owner in full. A shared
  column is the only kind that needed this: check columns size to their
  longest word, so a name containing `&` wrapped to two or three lines at
  every phone width while a single name always fit on one. The initials span
  needs `white-space: nowrap`, or the column would size to one character and
  break `B & C` across three lines;
  each checkbox sits in a `.check-hit` label (`min-height: 44px`, width
  unconstrained) that needs `td.check-cell { height: 1px }` plus
  `height: 100%` on the label to fill the cell, since `td` is
  `vertical-align: middle`; and a note's body wraps to full width below its
  meta line. The text controls specifically — `.post-input` and `.nw-select` —
  are at least `16px`, since Safari zooms the page in on focusing a form
  control below that and never zooms back out; buttons are not affected and
  stay smaller. That rule has to name `.post-input-wrap::after` alongside
  `.post-input`, for the reason the autosizing bullet below gives. Every `:hover` rule sits behind
  `@media (hover: hover)`, with `.sort-btn:hover` scoped `:not(.active)` so
  hovering the selected sort button keeps its style. No DOM test suite
  exists; this layout is verified with an ad-hoc Playwright script, not CI.
- The hash route `#/season/N` (`useHashRoute` in `hooks.js`) swaps the board for
  `SeasonView`, that season's per-episode discussion boards — a hash beats a
  router library for the app's one extra route, and it also makes Back work,
  survives a reload, and gives each season a link you can paste into chat.
- `SeasonView` fetches only `/api/seasons/:season_id/discussion` — the response
  already names each post's author, so there's no separate `/api/board` fetch
  or roster to merge here, and the season view is a single request.
  `authorAccent` (`utils.js`) takes a post (`{ mine, author_index }`) and reads
  those fields for its stripe colour, rather than searching the roster with a
  `(userId, meId, users)` triple.
- `SeasonView` renders one `EpisodeBoard` per episode. A locked board (not
  `readable`) shows only the note count, the authors, and the caller's own
  notes; opening it (`POST .../reveal`) is permanent. Marking a whole season
  watched has the same effect on every one of its episodes.
- The boards are an accordion: `SeasonView` owns a single `openEpisode` (an
  episode number or `null`) and `EpisodeBoard` is controlled via `open` /
  `onToggle`, so expanding one collapses the rest rather than burying it in a
  tall stack. Keying on the episode number rather than component identity means
  the open board survives the focus refetch.
- `SeasonView` renders a fetch/mutation error as a banner **above** the view,
  the way `App` does; only a failure with no data yet (the initial load) gets
  the view to itself. It must not early-return on `error`, which would unmount
  the whole view — discussion, open episode, and the text sitting unposted in
  the box — on a transient failure, with only a reload or a tab-out to get it
  back.
- Posting shows its progress in the button (spinner + "Posting…", full contrast
  via `aria-busy`) and leaves the textarea **enabled** throughout: disabling a
  focused textarea blurs it, which on a phone tears down the keyboard mid-post
  and never restores it. `busy` gates the submit path instead, so Enter can't
  double-post. Because the box stays editable in flight, the success path clears
  only the text that actually posted (`bodyAfterPost` in `utils.js`), preserving
  anything typed on top of it. That comparison is against the **raw** box
  contents captured at submit time, not the trimmed body the API received:
  comparing against the trimmed form matched nothing whenever the note had
  surrounding whitespace — a trailing space is what a phone's predictive
  keyboard leaves after each accepted word — so the note posted and then sat in
  the box looking unposted. `PostForm` and `EditForm` are the app's two text
  forms, and both get the submit-once rule (and, for `EditForm`, the
  cannot-cancel-while-saving rule) from `useSubmitGuard` (`hooks.js`), wiring
  around `createSubmitGuard` (`submit-guard.js`) — the same split as
  `useRefreshGuard`/`refresh-guard.js`, so the rules are tested as a plain
  factory rather than duplicated per form. The compose box carries
  `enterkeyhint="send"`, since a textarea's return key is otherwise drawn as a
  plain ⏎ — a promise of a newline that this form's Enter-posts handler does not
  keep. `EditForm`'s box keeps the default: its Enter saves, but iOS offers no
  "save" hint and "send" would misdescribe an edit. Neither box can do anything
  about the Previous/Next/Done bar above the keyboard — that is the iOS form
  assistant, owned by the keyboard rather than the page, and no attribute, meta
  tag, or CSS hides it from a browser or a home-screen web app (Safari also does
  not implement `interactive-widget`).
- Both text boxes grow with their content through CSS alone: `.post-input-wrap`
  puts the `<textarea>` and an invisible `::after` replica of the same text into
  one grid cell, so the row is as tall as the text and the textarea stretches to
  fill it. The details this rests on, none of them obvious:
    - The replica renders the wrapper's `data-value` attribute, so that
      attribute must be given the same state the textarea's `value` is. The
      trailing space in its `content` is load-bearing — text ending in a newline
      has to occupy the empty last line, and without it Shift+Enter at the end of
      a note does not grow the box.
    - Every property that decides **where a line breaks** — padding, border
      width, `font`, `font-size`, `white-space`, `overflow-wrap` — belongs on the
      `.post-input, .post-input-wrap::after` pair, never on the textarea alone.
      Set one without the other and the two disagree about the line count, so
      the box comes out a line short or a line tall. This is why the mobile
      block's 16px Safari-zoom rule names the replica too.
    - `max-height: 9rem` is set twice on purpose: on the wrapper it clamps the
      visible box, and on the textarea it stops the control stretching into a
      row that the replica keeps growing past. The wrapper deliberately sets no
      `overflow` — the overflowing replica is `visibility: hidden`, so it neither
      paints nor takes a tap, while hiding it would clip the textarea's focus
      ring and make the wrapper a scroll container of its own. The mobile 44px
      touch target goes on the replica rather than the textarea, since the
      replica is what sizes the row.
    - This replaced a `useAutoSize` hook that set `height: auto` and read
      `scrollHeight` back. That collapse forced a layout in which the document
      was a few lines shorter than it really was, and on iOS — where the compose
      box is the last element on the page and the caret is pinned above the
      keyboard — Safari clamped the scroll offset to the shorter document and
      then scrolled the caret back into view, once per keystroke, so the page
      shook while you typed. Its `resize` listener (there to rewrap on a
      rotation) re-ran the same collapse, and since `body`/`.container` are
      `min-height: 100dvh`, an address bar animating in response to the first
      jump fed the next one. Do not reintroduce a measure-by-collapsing
      autosizer; the replica rewraps with the box, so the rotation case needs no
      listener at all.
- An open board reads controls → discussion → compose box: the
  `.episode-actions` row leads `.episode-body`, then the notes, then the
  `hidden-note` count, then `PostForm`. The controls sit above the list because
  the list grows — as people post and as revealing unhides notes — and anything
  below it moves every time it does.
- The reveal button and the watch timer share one row (`.episode-actions`):
  reveal left, timer pushed right by `margin-left: auto`. The row pins its own
  height to `--control-height` rather than taking it from its tallest child,
  because that child is the reveal button and it vanishes on reveal — a
  content-sized row would shrink by a few pixels and pull the timer up under
  the cursor mid-click. The row is `flex-wrap: wrap-reverse`, not `wrap`: only
  genuinely narrow widths (below roughly `430px`) fail to fit both, and the
  reversed cross axis puts the wrapped-off timer _above_ the button rather
  than below it, so revealing still removes the button from under the timer.
  Deliberately width-driven rather than gated on the `640px` breakpoint — the
  controls fit on one line well below it, and a breakpoint would stack them
  where they didn't need stacking.
- Within an opened board, `orderPosts` (`utils.js`) places every note on one
  synced timeline by watch-timer offset instead of wall-clock time, using
  three cases per author: a real `offset_secs` is used as-is; an author who
  never ran a timer gets an inferred offset of zero, anchored to their own
  earliest note on that episode, so their notes still interleave; and an
  untimed note from an author who _did_ time other notes on the episode (their
  session went stale and they posted again later) is dropped to the tail
  sorted by wall-clock time, rather than given a fabricated offset. A fourth
  rule sits on top of those three: a reply's sort key is clamped to its
  parent's already-clamped key, with the post id as the final tiebreaker so a
  clamped reply sorts after its parent rather than before it — only after is
  guaranteed, not immediately after, since an unrelated entry sharing the
  parent's `(tail, offset, created)` triple and whose id falls between the
  two would sort in between them. A parent's id is always smaller than its
  reply's, since it had to exist to be replied to — and `tail` participates
  in the clamp so a timed reply follows a stranded
  untimed parent into the tail rather than sorting ahead of it by offset
  alone. The parent is looked up through `reply_to.id`; a locked or deleted
  parent clamps nothing, since there is no visible order left to violate.
- A note's meta line is two fixed-width gutters — a `2.5rem` `.post-time` then a
  `4rem` `.post-author` — so every body in a board starts at the same x
  instead of at wherever that note's author's name happened to end. `4rem` holds
  a six-character name (~56px) with room over it; the tighter `3.6rem` that also
  fit was inside the margin by which browsers disagree about the width of one
  string.
  Both are plain `min-width` values rather than a grid: the roster is under five
  people whose names are known, and CSS subgrid would buy an auto-sized column
  at the cost of rewriting the phone layout, which drops the body to its own row
  with `flex-basis: 100%` and has no grid equivalent. A name wider than the
  gutter pushes its own body right and leaves every other note aligned — the old
  behaviour on one row, not a broken layout. The `max-width: 640px` block zeroes
  both, since down there the body is already on its own row and a gutter would
  only open dead space between the offset and the name. Nothing optional may
  join that line; see the `· edited` note in the editing bullet below.
- The stripe colours (`--author-1..5` plus `--blue` for your own notes) are
  spread across the hue wheel rather than chosen for looks, because `--blue`
  sits among them and all six have to be told apart at a 3px stripe. An earlier
  set paired a teal 19° from `--blue` and a crimson 38° from its own orange, and
  each pair read as one colour in a list. Orange (25°) and gold (45°) are the
  tightest pair left and separate on lightness instead; with six colours on a
  wheel some pair has to be adjacent. Changing one value is enough — the quote
  block reuses the same `.post-aN` classes for its border, and `authorAccent`
  only picks the slot.
- A reply renders as a quote block (`Quote` in `post.js`) above the note's own
  body, not as an indented thread. A reply sits at its own watch offset on the
  shared timeline like any other note — but only up to the note it answers:
  `orderPosts` clamps a reply's sort key so it never renders above its parent
  (see the ordering bullet above), and a reply pulled down by that clamp shows
  `↳` in its time chip rather than a stamp that would read backwards against
  the note above it (`postTimeText`/`postTimeTitle` in `post.js`; the
  suppressed stamp moves into the chip's `title`). The marker replaced a blank
  chip: the `title` is hover-only, so on a phone a blank left a clamped reply
  with no time information at all — and a clamped _tail_ note worse off than
  before the clamp existed, since it had been showing a plain date. It also
  says why the stamp is missing rather than merely omitting it. The span
  renders either way — a marked chip, not a missing one — since an absent
  `.post-time` would break the fixed `2.5rem` gutter every note's body lines up
  against. The `title` says `estimated` rather than `stamped` for an inferred
  offset, since that one was synthesized by `orderPosts` for an author who
  never ran a timer. The quote takes the _quoted_ author's accent class,
  not the replier's, since it's read as "this is what they said," and it
  handles the server's three `reply_to` shapes: absent (no quote block), the
  parent's live `{ author_name, body, ... }` (so an edit to the parent shows
  through here — the reply stores an id, not a copy), and `{ id, locked: true }`
  when the caller can no longer read the parent (the season was unmarked after
  the reply was written) — that shape never carries a body, and the locked
  stub must not expect one. `replyTo` (the reply target's id/author/snippet,
  via `quoteSnippet`) is state owned by `EpisodeBoard`, not `SeasonView`: it's
  episode-scoped, `EpisodeBoard` is the common parent of `PostList` (whose
  reply button starts it) and `PostForm` (whose chip displays it and whose
  submit clears it), and scoping it there keeps a half-written reply from
  following you to a different episode.
- Editing a note is inline (`EditForm` in `post.js`): the Edit item in the note's
  ⋯ menu, shown via the server-computed `mine` flag, swaps the body for
  a textarea with Save and Cancel in place, so the surrounding conversation
  stays visible while you rewrite. `PATCH /api/posts/:post_id` never touches
  `created_at`, `offset_secs`, or `reply_to_post_id`, so a saved edit keeps the
  note's position on the shared watch-offset timeline and only its body and an
  `edited_at` marker (`· edited`) change. That marker renders _inside_
  `.post-body`, trailing the note's last line, rather than beside the author on
  the meta line: the meta line holds the time and the author and nothing else,
  because `.post-author`'s fixed gutter is what lines every note's body up and
  anything optional sitting between the two would undo it (see the alignment
  bullet below). Its leading gap is `margin-left`, not a space in the markup,
  since `.post-body` is `white-space: pre-wrap` — a literal space would be
  preserved and would also let the marker wrap away from the body on its own.
  A consequence worth knowing: the marker is hidden while that note is being
  edited, since `EditForm` replaces the body outright. `editingId` is state owned by
  `EpisodeBoard`, for the same reason `replyTo` is — episode-scoped, one note
  editable per board at a time. The edit box shares `.post-input-wrap` with
  `PostForm`'s compose box (see the autosizing note below) and stays enabled
  while saving for the same reason `PostForm`'s does. Escape and Cancel are both routed through `useSubmitGuard`'s
  `canCancel()`, which is `false` while a save is in flight — a save already
  sent can't be recalled, so letting the user back out would mean a late
  success silently applies an edit they believe they discarded.
- Everything you can do to a note lives behind one `⋯` trigger (`PostMenu` in
  `post.js`), replacing the four inline glyph buttons (`↰ ☺+ ✎ ×`) that used to
  crowd every note's meta line. The menu holds the emoji quick row over Reply,
  Edit (yours, and not already being edited), and Delete (yours), each a
  Bootstrap icon plus its name — and the ＋ in that row swaps the items out for
  the full picker (see the reactions bullet below). `menuFor` is state owned by
  `EpisodeBoard`, for the same episode-scoped, one-at-a-time reason as `replyTo`
  and `editingId`; `full` (which of the two bodies is showing) is local to
  `PostMenuPanel`, since it dies with the menu.
    - Split in two: `PostMenu` renders on every note and holds nothing but the
      trigger and the two ways out, while `PostMenuPanel` — the scrim, the
      picker, and the items — mounts only while that note's menu is open. The
      split is what keeps the per-note cost to a button: the Escape listener is
      subscribed by the panel, so a board of fifty notes carries one rather than
      fifty. It also lets its effects key on mount instead of on `open`.
    - Two layouts, one DOM and no JS measurement: on a pointer device the menu
      is a dropdown absolutely positioned inside `.post-actions`
      (`position: relative`, and deliberately no `z-index`, so no stacking
      context forms there and the menu's `z-index` competes page-wide); the
      `max-width: 640px` block switches the same element to `position: fixed`,
      which escapes that ancestor because nothing between it and the root is
      transformed, and it becomes a bottom sheet with a dimmed scrim and a
      close button in its top-right corner (`.post-menu-close`, hidden on a
      pointer device, where clicking anywhere off the dropdown already
      dismisses). That corner is the furthest point in the sheet from the bottom
      edge, and that is the reason for it: while iOS Safari's toolbar is
      collapsed to its pill, the strip along the bottom edge belongs to Safari,
      and a tap there expands the toolbar rather than reaching the page. The
      dismiss control used to be a full-width Cancel row along the sheet's
      bottom, so the most reflexive tap in the menu was also the one most often
      swallowed. The sheet also keeps `1.5rem` of bottom padding, which is not
      decoration — it holds the Delete row, which inherits the bottom-most slot,
      up out of that strip. The padding has to stay on `.post-menu`; moving it
      to `padding-bottom` on the last item would grow that button's hit target
      back down into the strip and restore the bug. It is deliberately modest
      rather than the `3rem` that would clear a collapsed toolbar outright,
      since it shows as empty sheet whenever the toolbar is expanded. Nothing in the discussion view sets `overflow`, so the
      dropdown has nothing to clip it — this is the opposite of the call
      `EmojiPicker` used to document, and it is only safe because the menu
      escaped `.post-content`.
    - A menu opened on the last note of a long board would run past the bottom of
      the viewport, so `position-try-fallbacks: flip-block` reopens it above the
      trigger when there is no room below — the browser measures, which is what
      keeps the no-JS-measurement rule intact. It sits in an `@supports` block
      rather than layering `top: anchor(bottom)` over a plain `top: 100%` in one
      rule: a minifier collapses two `top` declarations and the fallback is the
      one it would drop. Support (Chrome 125+, Firefox 132+, Safari 26+) is a
      higher floor than the `light-dark()` one, which is why it has to degrade
      rather than be relied on — without it the menu opens downward as before.
      The bottom sheet sets `position-try-fallbacks: none`: it is content-sized
      against the bottom edge and cannot overflow.
    - The scrim is rendered in both layouts (transparent on a pointer device)
      and is what dismisses on an outside click. It covers the trigger too, so
      clicking the trigger while open reaches the scrim rather than the
      trigger's own toggle — which is the behavior you want, and it sidesteps
      the usual double-toggle bug.
    - Deliberately not `role="menu"`: that role promises arrow-key roving this
      does not implement. Plain buttons in a labelled group, `aria-haspopup` and
      `aria-expanded` on the trigger, focus into the menu on open, and Escape,
      the scrim, or the sheet's close button handing focus back to the trigger.
      Escape is the one exception: with the full emoji picker open it steps back
      to the actions first, and only dismisses on a second press.
      Focus on open goes to the first _action_ (`.emoji-btn, .post-menu-item`)
      rather than the first button, since the close button leads in DOM order
      and opening a menu onto its own escape hatch is a strange place to land.
      Choosing an item does not
      restore focus — Reply focuses the compose box, Edit the edit box, Delete
      removes the note.
- Any emoji can be a reaction. The quick row (`EmojiPicker`) holds the four in
  `REACTIONS` plus a ＋ that swaps the menu's body for `FullEmojiPicker`
  (`emoji-picker.js`) — a search field over the whole Unicode set and, when the
  search is empty, that set grouped by category. The picker replaces the menu's
  contents rather than opening a layer of its own, so it reuses the dropdown on
  a pointer device and the bottom sheet on a phone: no second scrim, no nesting.
  Choosing an emoji closes the whole menu like every other item, but the
  picker's back chevron and Escape return to the actions instead of dismissing —
  the picker replaced them, so without a way back an accidental ＋ costs a
  dismiss and a reopen to reach Reply.
    - `full` lives in `PostMenuPanel`, not `EpisodeBoard`, since it dies with
      the menu. Escape's meaning now depends on it, so that listener
      resubscribes on `full` rather than binding once on mount the way the
      other menu effects do — at most twice per opened menu. A third effect
      moves focus across the swap (into the search field, back onto the ＋),
      skipping mount, since otherwise a keyboard user is left on a button that
      no longer exists and the browser drops them to the document.
    - A web page cannot open the OS emoji picker; there is no API for it. The
      in-app grid is not a fallback for a nicer thing that exists, it is the
      only thing that works the same on a phone and a laptop. Focusing a text
      input would summon a phone's keyboard (with its emoji key) but does
      nothing at all on desktop.
    - The set is `frontend/emoji-data.json`, generated by
      `generate-emoji-data.js` and inlined by esbuild — which is why the bundle
      roughly doubled, to ~115 KiB. `emoji-picker.js` filters it through
      `isReactionEmoji` **on load**, not at generate time: `\p{RGI_Emoji}`
      resolves against whatever Unicode version the running engine was built
      with, so the newest emoji in the file are not yet RGI anywhere and the
      generating Node is a third engine that is neither the browser drawing the
      picker nor the workerd validating the reaction. Filtering at load means
      the engine deciding is the engine rendering, and new emoji appear as
      browsers update with no regeneration. The residual gap runs one way — a
      browser newer than the Worker can still offer something workerd refuses,
      which surfaces as an error banner.
    - ~1900 buttons render at once. Per-group `content-visibility: auto` plus
      `contain-intrinsic-size` lets the browser skip layout and paint for
      off-screen groups, so this needs no windowing library, scroll listener, or
      JS measurement — the same "let the browser measure" call
      `position-try-fallbacks` makes. The `@media (pointer: coarse)` block's
      44px `min-width` on `.emoji-btn` and `.emoji-grid`'s track floor are one
      decision: set the track from the base rule's 2rem and every button
      overflows its own track.
- `ReactionBar` draws a note's existing chips. Its `reactions` array arrives
  from the server ordered by when each emoji first landed on the note, with
  counts and names resolved, so the client only draws it; `mine` fills a chip in
  and is what tapping it toggles. A chip's accessible name comes from
  `emojiName`, which falls back to the character itself for an emoji the bundled
  data does not know — a reaction stored before the data was generated, or one
  from a newer Unicode version than the viewer's browser. Reactions are per
  individual, not per column, matching the `reactions` table's key — both
  halves of a shared login react separately, and a note's author reacting to
  their own note is allowed. `PUT /api/posts/:post_id/reactions` takes an
  explicit `on` boolean rather than being a toggle, so the client always
  computes it from what the server last said (`!r.mine` for a chip, the
  picker's own `chosen` set for a picker button) instead of flipping a local
  value — idempotent in both directions, so a double tap or a retried request
  can't desync from the server. Choosing an emoji closes the menu
  unconditionally, whether the mutation that follows succeeds or not, so unlike
  `saveEdit` there is no response-driven close for a late answer to race against.
- Icons come from `lucide-preact`, imported per icon in `frontend/icons.js`.
  Named imports from a `sideEffects: false` ESM package, so esbuild drops the
  other ~6,000 exports — the icon module bundles to under 5 KB. It is an
  ordinary npm package rather than a build-plugin scheme like `unplugin-icons`,
  which matters because `test/frontend/post.test.js` reaches `icons.js` through
  `post.js`: a virtual-module import would need the plugin wired into vitest
  too, spending the "npm test needs no bundle step" property. `Icon` paints with
  `currentColor` so a glyph inherits its button's colour — the delete row's red
  hover included — and passes `size={null}` so Lucide's own width/height are
  dropped and `.bi`'s `em` sizing decides the box.
    - **There is no dark-mode variant, and no component needs to know the
      theme to draw an icon.** Dark mode is a pure colour change through
      `light-dark()`. This replaced an outline/`-fill` swap over inlined
      Bootstrap path data, which existed because a 1px Bootstrap outline thins
      out against a dark surface — real, and visible at 16px. Two things
      retired it: Lucide strokes at 2/24 (~1.33px at 16px) rather than ~1px, so
      it holds up on dark without help; and a _filled_ glyph overshoots, coming
      out heavier than the same icon in light mode, so the two themes stopped
      matching. An outline at a brighter colour matches light mode's weight;
      a fill does not.
    - What that deleted: `useIsDark`, its `MutationObserver`, all three of its
      call sites, and the `dark` prop drilled `Board → SeasonRow`. Do not
      reintroduce a theme-reading hook to style an icon — if dark mode needs
      more presence, move the colour, not the shape.
    - **A button hosting a `.bi` needs a `font-size`**, because `.bi` sizes in
      `em` and a `<button>` does not take the page's font on its own (the trap
      `.timer-chip` needed `font-family: inherit` for). Every one of them sets a
      value: `.post-action` `0.9rem`, `.reveal-btn` `0.85rem`, `.timer-btn`
      `0.8rem`, and the header pair `0.95rem`, which puts `1.05em` on 16px. A
      button that sets none falls back to the UA's ~13.3px and draws its glyph
      at 14px — which is exactly how the feed bell came out undersized beside a
      theme toggle that was hand-writing a fixed 16px SVG.
    - `icons.js` is the only icon system. Do not reintroduce a second way to
      draw an icon; the hand-written-SVG split is what caused the sizing bug
      above.
    - `Header` is the one component that still branches on the theme, and it is
      choosing a _glyph_ (sun while dark is in effect, moon while light is),
      not a variant. It reads `theme === 'dark'` off the prop it already
      receives.
- The optional watch timer (`WatchTimer` in `discussion.js`, rule in
  `shared/session.js`) starts, pauses, and resumes per (user, episode); a
  session goes stale after three hours without a start/pause/resume/post, and
  `pause`/`resume` on a stale session 409 without writing. A ± toggle next to
  it opens a second row — Reset once the total is non-zero, then −1m / −15s /
  running total / +15s / +1m — that sets `PUT .../offset` (migration `0008`).
  There is deliberately **no Pause button**: the chip itself is the
  pause/resume control, because the thing you want to stop is the number, and
  a separate button to stop it was a second place to look for one action. That
  makes `.timer-chip` a `<button>` rather than a `<span>` — hence
  `font-family: inherit`, which a button does not take from the page on its
  own — and its `aria-label` names the action _and_ the time, since a button
  whose accessible name is only "+1:12" says nothing about what a click does.
  The chip stays a pill while Restart and ± are roundrects: it is the one
  control in the row that shows state rather than only acting, and the ▶/⏸
  glyph carries which way a click will go.
  The ± toggle rides `.timer-btn` for that roundrect and adds only what a plain
  `.timer-btn` cannot say (`.timer-adjust-toggle`): centring for a single
  glyph, a `min-width` so a one-character label is not narrower than every
  other button, and the open state, which takes `.timer-chip.running`'s accent
  fill rather than inventing a second live-state signal. `.timer-btn` takes its
  height from `--control-height` rather than from its text — the same
  `inline-flex` + `min-height` pairing `.reveal-btn` uses — so a word, a single
  glyph, and `−15s` all come out the same height without anyone pinning them
  one control at a time. A new control dropped into either timer row inherits
  that alignment by using the class. One hover rule covers every button in
  both rows — `.timer-btn:not([aria-expanded='true']):hover` — scoped for the
  same reason `.sort-btn:hover` excludes `.active`: the ± is the only
  `.timer-btn` carrying that attribute, and its open state is an
  equal-specificity selector declared earlier, so an unscoped hover would win
  on source order and flash an open toggle back to its closed fill.
  `.timer-chip:hover` sidesteps the same collision the other way, moving
  `border-color` instead of `background`, since `.timer-chip.running` already
  owns the background at equal specificity — which is also why the chip is the
  one control here whose hover is not a fill.
  Reset _leads_ that row, which reads oddly and is deliberate: the row is
  pinned to its right edge (`.timer-stack` is `align-items: flex-end`), so
  whichever end the one control that comes and goes occupies is the end that
  moves. Trailing, its arrival shoved all four nudge buttons left by a
  Reset-width the moment the total left zero, sliding `+15s` out from under
  the finger that had just tapped it; leading, it grows the row leftwards into
  empty space and nothing else moves. Reserving its width instead — a
  hidden-but-present Reset — held the buttons still too, but left every
  visible button a Reset-width shy of the right edge, so the row stopped
  lining up with the timer above it.
  The correction is applied on read rather than baked into `posts.offset_secs`,
  so a nudge moves every note already posted on that episode along with the
  live chip's own total. It renders in both timer branches, including when no
  session is live: noticing your notes are misplaced usually happens days
  later while reading the board, not mid-watch, which is the case the control
  exists for. `adjusting` (whether that row is open) is local state in
  `WatchTimer` itself, not episode-scoped state up in `EpisodeBoard` the way
  `replyTo`/`editingId`/`menuFor` are — the row belongs to this control alone
  and nothing outside it needs to know whether it's open.
    - The running total is its own optimistic state, `pendingAdjust`, rather
      than a read of the `adjustSecs` prop: that prop is the server's last
      known value, and it only moves forward on the next
      `GET .../discussion` — two round trips behind a tap that just fired
      `PUT .../offset` — so reading it directly would drop or stall every tap
      thrown in quick succession instead of accumulating them. A `nudgeSeqRef`
      generation counter tags each nudge — the same pattern `refresh-guard.js`
      uses to stop an out-of-order fetch response from overwriting a newer
      one, cut down to a single ref since only one thing (`pendingAdjust`) is
      ever in flight here. Two taps close together can have their PUTs
      resolve in either order; the counter is what lets a slower response
      recognize it is no longer the newest and settle nothing rather than
      stomping a result the server already confirmed. `settledAdjust`
      (`utils.js`) is the pure decision the ref feeds: advance to the tapped
      value on success, restore on failure — from `adjustSecsRef`, the last
      value actually known to be stored, not the `adjustSecs` prop itself,
      since the closure captured at tap time would restore whatever the prop
      was _then_ rather than the current server truth — or, when a newer
      nudge has since taken over, touch nothing at all. Whatever it settles
      on updates `adjustSecsRef` too, not just `pendingAdjust`: the refetch
      that would otherwise carry a successful PUT's value back into the
      `adjustSecs` prop can itself fail, and `useRefreshGuard` swallows that
      failure, so a ref advanced only by the prop's effect can sit at a value
      the server has already moved past — and then a _later_ failed nudge
      would "restore" the control to it. The wire value
      `PUT .../offset` sends stays the absolute total rather than the tapped
      delta, even though `pendingAdjust` already tracks the running total
      locally: a delta would double-apply on a retry, and an absolute value
      is what keeps the retried PUT idempotent (the same reason the
      reactions route takes an explicit `on` instead of toggling).
- The what's-new bell (`frontend/feed.js`) is split `FeedBell` / `FeedPanel` the
  same way `PostMenu`/`PostMenuPanel` is: the trigger and its badge always
  render, while the scrim, the list, and the Escape listener mount only while
  the panel is open. It sits in `Header` beside the theme toggle rather than in
  either route's own view, so it is reachable from the board and from a season
  view alike — and it renders only when `showFeed` is true, since every feed
  route 403s for someone off the roster and the bell would otherwise be a
  control that can only fail. Two layouts, one DOM, following the rules
  `PostMenu` established: an anchored dropdown on a pointer device (with
  `position-try-fallbacks: flip-block` behind `@supports`) and a bottom sheet
  with a dimmed scrim below `640px`, its close button in the top-right corner
  for the same iOS-toolbar reason.
    - Opening the panel clears the badge optimistically and `POST`s
      `/api/feed/seen`, bracketed with `beginMutation()`/`endMutation()` from
      `useRefreshGuard` (`endMutation()` in a `finally`) — the same race every
      other mutation in this app guards against: without it, a focus refetch
      landing between the optimistic clear and the POST resolving could apply
      a response fetched before the server was stamped, carrying the old
      `unread_count`, so the badge would come back and stay wrong until some
      later fetch. Both the optimistic clear and the `POST` are skipped
      outright when `data` is still `null` — opening the bell before the very
      first fetch has ever resolved has nothing to mark seen, and stamping the
      server anyway would burn whatever unread marks are about to arrive
      before the panel ever showed them; `FeedPanel`'s loading branch (below)
      covers the same window on the display side. A failed `seen` restores the
      badge and raises no banner — the badge returning is the whole story, and
      the next open retries it.
    - The per-event `unread` marks are deliberately separate from the
      optimistic badge state, and `FeedPanel` snapshots the `data` it opened
      with in a `useState` initialiser rather than reading the live prop —
      `data` is the same prop the badge itself reads, and `useRefreshGuard`'s
      queued-refetch dance around the `seen` `POST` above can apply a fresher
      response while the panel is still on screen. Reading the prop directly
      would clear every mark out from under a still-open panel the instant
      that refetch landed; the snapshot is what holds them for as long as the
      panel stays open and lets them move only on the _next_ open, which is
      the invariant this is for. It also gates `FeedPanel`'s branches: `null`
      reads as "still loading" (see below) rather than being conflated with a
      genuinely empty response.
    - `FeedPanel` splits `close()` from `dismiss()`, mirroring `PostMenu`'s
      items-vs-Escape split: Escape, the scrim click, and the sheet's close
      button all go through `dismiss()`, which hands focus back to the bell
      via a ref before closing it; choosing a feed line goes through `close()`,
      which does not, since the line navigates away and there is nowhere
      useful for focus to return to. Without the split, a keyboard user who
      closes the panel with Escape would land on `<body>` instead of back on
      the bell.
    - Focus on open targets the first `.feed-item`, not the first button —
      the same `.emoji-btn, .post-menu-item`-style exclusion `PostMenuPanel`
      documents, for the same reason: `.feed-close` leads in DOM order, and
      opening the panel onto its own escape hatch is a strange place to land.
      It also matters functionally here in a way it doesn't for the menu:
      `.feed-close` is `display: none` on a pointer device, so a selector that
      could match only it would silently no-op and leave focus in the
      document. The panel div itself (`tabIndex="-1"`) is the fallback target
      when there is no item to focus — still loading, empty, or errored.
    - The badge can read higher than the list is long, since `unread_count`
      covers the whole 30-day window and the list stops at ten. There is
      deliberately no "and N more" footer: the panel has no second page, so it
      could only name a number nobody can follow.
    - `relativeTime` (`utils.js`) takes a `nowMs` the caller computes, not
      `Date.now()` directly, so a device with a wrong clock cannot age the
      whole panel by a day, and it clamps a future stamp to "just now" rather
      than rendering "in 3 hours". `FeedPanel` derives that `nowMs` the same
      way `discussion.js`'s `serverSkewMs` does: a skew (`snapshot.now` minus
      `Date.now()`) computed once against the response it opened with, then
      added back to a live `Date.now()` at render — not the server's `now`
      used directly as the current time, which would freeze every age at
      whatever it was the moment the response landed and leave a panel opened
      forty minutes into a still-focused tab reading "just now" on a note that
      is anything but. The five-minute floor means the minutes tier starts at
      five and `1 minute ago` is unreachable — the singular exists only at the
      hours and days tiers.
    - Loading, empty, and error are three distinct branches, not two: a
      `null` snapshot (nothing has ever loaded) reads "Loading…", not
      "Nothing new yet." — that message is only true once a response has
      actually come back with no events in it.
- The hash route (`parseHashRoute` in `utils.js`, wired by `useHashRoute`)
  understands `#/season/45` and `#/season/45/episode/3`. The parse is a pure
  function so the regex is testable — the same split `refresh-guard.js` and
  `submit-guard.js` draw. `useHashRoute` returns the _same object_ when a
  hashchange leaves both values alone, so Preact can bail out instead of
  re-rendering on every hash event.
    - `SeasonView` seeds `openEpisode` from `routeEpisode` in an effect rather
      than a `useState` initialiser, because the view is keyed on the season:
      following a second feed link within the same season does not remount.
    - **Arriving from a feed line expands the board and must never reveal it.**
      Expanding and revealing are separate handlers (`onToggle` vs `onReveal`)
      and have to stay that way — a reveal is permanent and one-way, and
      spending someone's reveal on a tap they made in a header panel is not
      something they can undo. Landing on a locked episode shows the locked
      board, its authors, and its Reveal button, which is the right
      destination. There is no DOM suite to assert this, so a reviewer should
      check that `reveal` in `discussion.js` still has exactly one call site.
    - Arrival also scrolls the opened episode's card into view — expanding it
      alone leaves a hash navigation sitting at the top of the document with
      the board it just opened potentially hundreds of pixels below the fold,
      which shows nothing happened. `EpisodeBoard` carries
      `id="episode-card-<episode>"` for this to target, and the effect
      (`scrolledEpisodeRef` in `SeasonView`) mirrors `NowWatching`'s jump in
      `board.js` — `scrollIntoView` plus its `prefers-reduced-motion` check,
      via `prefersReducedMotion`, exported from `board.js` rather than
      duplicated. It has to key on `data` as well as `routeEpisode`: the card
      doesn't exist until the discussion has loaded, so keying on
      `routeEpisode` alone would find nothing on the very load that set it.
      The ref is what stops that same dependency from re-scrolling the page
      on every later refetch (focus, a mutation's own refresh) — `data` gets a
      new reference each time, but the ref only lets the jump fire once per
      distinct `routeEpisode`.
- The manifest link in `index.html` carries `crossorigin="use-credentials"`,
  which is load-bearing behind Cloudflare Access: a manifest is fetched without
  credentials by default, so Access would redirect it to a login page, the
  browser would fail to parse HTML as JSON, and the install would silently
  never be offered. There is deliberately no service worker — a cached board is
  a stale board — and deliberately no `viewport-fit=cover`, since iOS insets a
  standalone app clear of the notch on its own and opting in would mean
  threading `env(safe-area-inset-*)` through `styles.css` for nothing.
