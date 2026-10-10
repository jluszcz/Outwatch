# Outwatch on TV Talk's database — design

## Goal

Outwatch becomes a Survivor-only frontend onto TV Talk (`../TvTalk`). A note
posted in either app appears in the other, and the same is true of every other
piece of Survivor state: watched checkboxes, currently-watching, reveals, watch
timers, offset corrections, episode statuses, reactions, and feed seen marks.
In TV Talk, Survivor is an ordinary show.

Clean factoring is explicitly a non-goal: both projects are private, and
duplicated logic across the two Workers is acceptable.

## Decisions

- **One database.** Outwatch's Worker binds TV Talk's D1 (`tvtalk`). There
  is no sync and no second source of truth. Outwatch's own `outwatch` D1 is
  left untouched after the import, as a backup, and is no longer bound.
- **TV Talk owns the schema.** Only TV Talk's `migrations/` is applied to the
  shared database. Outwatch keeps no migrations of its own.
- **TV Talk's code is unchanged.** Its only change is one new migration that
  adds the Survivor show.
- **Outwatch's API surface is unchanged.** Every `season_id` Outwatch's API
  and frontend use stays the Survivor season _number_ (`#/season/50`,
  `/api/seasons/50/discussion`). The Worker translates a number to TV Talk's
  surrogate `seasons.id` at the edge, so the frontend needs no changes beyond
  anything the port surfaces.
- **The roster is already shared.** Both `roster.sql` files carry identical
  `users` and `user_emails` rows (same `user-N` ids, same emails), so identity
  needs no mapping. From now on the roster is maintained once, in TV Talk.

## TV Talk: migration `0003_survivor.sql`

- Inserts the show `Survivor`, with `url` set to
  `https://en.wikipedia.org/wiki/Survivor_(American_TV_series)`.
- Inserts seasons 1–51 with the subtitles and episode counts from Outwatch
  migrations `0002`, `0005`, and `0012`. Each season's `url` is Outwatch's
  existing `wikipedia_url`, copied verbatim (`Survivor:_Borneo` for seasons
  1–40, `Survivor_<n>` from 41 on).
  This gives local dev and both test suites the same reference data Outwatch
  has today.
- Before applying it to production, confirm that TV Talk production has no
  show already named `Survivor`. The `UNIQUE` constraint on `shows.name`
  would fail the migration.

## Outwatch Worker port (`src/index.js`)

The Survivor show is identified by name (`'Survivor'`), not by id, because the
autoincrement id is not guaranteed to match across local, test, and
production. Renaming the show in TV Talk would break Outwatch, which is
accepted and documented.

- **Season resolution.** `resolveEpisode` and every route that takes
  `:season_id` look up `seasons.id` by `(Survivor show, number = :season_id)`.
  A number with no Survivor season is a 404, as it is today. Internally the
  surrogate id is used. Every response maps it back to the number: the board,
  the discussion's `season`, feed events, and the season create and edit
  responses.
- **Board.** `seasons` contains only Survivor seasons and returns `id` (the
  number), `subtitle`, `wikipedia_url` (from `seasons.url`), `episode_count`,
  `watched_by`, and `post_count`. Each user's `currently_watching_season_id`
  comes from that user's `currently_watching` row for the Survivor show,
  mapped to a number.
- **`PUT /api/currently-watching`.** Writes or deletes the
  `currently_watching` row for `(caller, Survivor)`. The "already watched →
  409" rule stays, and so does its single-statement guard against a
  concurrent `POST /api/watched`.
- **`POST /api/watched`.** Clears the caller's Survivor `currently_watching`
  row in the same batch, instead of nulling a `users` column.
- **`POST /api/seasons`.** Inserts `(Survivor, number)`, where `number` must
  equal `MAX(number) + 1` among Survivor seasons. As today, the check is part
  of the `INSERT` itself, and anything else is a 409. `url` is derived. The
  bounds stay Outwatch's own (`MAX_EPISODE_COUNT` 30). TV Talk allows 50, so
  a Survivor season edited in TV Talk can exceed Outwatch's input bound; that
  is harmless, because the bound applies only to Outwatch's input.
- **`PATCH /api/seasons/:season_id`.** Same validation and shrink guard as
  today, applied to the resolved row.
- **Post-scoped routes** (`PATCH`/`DELETE /api/posts/:post_id`,
  `PUT .../reactions`) also require the post's season to belong to Survivor,
  and answer 404 otherwise. Outwatch never shows other shows' notes, so it
  should not edit them either.
- **Feed.** `GET /api/feed` counts and lists only notes on Survivor seasons.
  `feed_seen_at` lives on the shared `user_emails` row, so opening the bell in
  either app clears the unread state in both. That is accepted: a person
  opening the bell in Outwatch also stops being told about other shows' notes
  in TV Talk until something newer arrives.
- **Unchanged.** The spoiler rule, ownership, timers, offsets, statuses, and
  reactions keep their logic. Their queries only receive the surrogate id.

## Outwatch configuration and tests

- `wrangler.toml`: `[[d1_databases]]` points at `database_name = "tvtalk"` and
  TV Talk's `database_id`. `migrations_dir` points at the schema snapshot
  below, and a comment says never to run `migrations apply --remote` from
  this repo.
- `migrations/` is replaced with a byte-identical copy of TV Talk's
  `migrations/` (including `0003_survivor.sql`). Identical filenames mean an
  accidental apply from Outwatch is a no-op against D1's `d1_migrations`
  table, local dev gets the real schema via
  `wrangler d1 migrations apply tvtalk --local`, and CI — which checks out
  only this repo — can still run the Worker tests. When TV Talk adds a
  migration, it is copied over by hand. A drifted copy shows up as failing
  tests, not as a production problem.
- `test/worker/migrations.test.js` is rewritten. It no longer asserts
  Outwatch's migration history. Instead it checks that the Survivor show
  exists with 51 seeded seasons and plausible episode counts. The existing
  episode-count assertions move here.
- The other Worker suites keep their assertions. Their fixtures change only
  where they insert rows directly (season ids become looked-up surrogate ids,
  and `users.currently_watching_season_id` becomes `currently_watching`).
  `seed.sql` and `scripts/insert-test-post.py` get the same treatment.
- `roster.sql` and `roster.example.sql`: the backfill `UPDATE`s for
  pre-attribution notes move to the import (below). The README points roster
  edits at TV Talk.

## One-time data import

`scripts/import-to-tvtalk.py` is stdlib Python, matching
`insert-test-post.py`. It reads an Outwatch export and the current TV Talk
production state, and writes a SQL file that is reviewed, then executed with
`wrangler d1 execute tvtalk --remote --file=…`.

1. `wrangler d1 export outwatch --remote --output=outwatch.sql`, loaded into
   a scratch SQLite database.
2. The script queries TV Talk production for the Survivor show id, its
   seasons' ids by number, and `MAX(posts.id)`. These are passed in as
   arguments or a small JSON file captured with `wrangler d1 execute --json`.
3. The generated SQL, in dependency order:
   - **seasons:** upsert every Outwatch season by `(Survivor, number)`,
     taking Outwatch's `subtitle` and `episode_count`. This captures seasons
     added after 51 and any edits made in production.
   - `watched`, then `currently_watching`, from
     `users.currently_watching_season_id`.
   - **posts:** inserted with explicit ids `old_id + max_post_id` and
     `season_id` remapped. `reply_to_post_id` gets the same offset.
   - **reactions:** `post_id` gets the same offset.
   - `reveals`, `watch_sessions`, `watch_offsets`, `episode_statuses`:
     `season_id` remapped.
   - `user_emails.feed_seen_at`: set to the later of the two values.
4. **Dry run:** run the same script against a local TV Talk database (TV Talk
   migrations plus roster), then load both apps locally against it and
   compare a few seasons' boards and discussions with production Outwatch.

### Cutover order

Writes to Outwatch between the export and the deploy would be lost. With a
group this small, the plan is to announce a short window rather than build a
read-only mode.

1. Apply `0003_survivor.sql` to TV Talk production.
2. Export Outwatch production. Generate the import, review it, execute it
   against `tvtalk --remote`.
3. `npm run deploy` Outwatch with the new binding.
4. Spot-check both apps.

To roll back, redeploy the previous Outwatch commit. It is still bound to the
untouched `outwatch` database, so nothing written to TV Talk in the meantime
carries over.

## Documentation

- Outwatch `AGENTS.md`: the project overview, schema section (now "TV Talk's
  schema, scoped to the Survivor show"), migration instructions, and roster
  rules are updated. The API routes keep their contracts, and the doc gains a
  note on the number ↔ surrogate id translation.
- Outwatch `README.md`: setup points at TV Talk's database and roster.
- TV Talk `AGENTS.md`: one paragraph saying Outwatch reads and writes the
  same database. A schema change has to be copied into Outwatch's
  `migrations/` and must keep Outwatch's queries working, and the show name
  `Survivor` is load-bearing.

## Out of scope

- Any change to TV Talk's UI or API.
- Keeping the two Workers' shared logic in one place.
- Deleting the `outwatch` D1 database. That is a manual step for later, once
  the cutover has held.
