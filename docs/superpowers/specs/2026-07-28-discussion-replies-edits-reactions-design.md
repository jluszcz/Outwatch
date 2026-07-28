# Discussion Replies, Edits, and Reactions

**Date**: 2026-07-28
**Status**: Approved, not yet implemented

## Problem

A per-episode discussion board today supports exactly two things: write a note,
delete your own note. That is enough to leave commentary but not enough to hold
a conversation.

- **No way to answer someone.** Notes land on a shared timeline ordered by watch
  offset, so a reply to something said four notes earlier reads as a non sequitur
  unless the writer retypes what they are responding to.
- **No way to fix a note.** A typo, a wrong castaway name, a half-finished
  thought — the only remedy is delete and repost, which loses the note's frozen
  `offset_secs` and so moves it on the timeline.
- **No cheap way to respond.** Agreeing with someone costs a whole note, which
  dilutes a board where every entry is otherwise substantive.

## Solution

Three additions to the discussion feature, all attaching to the note:

1. **Quote replies** — a stored `reply_to_post_id`. Composing shows a dismissible
   chip naming who you are answering; the posted note renders the parent's text
   in a quote block above your own.
2. **Editing** — an inline textarea in place of the note's body, with the same
   ownership rule as deleting.
3. **Reactions** — eight fixed emoji, applied per individual, several allowed per
   person per note.

Everything stays on the one synced timeline. Nothing here changes the spoiler
gate's shape: visibility remains column-level, evaluated server-side, and the new
fields are gated by the same predicate the bodies already are.

## Scope

In scope:

- Replying to any note visible to you in the same episode, at any depth.
- Editing your own note's body, with an `edited` marker.
- Reacting to any visible note, including your own, with any of eight emoji.
- Extraction of note rendering out of `discussion.js` into `frontend/post.js`.

Out of scope:

- **Threaded display.** Replies sit in timeline order by their own
  `offset_secs`, never indented under a parent. Depth does not accumulate on
  screen: a quote block shows its parent's body, never its parent's quote.
- **Edit history.** Only the current body is stored, plus the time of the last
  edit.
- **Tombstones.** A deleted parent leaves its replies as ordinary notes rather
  than a `[deleted]` placeholder.
- **Optimistic reaction updates.** Reactions go through the existing
  request-then-refetch path like posting. If the round-trip reads sluggish in
  use, optimism is a contained follow-up.
- **Notifications, reaction-on-reaction, custom emoji, re-locking an episode.**

## Data

One migration, `0007_replies_edits_reactions.sql`.

```sql
ALTER TABLE posts ADD COLUMN reply_to_post_id INTEGER REFERENCES posts (id);
ALTER TABLE posts ADD COLUMN edited_at TEXT;

CREATE TABLE reactions (
    post_id    INTEGER NOT NULL,
    email      TEXT    NOT NULL,
    emoji      TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (post_id, email, emoji),
    FOREIGN KEY (post_id) REFERENCES posts (id),
    FOREIGN KEY (email)   REFERENCES user_emails (email)
);

CREATE INDEX idx_reactions_post ON reactions (post_id);
```

`posts.reply_to_post_id` — the note being answered, `NULL` for an ordinary note
and for a reply whose parent has since been deleted. Always in the same season
and episode as the reply itself; the API enforces this, so no read path has to
re-check it.

`posts.edited_at` — ISO timestamp of the last edit, `NULL` on a note never
edited. `created_at` and `offset_secs` are never touched by an edit, so a note
holds its place on the timeline no matter how often it is rewritten.

`reactions` — one row per (note, person, emoji). Keyed on `email` rather than
`user_id` because a reaction is a personal response, like a note's byline and
unlike a watched checkbox: both halves of a shared column react separately. There
is deliberately no `user_id` column — the email resolves to a column through
`user_emails`, and unlike `posts.author_email` it is never `NULL`, so there is no
legacy fallback for it to serve. The composite primary key makes add and remove
naturally idempotent.

## The emoji set

`shared/reactions.js`, imported by both the Worker and the browser bundle, in the
manner of `shared/session.js` — the two must agree on the valid set or the client
offers a button the server rejects.

```js
export const REACTIONS = [
    { emoji: '👍', label: 'Thumbs up' },
    { emoji: '👎', label: 'Thumbs down' },
    { emoji: '❤️', label: 'Heart' },
    { emoji: '🤣', label: 'Laughing' },
    { emoji: '😮', label: 'Shocked' },
    { emoji: '🐍', label: 'Snake' },
    { emoji: '🔥', label: 'Fire' },
    { emoji: '🤔', label: 'Thinking' },
];
```

The array's order is the picker's order and the display order of a note's
reaction chips. `label` is the accessible name on each picker button. Adding a
ninth is a one-line change in one file; the stylesheet's picker grid is
`repeat(4, …)` and wraps on its own.

## API

### `POST /api/seasons/:season_id/episodes/:episode/posts`

The request body gains an optional `reply_to_post_id`:

```js
const postCreate = z.object({
    body: z.string().trim().min(1).max(2000),
    reply_to_post_id: z.number().int().positive().nullish(),
});
```

When present, the parent is validated before the insert: it must exist, carry the
same `season_id` and `episode` as the route, and be **visible to the caller**
(see Visibility below). Any failure returns `404 { error: 'Unknown post' }` —
missing, wrong-episode, and not-visible are indistinguishable, matching the
delete route's rule that this API is never an oracle for which post ids are real.

Everything else about posting is unchanged: the offset is still stamped from the
caller's live session, the note still carries `author_email`, and the session's
`last_activity_at` is still touched in the same batch.

### `PATCH /api/posts/:post_id`

Body `{ body }`, validated by the same trim/1/2000 rule as `postCreate` — the
schema is shared rather than duplicated.

Ownership is the same predicate as `DELETE /api/posts/:post_id`: the individual
author, or the column when `author_email IS NULL` on a note predating individual
attribution.

```sql
UPDATE posts SET body = ?, edited_at = ?
WHERE id = ? AND user_id = ? AND (author_email = ? OR author_email IS NULL)
```

`meta.changes === 0` returns `404 { error: 'Unknown post' }`, so a note that is
not yours and a note that does not exist are again indistinguishable. Success
returns `{ success: true, post_id, edited_at }`; the client refetches the
discussion regardless, so the response body is a receipt, not a payload.

Season-agnostic, like the delete route: a post id alone identifies the row, so
this does not go through `resolveEpisode`.

An edit does not clear the note's reactions. A 👍 on text that has since changed
is a real if-you-squint problem, but on a four-person household board it is not
one, and dropping reactions on every typo fix would be the worse behaviour.

### `PUT /api/posts/:post_id/reactions`

Body `{ emoji, on }`:

```js
const reactionUpdate = z.object({
    emoji: z.enum(REACTIONS.map((r) => r.emoji)),
    on: z.boolean(),
});
```

An emoji outside the set is a `400` — including a near-miss such as a bare `❤`
without its U+FE0F variation selector. The comparison is exact rather than
normalized, which is safe because the picker renders from the same array it
validates against, so the client can only ever send a member of the set.

The target post must be visible to the caller, else
`404 { error: 'Unknown post' }`. Reacting to your own note is allowed.

`on: true` is `INSERT OR IGNORE`, `on: false` is `DELETE` — both idempotent, so a
double tap cannot flip the state twice and a retry after a dropped response is
harmless. This is why the request carries an explicit `on` rather than being a
toggle.

The emoji travels in the body rather than the path (`PUT …/reactions/❤️`) because
❤️ is two codepoints (U+2764 U+FE0F) and routing it through a percent-encoded path
param invites normalization bugs for no benefit.

### `DELETE /api/posts/:post_id`

Gains cleanup of the two new relationships. Ownership is checked **first**, with
a select, so that a caller who does not own the note cannot strip its reactions:

1. `SELECT id FROM posts WHERE id = ? AND user_id = ? AND (author_email = ? OR author_email IS NULL)` — `404` if no row.
2. `DB.batch`, in this order:
    - `DELETE FROM reactions WHERE post_id = ?`
    - `UPDATE posts SET reply_to_post_id = NULL WHERE reply_to_post_id = ?`
    - `DELETE FROM posts WHERE id = ?`

The order matters whether or not D1 enforces foreign keys: children are detached
and dependent rows removed before the referenced row goes. Doing it explicitly in
the route rather than leaning on `ON DELETE` clauses keeps the behaviour
deterministic and directly testable.

If the final statement reports `changes === 0` — the row vanished between the
select and the batch — the route returns `404`, not a false success.

Deleting a note therefore leaves its replies in place as ordinary notes with no
quote block. Delete is the author's explicit *unsay it*; a `[deleted]` ghost
would preserve the presence of the thing they removed. The cost is a reply that
reads slightly orphaned, which is acceptable for an action this rare.

### `GET /api/seasons/:season_id/discussion`

Each serialized post gains three fields:

```js
{
    id, user_id, body, created_at, offset_secs,     // unchanged
    author_name, author_index, mine,                // unchanged
    edited_at,                                      // string | null
    reply_to,                                       // see below
    reactions,                                      // see below
}
```

`reply_to` has exactly three forms:

| Condition                          | Serialized as                                     |
| ---------------------------------- | ------------------------------------------------- |
| `reply_to_post_id IS NULL`         | `null`                                            |
| parent visible to the caller       | `{ id, author_name, author_index, body }`         |
| parent not visible to the caller   | `{ id, locked: true }` — **no body in the response** |

The parent's `author_name` and `author_index` come from the same `attribute()`
helper the post itself uses, so a quote block can take the quoted author's accent
colour with no extra lookup. No extra query either: a parent is always in the
same season, and the route already selects every post in the season, so the
parent is found in a `Map` keyed by post id built from that result.

`reactions` is an array of the emoji present on that note, in `REACTIONS` order,
omitting any with a count of zero:

```js
reactions: [{ emoji: '🤣', count: 2, mine: true, names: ['Bob', 'Dana'] }];
```

`names` is included rather than counts alone because on a roster of four or five
people, "2" is nearly meaningless while "Bob and Dana" is the whole content of
the reaction. `mine` is whether the caller's own email is among them, which is
what fills the chip in.

Reactions are attached only to posts that survive the visibility filter, so a
locked board leaks no counts and no names. One query fetches every reaction for
the season (`JOIN posts ON posts.id = reactions.post_id WHERE posts.season_id =
?`), grouped by `post_id` in JS alongside the existing post grouping — no
per-post query, and it joins the response's existing `Promise.all`.

## Visibility

The gate is unchanged in shape and remains column-level:

```js
const readable = watchedSeason || revealed.has(episode);
const visible = readable ? all : all.filter((p) => me && p.user_id === me.id);
```

The routes that act on a single post — reply-parent validation and reactions —
need the same predicate for one row rather than a whole episode. A shared helper
loads the post and answers it:

```js
// The post, if the caller may see it: a readable board (season watched or that
// episode revealed) or their own column's note. null otherwise — callers turn
// that into the same 404 a missing post gets.
async function visiblePost(c, postId, me) { … }
```

### The locked-parent case

`reply_to_post_id` is frozen at write time; `visible` is recomputed on every
read. The two can therefore disagree, and this is the path:

1. You mark season 20 watched. Every episode is readable — via `watchedSeason`,
   with no `reveals` row written for any of them.
2. You reply to Bob's note in episode 4.
3. You unmark season 20. `DELETE /api/watched/:season_id` removes the watched
   row and deliberately leaves `reveals` alone — but there is nothing to leave,
   because marking the season watched never wrote one.
4. Episode 4 is locked again. Your reply is still visible to you, being your own
   column's note. Bob's note, its parent, is not.

Narrow — it takes an unmark, and only affects episodes never explicitly
revealed — but not impossible, and it is the reason `reply_to` has a `locked`
form rather than always carrying a body.

Note what does **not** produce it: a partner revealing an episode. `reveals` is
keyed on `user_id`, the column, so a reveal by either half of a household unlocks
the episode for both. Nothing your partner can see is hidden from you.

The same asymmetry applies to creating a reply: the parent must be visible at
write time, and nothing keeps it visible afterwards.

## Frontend

### File split

`discussion.js` is 415 lines and all three features attach to the note, which
would roughly double it. The split follows the seam already there:

- **`frontend/post.js`** (new) — `PostList`, `Post`, `ReactionBar`, `EmojiPicker`
- **`frontend/discussion.js`** — `SeasonView`, `EpisodeBoard`, `WatchTimer`,
  `PostForm`

No other restructuring.

### State

`replyTo`, `editingId`, and `pickerFor` all live in **`EpisodeBoard`**, not
`SeasonView`. They are episode-scoped, and `EpisodeBoard` is the common parent of
`PostList` and `PostForm`, so the compose chip and the note it points at stay in
sync without threading state through the view. One note editable and one picker
open at a time per board, both by construction.

`replyTo` holds `{ id, author_name, snippet }`, derived from the parent post when
Reply is tapped, so the chip needs no lookup on re-render.

`SeasonView` gains two mutations beside `addPost` / `removePost`:

- `editPost(postId, body)` → `PATCH /api/posts/:id`
- `setReaction(postId, emoji, on)` → `PUT /api/posts/:id/reactions`

Both route through the existing `mutate` → `useRefreshGuard` path, so they get
the same race handling, error banner, and refetch as everything else.

### Composing a reply

Tapping **Reply** on a note sets `replyTo` and focuses the textarea through a
ref, so a phone raises the keyboard with the chip already in place. The chip
renders above the textarea, inside `.post-form`:

```
↰ Bob: Jeff's reaction here is inc…  ×
[ Totally agree, that face|        ]
```

`×` clears `replyTo`. A successful post clears it too. The snippet comes from
`quoteSnippet(body)` in `utils.js` — whitespace and newlines collapsed to single
spaces, trimmed, truncated with an ellipsis — a pure function, and the one piece
of this that gets a frontend unit test.

If the parent is deleted while a reply is being composed, the POST returns 404
and surfaces on the existing error banner with the typed text preserved, which is
`PostForm`'s established failure behaviour.

### Rendering a note

```
 12m  Bob                  ↰ ☺+
 ┃ Carol
 ┃ Jeff's reaction here is incredible
 Totally agree, that face
 🤣 2   🐍 1
```

- The quote block (`.post-quote`) renders `reply_to.author_name` above
  `reply_to.body`, taking the **quoted** author's accent from the existing
  `authorAccent`, which already works off `{ mine, author_index }`. The locked
  form renders a 🔒 line — "hidden until you open this episode" — and no body.
- `edited_at` renders as a quiet `· edited` beside the author name, with the
  timestamp in its `title`.
- The action row is `↰ ☺+` on every note, plus `✎ ×` on your own — keyed off the
  existing `mine` flag, which already mirrors exactly what the server will
  permit, so no new field is needed for the edit button.
- All four controls require `meId`. A viewer not on the roster reads what they
  have opened and gets no action row at all, matching the existing rule that
  `PostForm` renders only for a roster member.
- Reaction chips sit under the body: emoji, count, `aria-pressed` when `mine`,
  filled to match, `title` listing `names`. Tapping a chip calls
  `setReaction(id, emoji, !mine)`.

### The picker

`☺+` toggles `pickerFor`, opening a two-row, four-column grid of buttons
**inline below the note** rather than as an absolutely positioned popover — no
clipping inside a scrolling board, and 44px targets fall out of the grid without
fighting the layout. `aria-expanded` on `☺+`; each picker button takes its
accessible name from the `label` in `shared/reactions.js`. Choosing an emoji
calls `setReaction` and closes the picker.

### Editing

`✎` sets `editingId`, swapping the note's body for a textarea with Save and
Cancel. The note keeps its timeline position throughout, so the surrounding
conversation stays visible.

- Enter saves, Shift+Enter breaks a line, Escape cancels — matching `PostForm`'s
  existing keys.
- The textarea stays **enabled** while saving, for the reason `PostForm`'s does:
  disabling a focused textarea blurs it, and on a phone that tears down the
  keyboard mid-save without restoring it. A `busy` flag gates the submit path.
- Cancel restores the original body and discards the draft.
- Saving an unchanged body is allowed and simply stamps `edited_at`; saving an
  empty one is blocked client-side by the same `trim()` check `PostForm` uses,
  and rejected server-side by the shared Zod schema regardless.

`PostForm`'s `fit()` auto-size logic moves to a **`useAutoSize(ref, value)`** hook
in `hooks.js` — including its resize listener — so the compose box and the edit
box share one copy instead of two.

### Styles

New classes in `styles.css`: `.post-quote`, `.post-quote-locked`, `.post-edited`,
`.post-edit`, `.reply-chip`, `.reaction-bar`, `.reaction-chip`
(`.reaction-chip.mine`), `.emoji-picker`.

Three existing constraints apply:

- Every `:hover` rule goes behind `@media (hover: hover)`.
- Any `@media (max-width: 640px)` rule must sit **after** every un-gated base
  rule it overrides — media queries add no specificity, so a mobile rule ahead of
  a same-specificity base rule is silently dead.
- The edit textarea is at least `16px`, like `.post-input`, or Safari zooms the
  page in on focus and never zooms back out. The picker and chip buttons are not
  form fields and are unaffected.

## Testing

### Worker — `test/worker/discussion.test.js`

Replies:

- Parent in a different episode of the same season → 404.
- Parent not visible to the caller → 404.
- Happy path → `reply_to` serialized with the parent's body, `author_name`, and
  `author_index`.
- The unmark scenario → `reply_to` is `{ id, locked: true }` and the parent's
  body appears nowhere in the response.
- Parent deleted → the reply survives with `reply_to: null`.
- An edit to the parent shows through in the reply's quote (the live-parent
  guarantee that motivated storing an id rather than text).

Edits:

- `PATCH` your own note → body changes, `edited_at` set, `created_at` and
  `offset_secs` unchanged.
- `PATCH` a note written by the other individual in your own column → 404.
- `PATCH` a legacy note with `author_email IS NULL` by that column → succeeds.
- Empty and 2001-character bodies → 400.
- Unknown post id → 404.
- The note holds its timeline position after an edit.

Reactions:

- `on: true` twice → count 1.
- `on: false` → removed; `on: false` again → success, still absent.
- Emoji outside `REACTIONS` → 400.
- Reaction on a post not visible to the caller → 404.
- Two individuals in the same column react separately and both are counted.
- One person applying two different emoji to one note → both present.
- Locked board: a foreign post is absent from the response entirely, so no
  counts or names ride along.
- Deleting a post removes its reactions.
- A non-owner's failed delete leaves the post's reactions intact.

### Worker — `test/worker/migrations.test.js`

The new columns and the `reactions` table exist with the expected shape.

### Frontend — `test/frontend/`

Pure logic only, per the existing pattern:

- `quoteSnippet` — truncation, newline collapsing, short bodies left alone.
- One `orderPosts` case asserting a reply sorts by its own `offset_secs` rather
  than adjacent to its parent, pinning the timeline decision against drift.

`orderPosts` itself is otherwise untouched: replies are ordinary posts with
ordinary offsets.

### Manual

No DOM suite exists. The picker, the inline edit box, and the reply chip get
verified on a phone width with the ad-hoc Playwright script, as the responsive
layout was.

### Gates

`npm run build`, `npm test`, `npm run lint`, and `npm run format:check` all pass
before any commit.

## Documentation

`CLAUDE.md` documents the schema, every route, and the frontend structure at this
level of detail, so it is updated as part of the work, not afterwards:

- Repository structure — `frontend/post.js`, `shared/reactions.js`, migration
  `0007`.
- Database schema — `posts.reply_to_post_id`, `posts.edited_at`, the `reactions`
  table.
- API routes — `PATCH /api/posts/:post_id`, `PUT /api/posts/:post_id/reactions`,
  the new fields on the discussion response, the changed delete semantics.
- Frontend notes — the file split, where reply/edit/picker state lives, the
  timeline-not-threaded decision, and the locked-parent case.
