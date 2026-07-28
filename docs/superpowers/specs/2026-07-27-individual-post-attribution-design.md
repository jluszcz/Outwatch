# Individual Post Attribution

**Date**: 2026-07-27
**Status**: Approved, not yet implemented

## Problem

A board column is a household, not a person: a couple shares one `users` row and
one checkbox column, with two `user_emails` rows pointing at it. That is right
for the board — they watch together, so they check together.

It is wrong for discussion notes. `callerUser()` maps the verified Access email
to a `users` row and returns only the column, so the individual is discarded at
the door. Every note either partner writes is attributed to the column, and the
byline reads `Bob & Carol` no matter which of them typed it. Three consequences:

- A conversation between three columns reads as three voices when it is really
  up to five people.
- The partner's notes render as `You`, because the frontend decides ownership
  with `post.user_id === meId`.
- Either partner can delete the other's note, for the same reason.

The email that identifies the individual is available at the moment the note is
written; it is simply thrown away.

## Solution

Carry the individual through the discussion feature only. The board, the watched
checkboxes, the watch timers, the episode reveals, and the spoiler gate all stay
column-level — a couple watching together shares one timer and one unlock, and
splitting those would be a much larger change for no benefit.

Two nullable columns hold the whole feature: a per-person display name on
`user_emails`, and the author's email on `posts`.

## Scope

In scope:

- A note's byline names the individual.
- Each person gets their own accent stripe, and the "yours" blue is reserved for
  the caller's own notes.
- The locked-episode author summary names individuals.
- A note can only be deleted by the person who wrote it.

Out of scope:

- Watched checkboxes, `currently_watching_season_id`, watch timers, episode
  reveals, and the spoiler gate — all remain keyed on the column.
- Board column headers — still the household name (`Bob & Carol`), still
  abbreviated to `B & C` on a phone.

## Data

One migration, `0006`, adding two nullable columns.

`user_emails.name` — the individual's display name. `NULL` means the roster has
no individual name for this login, which is the ordinary case for a solo column.
Real names live only in the gitignored `roster.sql`; `roster.example.sql` gains
the column with fake names.

`posts.author_email` — `REFERENCES user_emails(email)`, `NULL` on every existing
row. Every new note stores it unconditionally, even when the roster has no
`name` for that email yet, because the display name is resolved at read time —
so filling a name into `roster.sql` later retroactively fixes bylines already
written.

```
user_emails(email PK COLLATE NOCASE, user_id, name)
  'alice@example.com'  user-1  NULL      -- solo column, falls back to users.name
  'bob@example.com'    user-2  'Bob'
  'carol@example.com'  user-2  'Carol'

posts(..., user_id, author_email)
  user-2  'carol@example.com'  -> byline "Carol"
  user-2  NULL                 -> byline "Bob & Carol"
```

**Name resolution, one rule, server-side**: `user_emails.name` when the post has
an `author_email` whose row carries a name, otherwise `users.name`. That single
fallback covers solo columns, un-named roster entries, a login removed from the
roster, and any note still carrying a `NULL` author.

### Backfilling existing notes

Notes written before this change carry no `author_email`. Nothing in the data
says which partner wrote them, so they will be attributed to one chosen partner
per column. This is a deliberate accepted tradeoff, and it is wrong for some of
them: a note Bob wrote may end up bylined `Carol`, and — since delete becomes
own-note-only — Bob will no longer be able to delete it.

The statement contains real email addresses, so it must not be a committed
migration. It goes in the gitignored roster file, guarded so it only ever
touches un-attributed rows. Every column needs one, not only the shared ones: a
solo column's old notes already byline correctly through the fallback, but
without an `author_email` they have no `author_index` and would render
unstriped.

```sql
-- roster.sql, real emails; illustrated here with the committed fakes
UPDATE posts SET author_email = 'alice@example.com'
 WHERE user_id = 'user-1' AND author_email IS NULL;
UPDATE posts SET author_email = 'bob@example.com'
 WHERE user_id = 'user-2' AND author_email IS NULL;
```

The guard makes it idempotent in practice: after this change every new note is
written with an author, so a re-apply of the roster matches nothing.

## API

`callerUser()` returns the verified email alongside `id` and `name`. It already
computes it.

**`POST /api/seasons/:season_id/episodes/:episode/posts`** — stamps
`author_email` with the caller's email.

**`GET /api/seasons/:season_id/discussion`** — joins posts to `user_emails` and
adds three fields to each serialized post, keeping `user_id`:

- `author_name` — resolved by the rule above.
- `author_index` — the author's position in a flat person list ordered by
  `users.sort_order`, `users.name`, `email`. Deterministic and viewer-
  independent, so a person keeps the same colour across reloads and across
  everyone's screens. `null` when the author's email is no longer in the roster.
- `mine` — computed on the server: true when the post's `author_email` is the
  caller's, and also true for a note with a `NULL` author written by the
  caller's column. It is not inferred by the client from `user_id`, and it
  matches exactly what the delete rule below permits.

`user_id` stays on the wire because `orderPosts` groups by it to infer offsets
for an author who never ran a timer. Timers remain column-level, so that
grouping is still the correct one.

Each episode's `authors` changes from `[user_id]` to `[{ name, mine }]`. It
keeps its existing spoiler-neutral role: naming who wrote on a locked board
reveals nothing the main board does not already show.

Emails are still never serialized to the client.

**`DELETE /api/posts/:post_id`** — narrows to:

```sql
DELETE FROM posts
 WHERE id = ? AND user_id = ? AND (author_email = ? OR author_email IS NULL)
```

The `IS NULL` arm keeps a note that was never attributed — an un-backfilled
database, such as a local dev one — deletable by its column rather than
stranded. A partner's note and a nonexistent id both still return 404, so the
route cannot be used to probe which post ids are real.

## Frontend

`authorAccent` reads the post's `mine` and `author_index` instead of doing a
`findIndex` over the roster. Its rules are otherwise unchanged: `'mine'` for the
caller's own notes, a 1-based slot modulo `ACCENT_SLOTS` otherwise, and `null`
— unstriped — for an author it cannot place. Five accent slots remain enough:
the roster is three columns and at most five people.

`PostList` renders `post.mine ? 'You' : post.author_name` and gates the delete
button on `post.mine`. `EpisodeBoard` filters `ep.authors` on `!a.mine`.

That leaves `SeasonView`'s second request to `/api/board` with nothing to do —
it exists only because the discussion response returns ids and not names.
Removing it also removes `nameOf`, `accentOf`, and the `users` re-merge inside
`fetchDiscussion`, making the season view a single request. The refresh guard is
unaffected.

## Testing

Worker (`test/worker/discussion.test.js`), whose fixture already has an
`Alice` column and a `Bob & Carol` column with two emails:

- Both partners post; each note comes back with its own `author_name` and a
  distinct `author_index`.
- `mine` is true for the caller's own note and false for their partner's.
- A column whose `user_emails.name` is `NULL` falls back to the column name.
- A note whose author is no longer in the roster gets `author_index: null` and
  the column name.
- `authors` on a locked episode names individuals.
- A partner deleting the other's note gets 404; the author's own delete
  succeeds.
- A note with `NULL` author_email stays deletable by either partner.

Frontend (`test/frontend/utils.test.js`): `authorAccent` over the new post
shape — `mine`, a placed author, and an unplaceable one.

Migrations (`test/worker/migrations.test.js`): `user_emails.name` and
`posts.author_email` exist.

## Documentation

`CLAUDE.md` and `README.md` both describe the identity model and the discussion
API; both need the split recorded — including that the column, not the person,
remains the unit for everything outside discussion notes.
