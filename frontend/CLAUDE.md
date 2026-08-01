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
  which the current 3-column roster does not — it's a safety net for a
  longer name or a fourth column); `seasonParts` splits the label so the
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
  factory rather than duplicated per form.
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
  sorted by wall-clock time, rather than given a fabricated offset.
- A reply renders as a quote block (`Quote` in `post.js`) above the note's own
  body, not as an indented thread — `orderPosts` is untouched by replies, so a
  reply sits wherever its own watch offset places it on the shared timeline,
  same as any other note. The quote takes the _quoted_ author's accent class,
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
  `edited_at` marker (`· edited`) change. `editingId` is state owned by
  `EpisodeBoard`, for the same reason `replyTo` is — episode-scoped, one note
  editable per board at a time. The edit box shares `.post-input-wrap` with
  `PostForm`'s compose box (see the autosizing note below) and stays enabled
  while saving for the same reason `PostForm`'s does. Escape and Cancel are both routed through `useSubmitGuard`'s
  `canCancel()`, which is `false` while a save is in flight — a save already
  sent can't be recalled, so letting the user back out would mean a late
  success silently applies an edit they believe they discarded.
- Everything you can do to a note lives behind one `⋯` trigger (`PostMenu` in
  `post.js`), replacing the four inline glyph buttons (`↰ ☺+ ✎ ×`) that used to
  crowd every note's meta line. The menu holds an emoji row over Reply, Edit
  (yours, and not already being edited), and Delete (yours), each a Bootstrap
  icon plus its name. `menuFor` is state owned by `EpisodeBoard`, for the same
  episode-scoped, one-at-a-time reason as `replyTo` and `editingId`.
    - Split in two: `PostMenu` renders on every note and holds nothing but the
      trigger and the two ways out, while `PostMenuPanel` — the scrim, the
      picker, and the items — mounts only while that note's menu is open. The
      split is what keeps the per-note cost to a button: `useIsDark`'s
      `MutationObserver` and the Escape listener are subscribed by the panel, so
      a board of fifty notes carries one of each (the open menu's) rather than
      fifty. It also lets both effects key on mount instead of on `open`.
    - Two layouts, one DOM and no JS measurement: on a pointer device the menu
      is a dropdown absolutely positioned inside `.post-actions`
      (`position: relative`, and deliberately no `z-index`, so no stacking
      context forms there and the menu's `z-index` competes page-wide); the
      `max-width: 640px` block switches the same element to `position: fixed`,
      which escapes that ancestor because nothing between it and the root is
      transformed, and it becomes a bottom sheet with a dimmed scrim and a
      Cancel row. Nothing in the discussion view sets `overflow`, so the
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
      `aria-expanded` on the trigger, focus into the menu on open, and Escape or
      the scrim handing focus back to the trigger. Choosing an item does not
      restore focus — Reply focuses the compose box, Edit the edit box, Delete
      removes the note.
- The emoji row (`EmojiPicker`) and the `ReactionBar` of chips below a note are
  both driven by the four-emoji set in `shared/reactions.js` — the same module
  the Worker validates against, so the picker can never offer an emoji the
  server would reject. A note's `reactions` array arrives from the server
  already in set order with counts and names resolved, so the client only draws
  it; `mine` fills a chip in and is what tapping it toggles. Reactions are per
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
- Icons are Bootstrap Icons path data inlined in `frontend/icons.js`, not the
  npm package: it ships ~2,000 SVGs and a webfont to supply the four glyphs this
  app draws, and inlining keeps the bundle free of external requests. `Icon`
  paints with `fill="currentColor"` and sizes in `em` (`.bi`), so a glyph
  inherits its button's colour — the delete row's red hover included — and its
  font-size, without a token of its own. The `-fill` variants are used in dark
  mode, where a 1px outline thins out against the dark surface. That swap is the
  one thing CSS cannot express (everything else themes through `light-dark()`
  tokens, which resolve without anyone knowing which theme won), so `useIsDark`
  (`hooks.js`) observes the `data-theme` attribute `useTheme` writes — the
  attribute, not the media query, so the manual toggle counts, and a
  `MutationObserver` rather than a context so nothing has to be threaded through
  `App → SeasonView → EpisodeBoard → PostList → Post` to reach the menu. One
  observer per calling component is the price of skipping the context, so call
  it from the narrowest component that needs it (`PostMenuPanel`, not
  `PostMenu`) — if a third caller ever renders per-note, a shared subscription
  is the better trade.
- The optional watch timer (`WatchTimer` in `discussion.js`, rule in
  `shared/session.js`) starts, pauses, and resumes per (user, episode); a
  session goes stale after three hours without a start/pause/resume/post, and
  `pause`/`resume` on a stale session 409 without writing.
- The manifest link in `index.html` carries `crossorigin="use-credentials"`,
  which is load-bearing behind Cloudflare Access: a manifest is fetched without
  credentials by default, so Access would redirect it to a login page, the
  browser would fail to parse HTML as JSON, and the install would silently
  never be offered. There is deliberately no service worker — a cached board is
  a stale board — and deliberately no `viewport-fit=cover`, since iOS insets a
  standalone app clear of the notch on its own and opting in would mean
  threading `env(safe-area-inset-*)` through `styles.css` for nothing.
