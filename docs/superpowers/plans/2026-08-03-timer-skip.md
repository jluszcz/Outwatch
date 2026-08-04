# Live Timer Skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a forward-only "skip" timer action that resyncs a watcher's live
timer (e.g. after skipping filler) without moving notes already posted, plus a
"stop" action that ends a session on demand, and a `WatchTimer` UI whose
adjust panel is modal on session state — Skip while a session is live,
Correct once it isn't.

**Architecture:** Two new actions on the existing
`POST /api/seasons/:season_id/episodes/:episode/timer` route. `skip` bumps
`watch_sessions.elapsed_secs` directly (no new table, no read-time overlay),
so already-frozen `posts.offset_secs` values are untouched and only posts
written after the skip pick it up. `stop` deletes the session row, idempotent.
The frontend's `±` panel branches on whether a session is live to decide which
controls to show, replacing nothing about the existing retroactive correction
(`PUT .../offset`) when no session exists.

**Tech Stack:** Hono + D1 (Cloudflare Workers) backend, Preact + htm frontend,
Zod validation, Vitest (`@cloudflare/vitest-pool-workers` for worker tests).

## Global Constraints

- `delta_secs` for `skip` is a nonzero integer bounded by `MAX_SKIP_DELTA_SECS`
  (3600, its own constant — do not reuse `MAX_OFFSET_ADJUST_SECS`) in
  `shared/session.js`.
- No new table and no migration — `skip` mutates `watch_sessions.elapsed_secs`
  directly; `stop` deletes the row.
- Before every commit: `npm run build`, `npm test`, `npm run lint`,
  `npm run format:check` must all pass.
- This repo has no DOM test suite for the frontend (`frontend/CLAUDE.md`) —
  UI changes are verified manually against a running `npm run dev`, not with
  an automated test.
- Never commit real names or emails; the standard placeholder cast
  (`Alice`, `Bob & Carol`, `Dave & Erin`) is already what the worker test
  fixtures use — keep using it.

---

## Task 1: Backend — `skip` timer action

**Files:**
- Modify: `shared/session.js` (add `MAX_SKIP_DELTA_SECS`)
- Modify: `src/index.js:6` (import), `src/index.js:32-36` (`timerAction` schema), `src/index.js:992-1019` (pause/resume handler branch)
- Test: `test/worker/discussion.test.js` (new `describe` block after line 642)

**Interfaces:**
- Produces: `MAX_SKIP_DELTA_SECS` (exported constant, `shared/session.js`), consumed by `src/index.js`'s `timerAction` schema. Not needed by the frontend (see Task 3).
- Produces: `POST /api/seasons/:season_id/episodes/:episode/timer` accepts `{ action: 'skip', delta_secs: number }` in addition to the existing three actions, returning the same `{ success, season_id, episode, session, offset_secs }` shape the other actions already return.

- [ ] **Step 1: Write the failing tests**

Add to `test/worker/discussion.test.js`, immediately after the existing
`describe('POST /api/seasons/:season_id/episodes/:episode/timer', ...)` block
closes (after line 642, before the `// postNote, revealEpisode, ...` comment):

```javascript
const skip = (email, episode, delta_secs) =>
    req('POST', `/api/seasons/45/episodes/${episode}/timer`, {
        body: { action: 'skip', delta_secs },
        email,
    });

describe('POST /api/seasons/:season_id/episodes/:episode/timer { action: "skip" }', () => {
    it('advances elapsed_secs by delta_secs while paused', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare(
            'UPDATE watch_sessions SET elapsed_secs = 300, running_since = NULL WHERE user_id = ?',
        )
            .bind('user-alice')
            .run();

        const { session } = await (await skip('alice@example.com', 7, 60)).json();
        expect(session.elapsed_secs).toBe(360);
        expect(session.running_since).toBeNull();
    });

    it('advances elapsed_secs while running, without touching running_since', async () => {
        const { session: started } = await (await timer('alice@example.com', 7, 'start')).json();

        const { session, offset_secs } = await (await skip('alice@example.com', 7, 120)).json();
        expect(session.elapsed_secs).toBe(120);
        expect(session.running_since).toBe(started.running_since);
        expect(offset_secs).toBeGreaterThanOrEqual(120);
        expect(offset_secs).toBeLessThan(125);
    });

    it('supports a backward skip', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare(
            'UPDATE watch_sessions SET elapsed_secs = 300, running_since = NULL WHERE user_id = ?',
        )
            .bind('user-alice')
            .run();

        const { session } = await (await skip('alice@example.com', 7, -60)).json();
        expect(session.elapsed_secs).toBe(240);
    });

    it('clamps a backward skip at zero rather than going negative', async () => {
        await timer('alice@example.com', 7, 'start');
        await env.DB.prepare(
            'UPDATE watch_sessions SET elapsed_secs = 30, running_since = NULL WHERE user_id = ?',
        )
            .bind('user-alice')
            .run();

        const { session } = await (await skip('alice@example.com', 7, -100)).json();
        expect(session.elapsed_secs).toBe(0);
    });

    it('rejects a zero delta_secs, a non-integer, and a value beyond the bound', async () => {
        await timer('alice@example.com', 7, 'start');
        for (const delta_secs of [0, 12.5, 3601, -3601]) {
            const r = await skip('alice@example.com', 7, delta_secs);
            expect(r.status).toBe(400);
        }
    });

    it('requires delta_secs for a skip action', async () => {
        const r = await req('POST', '/api/seasons/45/episodes/7/timer', {
            body: { action: 'skip' },
            email: 'alice@example.com',
        });
        expect(r.status).toBe(400);
    });

    it('refuses to skip with no session', async () => {
        const r = await skip('alice@example.com', 7, 60);
        expect(r.status).toBe(409);
    });

    it('refuses to skip a stale session and leaves it untouched', async () => {
        await timer('alice@example.com', 7, 'start');
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('UPDATE watch_sessions SET running_since = ?, last_activity_at = ?')
            .bind(stale, stale)
            .run();

        const r = await skip('alice@example.com', 7, 60);
        expect(r.status).toBe(409);
        const { error } = await r.json();
        expect(error).toMatch(/expired/i);

        const row = await env.DB.prepare(
            'SELECT elapsed_secs, running_since FROM watch_sessions WHERE user_id = ?',
        )
            .bind('user-alice')
            .first();
        expect(row.elapsed_secs).toBe(0);
        expect(row.running_since).toBe(stale);
    });

    // The core behavior this whole feature is for: a skip must never reach
    // back and move a note that already froze its offset_secs.
    it('leaves a note posted before the skip unmoved, and shifts one posted after it', async () => {
        await timer('alice@example.com', 7, 'start');
        const { post: before } = await (
            await post('alice@example.com', 7, 'before the skip')
        ).json();
        expect(before.offset_secs).toBeLessThan(5);

        await skip('alice@example.com', 7, 300);

        const { post: after } = await (await post('alice@example.com', 7, 'after the skip')).json();
        expect(after.offset_secs).toBeGreaterThanOrEqual(300);
        expect(after.offset_secs).toBeLessThan(305);

        const row = await env.DB.prepare('SELECT offset_secs FROM posts WHERE id = ?')
            .bind(before.id)
            .first();
        expect(row.offset_secs).toBe(before.offset_secs);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- discussion.test.js`
Expected: FAIL — `action` rejects `'skip'` as not in the enum (400 where the
tests expect 200/409), and `delta_secs` is not a recognized field.

- [ ] **Step 3: Add `MAX_SKIP_DELTA_SECS`**

In `shared/session.js`, immediately after the existing
`MAX_OFFSET_ADJUST_SECS` export:

```javascript
// The largest single skip anyone may apply to a live timer, in seconds either
// direction. Its own constant rather than reusing MAX_OFFSET_ADJUST_SECS: the
// two bound different things — one a correction to an episode's zero point,
// the other a single live jump — and only happen to start out at the same
// value.
export const MAX_SKIP_DELTA_SECS = 3600;
```

- [ ] **Step 4: Update the import in `src/index.js`**

`src/index.js:6`, change:

```javascript
import { sessionOffsetSecs, MAX_OFFSET_ADJUST_SECS } from '../shared/session.js';
```

to:

```javascript
import { sessionOffsetSecs, MAX_OFFSET_ADJUST_SECS, MAX_SKIP_DELTA_SECS } from '../shared/session.js';
```

- [ ] **Step 5: Extend the `timerAction` schema**

`src/index.js:32-36`, replace:

```javascript
const timerAction = z.object({
    action: z.enum(['start', 'pause', 'resume'], {
        message: 'action must be start, pause, or resume',
    }),
});
```

with:

```javascript
const timerAction = z
    .object({
        action: z.enum(['start', 'pause', 'resume', 'skip'], {
            message: 'action must be start, pause, resume, or skip',
        }),
        delta_secs: z
            .number()
            .int({ message: 'delta_secs must be a whole number of seconds' })
            .min(-MAX_SKIP_DELTA_SECS, {
                message: `delta_secs must be within ${MAX_SKIP_DELTA_SECS} seconds of zero`,
            })
            .max(MAX_SKIP_DELTA_SECS, {
                message: `delta_secs must be within ${MAX_SKIP_DELTA_SECS} seconds of zero`,
            })
            .refine((v) => v !== 0, { message: 'delta_secs must not be zero' })
            .optional(),
    })
    .refine((data) => data.action !== 'skip' || data.delta_secs !== undefined, {
        message: 'delta_secs is required for a skip action',
        path: ['delta_secs'],
    });
```

- [ ] **Step 6: Handle `skip` in the timer route**

`src/index.js:992-1019`, replace:

```javascript
            if (action === 'pause') {
                // Bank the running segment using the same total a read would
                // report. Guarded on running_since so a double pause cannot
                // bank the same stretch twice — a session already paused is
                // left untouched.
                if (existing.running_since !== null) {
                    await c.env.DB.prepare(
                        `UPDATE watch_sessions
                         SET elapsed_secs = ?, running_since = NULL, last_activity_at = ?
                         WHERE user_id = ? AND season_id = ? AND episode = ?
                           AND running_since IS NOT NULL`,
                    )
                        .bind(banked, now, ...key)
                        .run();
                }
            } else {
                // Resume only restarts the clock; the banked total is
                // untouched. A session already running is left untouched.
                if (existing.running_since === null) {
                    await c.env.DB.prepare(
                        `UPDATE watch_sessions SET running_since = ?, last_activity_at = ?
                         WHERE user_id = ? AND season_id = ? AND episode = ? AND running_since IS NULL`,
                    )
                        .bind(now, now, ...key)
                        .run();
                }
            }
```

with:

```javascript
            if (action === 'pause') {
                // Bank the running segment using the same total a read would
                // report. Guarded on running_since so a double pause cannot
                // bank the same stretch twice — a session already paused is
                // left untouched.
                if (existing.running_since !== null) {
                    await c.env.DB.prepare(
                        `UPDATE watch_sessions
                         SET elapsed_secs = ?, running_since = NULL, last_activity_at = ?
                         WHERE user_id = ? AND season_id = ? AND episode = ?
                           AND running_since IS NOT NULL`,
                    )
                        .bind(banked, now, ...key)
                        .run();
                }
            } else if (action === 'resume') {
                // Resume only restarts the clock; the banked total is
                // untouched. A session already running is left untouched.
                if (existing.running_since === null) {
                    await c.env.DB.prepare(
                        `UPDATE watch_sessions SET running_since = ?, last_activity_at = ?
                         WHERE user_id = ? AND season_id = ? AND episode = ? AND running_since IS NULL`,
                    )
                        .bind(now, now, ...key)
                        .run();
                }
            } else {
                // Skip jumps elapsed_secs by delta_secs, forward or backward,
                // whether the session is running or paused — the total a read
                // reports is elapsed_secs plus whatever the running segment
                // adds (shared/session.js), so bumping elapsed_secs moves
                // that total regardless of state, and running_since needs no
                // change. The floor at zero mirrors the running segment's own
                // clamp: a skip back further than the session has banked
                // lands at zero rather than going negative. Nothing here
                // touches posts.offset_secs — that's frozen at write time
                // (see currentOffsetSecs above), which is what keeps this
                // forward-only: only a post written after this update reads
                // the new elapsed_secs.
                const { delta_secs } = c.req.valid('json');
                await c.env.DB.prepare(
                    `UPDATE watch_sessions
                     SET elapsed_secs = MAX(0, elapsed_secs + ?), last_activity_at = ?
                     WHERE user_id = ? AND season_id = ? AND episode = ?`,
                )
                    .bind(delta_secs, now, ...key)
                    .run();
            }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- discussion.test.js`
Expected: PASS — all new `skip` tests green, and every pre-existing test in
this file still passes (in particular, `start`/`pause`/`resume` behavior is
untouched).

- [ ] **Step 8: Validate and commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

```bash
git add shared/session.js src/index.js test/worker/discussion.test.js
git commit -m "feat: add a skip timer action for live drift correction"
```

---

## Task 2: Backend — `stop` timer action

**Files:**
- Modify: `src/index.js:931-935` (route comment), `src/index.js:32-36` (schema enum), `src/index.js:952-965` (outer `start`/else split), `src/index.js:638-641` (existing test that used `'stop'` as an invalid action)
- Test: `test/worker/discussion.test.js` (new `describe` block appended after Task 1's `skip` block)

**Interfaces:**
- Consumes: nothing from Task 1 beyond the already-extended `timerAction` schema shape.
- Produces: `POST .../timer { action: 'stop' }` → `{ success: true, season_id, episode, session: null, offset_secs: null }`, idempotent regardless of whether a session existed. This is the same "no session" shape `GET .../discussion` already serializes (`src/index.js:634-640`), so Task 3's frontend needs no new response-shape handling for it.

- [ ] **Step 1: Write the failing tests**

First, fix the now-inaccurate existing test. `src/index.js` test file
`test/worker/discussion.test.js:638-641`, replace:

```javascript
    it('returns 400 for an unknown action and 403 for a stranger', async () => {
        expect((await timer('alice@example.com', 7, 'stop')).status).toBe(400);
        expect((await timer('stranger@example.com', 7, 'start')).status).toBe(403);
    });
```

with:

```javascript
    it('returns 400 for an unknown action and 403 for a stranger', async () => {
        expect((await timer('alice@example.com', 7, 'bogus')).status).toBe(400);
        expect((await timer('stranger@example.com', 7, 'start')).status).toBe(403);
    });
```

Then append a new `describe` block after the `skip` block Task 1 added:

```javascript
describe('POST /api/seasons/:season_id/episodes/:episode/timer { action: "stop" }', () => {
    it('deletes the session', async () => {
        await timer('alice@example.com', 7, 'start');
        const r = await timer('alice@example.com', 7, 'stop');
        expect(r.status).toBe(200);
        const { session, offset_secs } = await r.json();
        expect(session).toBeNull();
        expect(offset_secs).toBeNull();

        const row = await env.DB.prepare('SELECT * FROM watch_sessions WHERE user_id = ?')
            .bind('user-alice')
            .first();
        expect(row).toBeNull();
    });

    it('is idempotent with no session to stop', async () => {
        const r = await timer('alice@example.com', 7, 'stop');
        expect(r.status).toBe(200);
        const { session } = await r.json();
        expect(session).toBeNull();
    });

    it('is idempotent when called twice', async () => {
        await timer('alice@example.com', 7, 'start');
        await timer('alice@example.com', 7, 'stop');
        const r = await timer('alice@example.com', 7, 'stop');
        expect(r.status).toBe(200);
    });

    it('makes a note posted afterward untimed', async () => {
        await timer('alice@example.com', 7, 'start');
        await timer('alice@example.com', 7, 'stop');
        const { post: note } = await (await post('alice@example.com', 7, 'after stop')).json();
        expect(note.offset_secs).toBeNull();
    });

    it('leaves an existing retroactive correction untouched', async () => {
        await timer('alice@example.com', 7, 'start');
        await req('PUT', '/api/seasons/45/episodes/7/offset', {
            body: { adjust_secs: 45 },
            email: 'alice@example.com',
        });

        await timer('alice@example.com', 7, 'stop');

        const row = await env.DB.prepare('SELECT adjust_secs FROM watch_offsets WHERE user_id = ?')
            .bind('user-alice')
            .first();
        expect(row.adjust_secs).toBe(45);
    });

    it('403s for a stranger', async () => {
        expect((await timer('stranger@example.com', 7, 'stop')).status).toBe(403);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- discussion.test.js`
Expected: FAIL — `'stop'` is rejected as an invalid action (400 where 200 is
expected).

- [ ] **Step 3: Extend the schema's action enum**

`src/index.js`, in the `timerAction` schema Task 1 wrote, change:

```javascript
        action: z.enum(['start', 'pause', 'resume', 'skip'], {
            message: 'action must be start, pause, resume, or skip',
        }),
```

to:

```javascript
        action: z.enum(['start', 'pause', 'resume', 'skip', 'stop'], {
            message: 'action must be start, pause, resume, skip, or stop',
        }),
```

- [ ] **Step 4: Update the route's leading comment**

`src/index.js:931-935`, replace:

```javascript
// The watch timer. There is no stop action: a session simply goes stale after
// three hours without a start, pause, resume, or post (see shared/session.js).
// Sessions are per (user, episode) and deliberately not mutually exclusive —
// a forgotten one on another episode is harmless, because offsets freeze onto
// the post at write time and the stale session stamps nothing.
```

with:

```javascript
// The watch timer. A session also goes stale after three hours without a
// start, pause, resume, or post (see shared/session.js) — stop is the
// explicit, on-demand way to reach that same "no session" state, for whoever
// doesn't want to wait three hours for the retroactive correction
// (PUT .../offset) to become reachable in the UI. Sessions are per (user,
// episode) and deliberately not mutually exclusive — a forgotten one on
// another episode is harmless, because offsets freeze onto the post at write
// time and the stale session stamps nothing.
```

- [ ] **Step 5: Add the `stop` branch to the handler**

`src/index.js:952-965`, replace:

```javascript
        if (action === 'start') {
            // Starting again zeroes the session — it is the "I'm beginning this
            // episode" action, not a resume.
            await c.env.DB.prepare(
                `INSERT INTO watch_sessions
                     (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at)
                 VALUES (?, ?, ?, 0, ?, ?)
                 ON CONFLICT (user_id, season_id, episode) DO UPDATE SET
                     elapsed_secs = 0, running_since = excluded.running_since,
                     last_activity_at = excluded.last_activity_at`,
            )
                .bind(...key, now, now)
                .run();
        } else {
```

with:

```javascript
        if (action === 'start') {
            // Starting again zeroes the session — it is the "I'm beginning this
            // episode" action, not a resume.
            await c.env.DB.prepare(
                `INSERT INTO watch_sessions
                     (user_id, season_id, episode, elapsed_secs, running_since, last_activity_at)
                 VALUES (?, ?, ?, 0, ?, ?)
                 ON CONFLICT (user_id, season_id, episode) DO UPDATE SET
                     elapsed_secs = 0, running_since = excluded.running_since,
                     last_activity_at = excluded.last_activity_at`,
            )
                .bind(...key, now, now)
                .run();
        } else if (action === 'stop') {
            // Idempotent: deleting a row that's already gone, or was never
            // there, is still success — the caller only cares that there's no
            // session afterward. Returns straight away rather than falling
            // into the shared session/offset_secs response below, since
            // there's no row left to select back.
            await c.env.DB.prepare(
                `DELETE FROM watch_sessions WHERE user_id = ? AND season_id = ? AND episode = ?`,
            )
                .bind(...key)
                .run();
            return c.json({
                success: true,
                season_id: season.id,
                episode,
                session: null,
                offset_secs: null,
            });
        } else {
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- discussion.test.js`
Expected: PASS — every test in the file, including Task 1's `skip` tests and
the fixed `'bogus'` test.

- [ ] **Step 7: Validate and commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

```bash
git add src/index.js test/worker/discussion.test.js
git commit -m "feat: add a stop timer action to reach 'no session' on demand"
```

---

## Task 3: Frontend — wire skip/stop and make the adjust panel modal

**Files:**
- Modify: `frontend/icons.js` (add an `info` icon)
- Modify: `frontend/discussion.js` (import, `setTimerSkip`, prop threading, full `WatchTimer` rewrite)
- Modify: `frontend/styles.css` (new rules for the info toggle/text, mobile touch target)

**Interfaces:**
- Consumes: `POST .../timer { action: 'skip', delta_secs }` and `{ action: 'stop' }` from Tasks 1–2. No new import of `MAX_SKIP_DELTA_SECS` needed client-side — every skip tap sends a fixed ±15/±60, always well inside the server's bound, so there's nothing to clamp on this side.
- Produces: `WatchTimer` gains an `onSkip: (deltaSecs) => Promise<boolean>` prop, called by four new buttons; the existing `onAction`, `onAdjust`, `session`, `adjustSecs`, `serverSkewMs` props are unchanged in shape.

- [ ] **Step 1: Add an `info` icon**

`frontend/icons.js:3-14`, add `Info` to the import:

```javascript
import {
    Bell,
    ChevronLeft,
    Info,
    MessageCircle,
    MoreHorizontal,
    Moon,
    Pencil,
    Reply,
    Sun,
    Trash2,
    X,
} from 'lucide-preact';
```

`frontend/icons.js:29-40`, add to the `ICONS` map:

```javascript
const ICONS = {
    dots: MoreHorizontal,
    x: X,
    chevronLeft: ChevronLeft,
    chat: MessageCircle,
    reply: Reply,
    pencil: Pencil,
    trash: Trash2,
    bell: Bell,
    sun: Sun,
    moon: Moon,
    info: Info,
};
```

- [ ] **Step 2: Import `Icon` in `discussion.js`**

`frontend/discussion.js:17-18`, change:

```javascript
import { PostList } from './post.js';
import { prefersReducedMotion } from './board.js';
```

to:

```javascript
import { PostList } from './post.js';
import { prefersReducedMotion } from './board.js';
import { Icon } from './icons.js';
```

- [ ] **Step 3: Add `setTimerSkip` and wire it through `SeasonView`**

`frontend/discussion.js:174-186`, immediately after the existing
`setOffsetAdjust` definition, add:

```javascript
    // Skip sends its own delta rather than an absolute total the way
    // setOffsetAdjust does: each tap is a distinct, intentional jump — the
    // same as pause banking a running segment — not a display total to
    // converge on, so there's no accumulation-on-retry hazard for an
    // absolute value to guard against. See WatchTimer's applySkip for how a
    // failed tap still reverts exactly, regardless of what order two
    // overlapping taps' responses land in.
    const setTimerSkip = (episode, deltaSecs) =>
        mutate(
            () =>
                api(`/api/seasons/${seasonId}/episodes/${episode}/timer`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'skip', delta_secs: deltaSecs }),
                }),
            { suppressError: (err) => err.status === 409 },
        );
```

Then `frontend/discussion.js:240-241` (the `EpisodeBoard` props inside
`SeasonView`'s render), change:

```javascript
                            onTimer=${setTimer}
                            onOffsetAdjust=${setOffsetAdjust}
```

to:

```javascript
                            onTimer=${setTimer}
                            onOffsetAdjust=${setOffsetAdjust}
                            onSkip=${setTimerSkip}
```

- [ ] **Step 4: Thread `onSkip` through `EpisodeBoard`**

`frontend/discussion.js:251-264` (the `EpisodeBoard` function signature),
change:

```javascript
function EpisodeBoard({
    ep,
    meId,
    serverSkewMs,
    open,
    onToggle,
    onReveal,
    onPost,
    onDelete,
    onEdit,
    onReact,
    onTimer,
    onOffsetAdjust,
}) {
```

to:

```javascript
function EpisodeBoard({
    ep,
    meId,
    serverSkewMs,
    open,
    onToggle,
    onReveal,
    onPost,
    onDelete,
    onEdit,
    onReact,
    onTimer,
    onOffsetAdjust,
    onSkip,
}) {
```

`frontend/discussion.js:366-374` (where `WatchTimer` is instantiated), change:

```javascript
                                        meId &&
                                        html`<${WatchTimer}
                                            session=${ep.session}
                                            adjustSecs=${ep.adjust_secs ?? 0}
                                            serverSkewMs=${serverSkewMs}
                                            onAction=${(action) => onTimer(ep.episode, action)}
                                            onAdjust=${(secs) => onOffsetAdjust(ep.episode, secs)}
                                        />`
```

to:

```javascript
                                        meId &&
                                        html`<${WatchTimer}
                                            session=${ep.session}
                                            adjustSecs=${ep.adjust_secs ?? 0}
                                            serverSkewMs=${serverSkewMs}
                                            onAction=${(action) => onTimer(ep.episode, action)}
                                            onAdjust=${(secs) => onOffsetAdjust(ep.episode, secs)}
                                            onSkip=${(delta) => onSkip(ep.episode, delta)}
                                        />`
```

- [ ] **Step 5: Rewrite `WatchTimer`**

`frontend/discussion.js:415-589` (the whole `WatchTimer` component, from the
comment starting `// The ticking chip.` through the function's closing
`` ` `` and `}`), replace entirely with:

```javascript
// The ticking chip. It re-derives the offset from the server's session every
// second rather than counting locally, so a pause, a reload, or a second device
// all land on the same number. It stops at the same three-hour staleness point
// the server uses (shared/session.js), because showing a number the server would
// refuse to stamp would be a promise the post cannot keep.
//
// The ± button opens a panel whose contents are modal on whether a session is
// live — not a manual switch, because the two things it can show disagree
// about what an already-posted note should do, and modality means there's no
// state where the wrong one is a single accidental tap away from the right
// one:
//
// - Live session → Skip: jumps the timer itself (POST .../timer
//   {action:'skip'}), forward or back, without moving anything already
//   posted — the point is to keep pace with the show, not to relitigate
//   notes that already landed correctly.
// - No session (never started, Stopped, or gone stale) → Correct: the
//   original retroactive nudge, unchanged. It moves every note on the
//   episode, including ones already posted, which is exactly right once
//   there's no "going forward" left to distinguish from "already posted."
//
// Stop, beside Restart, is the deliberate way to reach "no session" without
// waiting three hours for staleness — it's what makes Correct reachable on
// demand once you're done watching.
function WatchTimer({ session, adjustSecs, serverSkewMs, onAction, onAdjust, onSkip }) {
    const [tick, setTick] = useState(0);
    // Local to the timer and deliberately not episode-scoped state up in
    // EpisodeBoard: the row belongs to this control, and nothing outside it
    // needs to know whether it is open.
    const [adjusting, setAdjusting] = useState(false);
    // Whether the panel's short explanation is showing. Also local — it dies
    // with the panel, and the panel dies with `adjusting`.
    const [infoOpen, setInfoOpen] = useState(false);

    // The running total taps accumulate against, seeded from the server's
    // adjust_secs and reconciled below. Not read straight off the adjustSecs
    // prop: mutate() (SeasonView) awaits the PUT and then a refetch that
    // useRefreshGuard defers until every in-flight mutation settles
    // (refresh-guard.js), so the prop can lag a tap by two full round trips.
    // A second tap inside that window would read the same not-yet-updated
    // prop, compute the same total the first tap already sent, and be
    // silently dropped by the `next === current` no-op check below — this
    // local copy is what makes each tap see the previous one's result.
    const [pendingAdjust, setPendingAdjust] = useState(adjustSecs);

    // The last value this component knows the server actually holds, read by
    // nudge/reset below to undo an optimistic update a failed PUT never
    // committed. A ref rather than the adjustSecs prop directly: by the time
    // a rejected request's `await` settles, this component may have
    // re-rendered on a newer prop value, and the closure captured at click
    // time would restore that stale snapshot instead of the current one.
    // Advanced by a successful PUT as well as by the effect below, because the
    // refetch that would carry the new value back into the prop can fail on its
    // own (useRefreshGuard swallows it) — leaving this ref, and so the
    // restore-on-failure path, pointing at a value the server no longer holds
    // until some later refetch succeeds.
    const adjustSecsRef = useRef(adjustSecs);

    // Reconciles once the server's value genuinely changes underneath this
    // component — another device adjusted the same episode, or a later
    // load/focus refetch. Keyed on adjustSecs rather than syncing every
    // render: the eventual echo of a value this component already applied
    // leaves the prop unchanged, so the effect does not re-fire for it and
    // does not clobber a tap made in the meantime. This does not by itself
    // cover a failed PUT — that leaves the server's value, and so this prop,
    // unchanged, which is exactly why nudge/reset below restore from
    // adjustSecsRef explicitly rather than waiting on this effect to notice
    // anything.
    useEffect(() => {
        adjustSecsRef.current = adjustSecs;
        setPendingAdjust(adjustSecs);
    }, [adjustSecs]);

    // The skip amount not yet reflected in the session prop. Unlike
    // pendingAdjust there's no separate stored total to seed from or settle
    // to: a skip is folded straight into elapsed_secs server-side, so once a
    // fresh session prop arrives it already carries every skip that's landed
    // — at which point this resets to zero. Keyed on the session's own
    // primitives rather than the object reference, which changes on every
    // refetch (focus, another mutation) whether or not this episode's
    // session actually moved.
    const [pendingSkip, setPendingSkip] = useState(0);
    useEffect(() => {
        setPendingSkip(0);
    }, [session?.elapsed_secs, session?.running_since]);

    useEffect(() => {
        if (!session?.running_since) return;
        const id = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [session?.running_since]);

    const rawOffset = sessionOffsetSecs(session, Date.now() + serverSkewMs, pendingAdjust);
    const offset = rawOffset === null ? null : rawOffset + pendingSkip;
    // `tick` only exists to force this re-render each second.
    void tick;

    // Which nudge is the newest — the same generation-counter pattern
    // refresh-guard.js uses to keep an out-of-order fetch response from
    // overwriting a newer one (there, `startFetch`/`isCurrent`; here, one ref
    // instead of a whole guard object, since only one thing — pendingAdjust —
    // is ever being decided). Two taps close together send two PUTs that can
    // resolve in either order; without this, a slow failure landing after a
    // fast success would restore pendingAdjust to the pre-failure value and
    // stomp a result the server had already confirmed.
    const nudgeSeqRef = useRef(0);

    // Applies a new total optimistically, then settles it once the request
    // that carries it comes back — but only if this is still the newest
    // nudge in flight; see nudgeSeqRef above. `onAdjust` resolves `mutate`'s
    // own success boolean (SeasonView), so there is nothing to poll: a
    // rejected PUT already left an error banner up in SeasonView, this just
    // stops the control from disagreeing with it once the dust settles.
    const applyAdjust = async (next) => {
        setPendingAdjust(next);
        const seq = (nudgeSeqRef.current += 1);
        const ok = await onAdjust(next);
        const settled = settledAdjust(seq === nudgeSeqRef.current, ok, next, adjustSecsRef.current);
        // Whatever this settles on is also the best thing known about the
        // server: `next` if it accepted the value, the previous known-stored
        // value if it didn't (a no-op assignment), and nothing at all if a
        // newer nudge has taken over — that one settles the ref itself, and an
        // older response must not speak for it here either.
        if (settled !== undefined) {
            adjustSecsRef.current = settled;
            setPendingAdjust(settled);
        }
    };

    // Clamped here as well as server-side so a run of taps stops at the limit
    // instead of collecting a 400 banner per tap. Against pendingAdjust, not
    // the prop, so consecutive taps within one round trip accumulate instead
    // of each computing the same total from a stale base.
    const nudgeAdjust = (delta) => {
        const next = clampAdjust(pendingAdjust, delta, MAX_OFFSET_ADJUST_SECS);
        if (next !== pendingAdjust) applyAdjust(next);
    };

    const resetAdjust = () => applyAdjust(0);

    // Skip needs none of applyAdjust's settle-to-absolute machinery: each tap
    // sends its own delta rather than a total the client owns, and reverting
    // one tap's optimistic bump is exact subtraction regardless of what order
    // two overlapping taps' responses arrive in — (+a then +b), then a late
    // failure of a subtracts a back out, leaving b either way. The effect
    // above is what clears any leftover pendingSkip once the server's own
    // total (the session prop) catches up.
    const applySkip = async (delta) => {
        setPendingSkip((p) => p + delta);
        const ok = await onSkip(delta);
        if (!ok) setPendingSkip((p) => p - delta);
    };

    const chip =
        offset === null
            ? html`
                  ${session && html`<span class="timer-expired">timer expired</span>`}
                  <button class="timer-btn" onClick=${() => onAction('start')}>
                      Start watching
                  </button>
              `
            : html`
                  <button
                      class=${'timer-chip' + (session.running_since ? ' running' : '')}
                      title=${session.running_since ? 'Pause' : 'Resume'}
                      aria-label=${
                          (session.running_since ? 'Pause timer at ' : 'Resume timer from ') +
                          formatOffset(offset)
                      }
                      onClick=${() => onAction(session.running_since ? 'pause' : 'resume')}
                  >
                      ${session.running_since ? '▶' : '⏸'} ${formatOffset(offset)}
                  </button>
                  <button class="timer-btn" onClick=${() => onAction('start')}>Restart</button>
                  <button class="timer-btn" onClick=${() => onAction('stop')}>Stop</button>
              `;

    return html`
        <div class="timer-stack">
            <div class="timer">
                ${chip}
                <button
                    class="timer-btn timer-adjust-toggle"
                    aria-expanded=${adjusting}
                    title="Adjust this episode's timer"
                    aria-label="Adjust this episode's timer"
                    onClick=${() => setAdjusting((v) => !v)}
                >
                    <span aria-hidden="true">±</span>
                </button>
            </div>
            ${
                adjusting &&
                (offset === null
                    ? html`<div class="timer-adjust-panel">
                          <div
                              class="timer-adjust"
                              role="group"
                              aria-label="Correct this episode's start"
                          >
                              <button
                                  class="timer-info-toggle"
                                  aria-expanded=${infoOpen}
                                  aria-label="What does Correct do?"
                                  title="What does Correct do?"
                                  onClick=${() => setInfoOpen((v) => !v)}
                              >
                                  <${Icon} name="info" />
                              </button>
                              ${
                                  pendingAdjust !== 0 &&
                                  html`<button class="timer-btn subtle" onClick=${resetAdjust}>
                                      Reset
                                  </button>`
                              }
                              <button class="timer-btn" onClick=${() => nudgeAdjust(-60)}>
                                  −1m
                              </button>
                              <button class="timer-btn" onClick=${() => nudgeAdjust(-15)}>
                                  −15s
                              </button>
                              <span class="timer-adjust-total">${formatAdjust(pendingAdjust)}</span>
                              <button class="timer-btn" onClick=${() => nudgeAdjust(15)}>
                                  +15s
                              </button>
                              <button class="timer-btn" onClick=${() => nudgeAdjust(60)}>+1m</button>
                          </div>
                          ${
                              infoOpen &&
                              html`<p class="timer-info-text">
                                  Moves every note on this episode, including ones you've already
                                  posted. Start the timer again to go back to adjusting live.
                              </p>`
                          }
                      </div>`
                    : html`<div class="timer-adjust-panel">
                          <div
                              class="timer-adjust"
                              role="group"
                              aria-label="Skip this episode's timer"
                          >
                              <button
                                  class="timer-info-toggle"
                                  aria-expanded=${infoOpen}
                                  aria-label="What does Skip do?"
                                  title="What does Skip do?"
                                  onClick=${() => setInfoOpen((v) => !v)}
                              >
                                  <${Icon} name="info" />
                              </button>
                              <button class="timer-btn" onClick=${() => applySkip(-60)}>
                                  −1m
                              </button>
                              <button class="timer-btn" onClick=${() => applySkip(-15)}>
                                  −15s
                              </button>
                              <button class="timer-btn" onClick=${() => applySkip(15)}>+15s</button>
                              <button class="timer-btn" onClick=${() => applySkip(60)}>+1m</button>
                          </div>
                          ${
                              infoOpen &&
                              html`<p class="timer-info-text">
                                  Moves your timer without changing notes you've already posted.
                                  Tap Stop to fix where this episode started instead — that moves
                                  everything.
                              </p>`
                          }
                      </div>`)
            }
        </div>
    `;
}
```

- [ ] **Step 6: Add CSS for the info toggle and the panel wrapper**

`frontend/styles.css`, immediately after the existing `.timer-adjust-total`
rule (ends around line 1336), add:

```css
/* Wraps the button row (.timer-adjust) and the optional caption beneath it,
   so the caption gets its own line instead of squeezing into the same
   0.35rem-gap flex row as the nudge buttons. */
.timer-adjust-panel {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.3rem;
}

/* Deliberately not .timer-btn: it also carries aria-expanded, and .timer-btn's
   hover/active rules already scope themselves to "the ± is the only .timer-btn
   with that attribute" (see the hover block below) — giving this its own class
   keeps that assumption true instead of quietly breaking it. */
.timer-info-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--control-height);
    min-width: var(--control-height);
    padding: 0.25rem;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8rem;
}

.timer-info-text {
    max-width: 16rem;
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-subtle);
    text-align: right;
}
```

`frontend/styles.css:1685-1687` (inside the `max-width: 640px` block), change:

```css
    .timer-adjust-toggle {
        min-width: 44px;
    }
```

to:

```css
    .timer-adjust-toggle,
    .timer-info-toggle {
        min-width: 44px;
    }

    .timer-info-text {
        max-width: 100%;
        text-align: left;
    }
```

Find the `@media (hover: hover)` block (`frontend/styles.css`, around line
2019-2031, containing `.timer-btn:not([aria-expanded='true']):hover` and
`.timer-chip:hover`) and add a hover rule for the new toggle alongside them:

```css
    .timer-info-toggle:hover {
        color: var(--text);
    }
```

- [ ] **Step 7: Validate**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass. (No test exercises `WatchTimer` directly — this repo
has no DOM suite — so this step is a syntax/lint/format gate, not a behavioral
one. Task 5 covers the behavioral check.)

- [ ] **Step 8: Commit**

```bash
git add frontend/icons.js frontend/discussion.js frontend/styles.css
git commit -m "feat: modal Skip/Correct timer panel with a Stop action"
```

---

## Task 4: Docs — update CLAUDE.md files

**Files:**
- Modify: `CLAUDE.md` (API Routes section, timer route description)
- Modify: `frontend/CLAUDE.md` (the `WatchTimer` bullet)

**Interfaces:** None — this task changes only documentation, no code.

- [ ] **Step 1: Update the root `CLAUDE.md` API Routes section**

In `CLAUDE.md`, find the line describing the timer route:

```
- `POST /api/seasons/:season_id/episodes/:episode/timer` — `{ action: "start" | "pause" | "resume" }`; drives the caller's watch timer for that episode. `start` always zeroes the session; `pause`/`resume` return 409 both when there is no session to act on and when one exists but has gone stale (three hours idle) — either way nothing is written and the caller starts a new session instead of reviving the old one.
```

Replace with:

```
- `POST /api/seasons/:season_id/episodes/:episode/timer` — `{ action: "start" | "pause" | "resume" | "skip" | "stop", delta_secs? }`; drives the caller's watch timer for that episode. `start` always zeroes the session; `pause`/`resume` return 409 both when there is no session to act on and when one exists but has gone stale (three hours idle) — either way nothing is written and the caller starts a new session instead of reviving the old one. `skip` (requires `delta_secs`, a nonzero integer within `MAX_SKIP_DELTA_SECS` seconds of zero, `shared/session.js`) adds `delta_secs` to the session's `elapsed_secs`, floored at zero, whether the session is running or paused; it shares `pause`/`resume`'s 409s for no-session and stale-session. Because `posts.offset_secs` is stamped from the session at write time and never rewritten, a skip only ever affects posts written after it — nothing already posted moves. `stop` deletes the session row outright and is idempotent (no session to delete is still success), returning `session: null, offset_secs: null` — the deliberate, on-demand way to reach the "no session" state the retroactive correction below needs, rather than waiting three hours for staleness.
```

Find the `PUT /api/seasons/:season_id/episodes/:episode/offset` line and add
one sentence at the end noting the split with `skip`:

```
- `PUT /api/seasons/:season_id/episodes/:episode/offset` — `{ adjust_secs }`; sets the caller's correction to where this episode's timer started. The value is absolute rather than a delta, the same reason the reactions route takes an explicit `on` instead of toggling — a retried request is idempotent instead of accumulating. `adjust_secs: 0` deletes the row, so "no correction" has one representation; beyond ±3600 (`MAX_OFFSET_ADJUST_SECS`, `shared/session.js`) is a 400. Requires a real episode and roster membership, but deliberately neither a live session nor a reveal — noticing your notes are misplaced is usually a read-time discovery, not a watch-time one. Unlike `skip` above, this reaches back and moves posts already written — the two exist for complementary cases, and the frontend's timer panel (`frontend/CLAUDE.md`) only ever offers one of them at a time, based on whether a session is currently live.
```

- [ ] **Step 2: Update the "Known limit" paragraph**

Find the "**Known limit, accepted rather than solved:**" paragraph in
`CLAUDE.md` (describing the correction's one-constant-shift limitation) and
add a sentence at its end:

```
The `skip` timer action (above) is what actually solves the case this
paragraph describes as too expensive to fix — by baking the correction into
`elapsed_secs` at the moment it happens, live, rather than trying to retrofit
segment-awareness into this route's read-time overlay. Skip only ever affects
posts written after it fires; this correction is what you reach for once
you've stopped the timer and are looking back at the whole episode instead.
```

- [ ] **Step 3: Update the `WatchTimer` bullet in `frontend/CLAUDE.md`**

Find the paragraph beginning "The optional watch timer (`WatchTimer` in
`discussion.js`, rule in `shared/session.js`) starts, pauses, and resumes per
(user, episode)..." Immediately after the sentence ending "...and
`pause`/`resume` on a stale session 409 without writing.", insert:

```
  Two more actions exist alongside those three: `skip` (`POST .../timer
  {action:'skip', delta_secs}`) jumps `elapsed_secs` by a signed delta, and
  `stop` (`POST .../timer {action:'stop'}`) deletes the session outright,
  idempotently — the deliberate way to reach "no session" without waiting
  three hours for staleness. `Stop` sits beside Restart in the main row,
  visible only while a session is live.
```

Then find the sentence "A ± toggle next to it opens a second row — Reset once
the total is non-zero, then −1m / −15s / running total / +15s / +1m — that
sets `PUT .../offset` (migration `0008`)." and replace it and the two
sentences immediately following it (through "...a separate button to stop it
was a second place to look for one action.") with:

```
  A ± toggle next to it opens a panel whose contents are modal on whether a
  session is live, not a manually chosen tab — there is no state where the
  wrong one is a single accidental tap away from the right one:

  - **Live session → Skip.** `−1m −15s +15s +1m` call the `skip` action
    directly. No running total and no Reset: each tap is folded permanently
    into `elapsed_secs` the moment it lands, the same way `pause` permanently
    banks a running segment — there's no separate value to revert to, only
    the opposite-direction tap. `applySkip`'s optimistic bump (a local
    `pendingSkip`) is exact commutative subtraction on failure rather than
    `applyAdjust`'s settle-to-absolute dance below: skip sends a delta, not a
    total the client owns, so two overlapping taps' responses can land in
    either order and a late failure still only ever backs out its own
    contribution. `pendingSkip` resets to zero whenever `session.elapsed_secs`
    / `running_since` change — a fresh session prop already carries every
    committed skip, so there's nothing left pending.
  - **No session → Correct.** Unchanged from before: Reset once the total is
    non-zero, then −1m / −15s / running total / +15s / +1m, all against
    `PUT .../offset` (migration `0008`).

  There is deliberately no Pause button: the chip itself is the pause/resume
  control, because the thing you want to stop is the number, and a separate
  button to stop it was a second place to look for one action.
```

Then find the sentence "The correction is applied on read rather than baked
into `posts.offset_secs`, so a nudge moves every note already posted on that
episode along with the live chip's own total." and, immediately after the
paragraph it's part of, add a new bullet:

```
- **An ⓘ toggle inside each panel variant** (`.timer-info-toggle`,
  `aria-expanded` like `.timer-adjust-toggle` — not a bare hover `title`,
  since a phone has no hover) reveals one line naming what that panel does
  and how to reach the other one. It exists because which panel you're
  looking at is a consequence of session state the control doesn't otherwise
  narrate, and a first-time user watching a note land in the wrong place has
  no way to discover the other mode without being told. Deliberately its own
  class rather than riding `.timer-btn`: that class's hover/active rules
  already assume "the ± is the only `.timer-btn` carrying `aria-expanded`,"
  and giving the info toggle a separate class keeps that true instead of
  quietly breaking it.
```

- [ ] **Step 4: Validate and commit**

Run: `npm run format:check`
Expected: PASS. (Docs changes don't touch code, so `build`/`test`/`lint` are
unaffected, but run them too for the standard pre-commit gate.)

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass.

```bash
git add CLAUDE.md frontend/CLAUDE.md
git commit -m "docs: describe the skip/stop timer actions and modal panel"
```

---

## Task 5: Manual verification

**Files:** None modified — this task only runs the app.

**Interfaces:** None.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: esbuild watch + `wrangler dev` both start; the app loads at the
printed local URL, signed in as `DEV_USER_EMAIL` from `.dev.vars`.

- [ ] **Step 2: Walk the golden path**

In the browser, open a season, expand an episode with no live session:

1. Confirm the `±` panel shows **Correct** (Reset absent at zero, `−1m −15s
   +15s +1m`, running total).
2. Tap the ⓘ inside it — confirm the caption appears and describes Correct.
3. Click **Start watching**. Confirm the chip starts ticking, Restart and
   **Stop** both appear, and the `±` panel now shows **Skip** instead
   (no running total, no Reset).
4. Post a note. Note its position in the list.
5. Tap **+1m** in the Skip panel twice (simulating a 2-minute filler skip).
   Confirm the chip's number jumps by ~2:00 immediately (before any network
   round trip completes — this is `pendingSkip`'s optimistic update).
6. Post a second note. Confirm it's stamped roughly 2 minutes ahead of the
   first, and the **first note's position does not change**.
7. Click **Stop**. Confirm the chip reverts to "Start watching" and the `±`
   panel switches back to **Correct**.
8. Open the `±` panel, tap **+1m**. Confirm this shifts *both* notes' timeline
   positions (the retroactive correction), unlike step 6's skip.
9. Tap **Reset**. Confirm both notes return to their original positions.

- [ ] **Step 3: Check the phone layout**

Resize the browser below 640px width (or open dev tools' device toolbar).
Confirm: the Skip and Correct button rows wrap without overlapping, the ⓘ
toggle and its caption are reachable and legible, and the Stop button doesn't
collide with Restart or the ± toggle in the wrapped layout.

- [ ] **Step 4: Final validation**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all four pass — this is the same gate every prior task already
cleared, run once more as the final check across the whole branch.
