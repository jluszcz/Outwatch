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
  block sets rather than restating an absolute: `.post-action-edit > span`
  and `.post-action-delete > span` size their glyphs in `em`, so they ride
  the `1.1rem` the mobile block gives `.post-action` instead of needing a
  duplicate `rem` rule down there.
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
  stay smaller. Every `:hover` rule sits behind
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
- Editing a note is inline (`EditForm` in `post.js`): the ✎ button on one of
  your own notes, shown via the server-computed `mine` flag, swaps the body for
  a textarea with Save and Cancel in place, so the surrounding conversation
  stays visible while you rewrite. `PATCH /api/posts/:post_id` never touches
  `created_at`, `offset_secs`, or `reply_to_post_id`, so a saved edit keeps the
  note's position on the shared watch-offset timeline and only its body and an
  `edited_at` marker (`· edited`) change. `editingId` is state owned by
  `EpisodeBoard`, for the same reason `replyTo` is — episode-scoped, one note
  editable per board at a time. The edit box shares `useAutoSize` (`hooks.js`)
  with `PostForm`'s compose box, extracted from `PostForm.fit` rather than
  duplicated, and stays enabled while saving for the same reason `PostForm`'s
  does. Escape and Cancel are both routed through `useSubmitGuard`'s
  `canCancel()`, which is `false` while a save is in flight — a save already
  sent can't be recalled, so letting the user back out would mean a late
  success silently applies an edit they believe they discarded.
- Reacting is one emoji picker button (`☺+`, second in the action row: `↰ ☺+ ✎
×`) plus a `ReactionBar` of chips (`post.js`), both driven by the four-emoji
  set in `shared/reactions.js` — the same module the Worker
  validates against, so the picker can never offer an emoji the server would
  reject. A note's `reactions` array arrives from the server already in set
  order with counts and names resolved, so the client only draws it; `mine`
  fills a chip in and is what tapping it toggles. Reactions are per
  individual, not per column, matching the `reactions` table's key — both
  halves of a shared login react separately, and a note's author reacting to
  their own note is allowed. `PUT /api/posts/:post_id/reactions` takes an
  explicit `on` boolean rather than being a toggle, so the client always
  computes it from what the server last said (`!r.mine` for a chip, the
  picker's own `chosen` set for a picker button) instead of flipping a local
  value — idempotent in both directions, so a double tap or a retried request
  can't desync from the server. The picker (`EmojiPicker` in `post.js`) is
  inline inside `.post-content`, below the note, not a popover: nothing to
  clip inside a scrolling board, and its 44px touch targets fall out of a CSS
  grid rather than fighting absolute positioning. `pickerFor` is state owned
  by `EpisodeBoard`, for the same episode-scoped, one-at-a-time reason as
  `replyTo` and `editingId`; choosing an emoji closes the picker unconditionally,
  whether the mutation that follows succeeds or not, so unlike `saveEdit` there
  is no response-driven close for a late answer to race against.
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
