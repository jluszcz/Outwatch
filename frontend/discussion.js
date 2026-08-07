import { h } from 'preact';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useRefreshGuard, useRefreshOnFocus, useSubmitGuard } from './hooks.js';
import {
    seasonLabel,
    orderPosts,
    formatOffset,
    formatAdjust,
    clampAdjust,
    settledAdjust,
    quoteSnippet,
    bodyAfterPost,
    replyTargetGone,
    shouldScrollToEpisode,
} from './utils.js';
import { sessionOffsetSecs, MAX_OFFSET_ADJUST_SECS } from '../shared/session.js';
import { PostList } from './post.js';
import { prefersReducedMotion } from './board.js';
import { Icon } from './icons.js';

const html = htm.bind(h);

export function SeasonView({ seasonId, routeEpisode }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // Which episode's board is expanded, or null for none. Held here rather than
    // per-board so opening one closes the rest: the boards are a tall stack, and
    // leaving them all open buries the one you just opened.
    const [openEpisode, setOpenEpisode] = useState(null);

    // A feed line links straight at an episode, so the route can name one. An
    // effect rather than a useState seed because SeasonView is keyed on the
    // season: following a second link within the same season does not remount,
    // so an initial value would never re-run.
    //
    // It must NOT reveal. Expanding a board and revealing it are separate
    // actions here (onToggle vs onReveal) and have to stay that way — a reveal
    // is permanent and one-way, and spending someone's reveal on a tap they
    // made in a header panel is not something they can undo. Landing on a
    // locked episode shows the locked board and its Reveal button, which is the
    // right destination.
    useEffect(() => {
        if (routeEpisode != null) setOpenEpisode(routeEpisode);
    }, [routeEpisode]);

    // A feed line's whole point is to land you on the episode it names, not
    // merely expand its board off-screen: a hash navigation lands at the top
    // of the document, and the opened card can sit hundreds of pixels below
    // the fold with nothing to show anything happened. Mirrors NowWatching's
    // jump in board.js, including its prefers-reduced-motion check.
    //
    // When to jump is `shouldScrollToEpisode` (utils.js), which is where each of
    // its conditions is explained and tested; this is the wiring. The deps are
    // every input that rule reads — `openEpisode` and `loading` included, since
    // the commit that gets a card rendered and expanded is one or two renders
    // later than the one that sets the route, and the effect has to run again on
    // it rather than measuring a document that has no cards in it yet.
    const scrolledEpisodeRef = useRef(null);
    useEffect(() => {
        const jump = shouldScrollToEpisode({
            routeEpisode,
            openEpisode,
            ready: !loading && Boolean(data),
            scrolled: scrolledEpisodeRef.current,
        });
        if (!jump) return;
        const card = document.getElementById(`episode-card-${routeEpisode}`);
        if (!card) return;
        card.scrollIntoView({
            block: 'center',
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
        scrolledEpisodeRef.current = routeEpisode;
    }, [routeEpisode, openEpisode, data, loading]);

    // One request: the discussion response names each note's author itself, so
    // there is no roster to fetch and merge here.
    const fetchDiscussion = useCallback(
        () => api(`/api/seasons/${seasonId}/discussion`),
        [seasonId],
    );

    const { refresh, beginMutation, endMutation } = useRefreshGuard(fetchDiscussion, setData);
    useRefreshOnFocus(refresh, setError);

    useEffect(() => {
        setLoading(true);
        refresh()
            .catch((err) => setError(err.message))
            .finally(() => setLoading(false));
    }, [refresh]);

    // Resolves true on success and false on failure so callers that need to know
    // (PostForm keeps the user's typed text on failure rather than clearing a box
    // it never actually posted) can gate on it; the other callers just ignore it.
    const mutate = useCallback(
        async (run, { suppressError, onFailure } = {}) => {
            beginMutation();
            try {
                await run();
                // Goes through the guard rather than fetching inline: called while
                // the mutation is still in flight, this defers (mutationsInFlight
                // > 0) and queues a refresh; endMutation() below then runs it once
                // the last mutation settles. fetchDiscussion() returns the whole
                // view, so there is nothing to preserve across a refresh.
                await refresh();
                setError(null);
                return true;
            } catch (err) {
                // A caller may need to know *why* it failed, not only that it
                // did: PostForm's reply chip is dropped on a 404, because the
                // chip is the thing that will keep failing. Notification only —
                // it runs before the banner decision and does not change it.
                onFailure?.(err);
                // Some failures are expected and already self-explanatory in the
                // UI (a stale timer session 409s and the chip falls back to its
                // expired state on refetch) — those skip the error banner but
                // still refresh, best-effort, so the UI reflects the rejection.
                if (suppressError?.(err)) {
                    await refresh().catch(() => {});
                } else {
                    setError(err.message);
                }
                return false;
            } finally {
                endMutation();
            }
        },
        [refresh, beginMutation, endMutation],
    );

    const reveal = (episode) =>
        mutate(() =>
            api(`/api/seasons/${seasonId}/episodes/${episode}/reveal`, { method: 'POST' }),
        );

    // `onFailure` is how EpisodeBoard learns a reply's parent is gone; see
    // submitPost there, and replyTargetGone in utils.js for why that matters.
    const addPost = (episode, body, replyToId, onFailure) =>
        mutate(
            () =>
                api(`/api/seasons/${seasonId}/episodes/${episode}/posts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ body, reply_to_post_id: replyToId }),
                }),
            { onFailure },
        );

    const removePost = (postId) => mutate(() => api(`/api/posts/${postId}`, { method: 'DELETE' }));

    const editPost = (postId, body) =>
        mutate(() =>
            api(`/api/posts/${postId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body }),
            }),
        );

    const setReaction = (postId, emoji, on) =>
        mutate(() =>
            api(`/api/posts/${postId}/reactions`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emoji, on }),
            }),
        );

    // pause/resume 409 once the session has gone stale server-side (see
    // shared/session.js) — that's not an app error, it's the expected outcome
    // of waiting too long, so it's suppressed here rather than surfaced as a
    // banner. The refetch that follows shows the session as gone and the chip
    // falls back to its expired / "Start watching" state on its own.
    const setTimer = (episode, action) =>
        mutate(
            () =>
                api(`/api/seasons/${seasonId}/episodes/${episode}/timer`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action }),
                }),
            { suppressError: (err) => err.status === 409 },
        );

    // Absolute rather than a delta, matching the route: a retried or duplicated
    // PUT then still lands on the same total instead of compounding. The
    // accumulation that makes a run of taps add up lives entirely on
    // WatchTimer's side, in a local total it seeds from adjust_secs — this
    // call only ever carries what that total already is.
    const setOffsetAdjust = (episode, adjustSecs) =>
        mutate(() =>
            api(`/api/seasons/${seasonId}/episodes/${episode}/offset`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adjust_secs: adjustSecs }),
            }),
        );

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

    if (loading) return html`<div class="loading">Loading…</div>`;
    // Only a failure with nothing to show yet (the initial load) gets the view to
    // itself. Once there is data, an error is a banner *above* it, the way the
    // board does it — a failed post must not unmount the view, because that
    // takes the discussion, the open episode, and the text still sitting in the
    // post box with it, and nothing short of a reload or a tab-out brings them
    // back. The one mutation whose failure is recoverable was the one whose
    // failure erased the most.
    if (!data) return error ? html`<div class="error">${error}</div>` : null;

    // Anchors the ticking chip to the server's clock rather than a possibly-
    // wrong local one. Recomputed each render from the last response, so it
    // drifts by at most the age of that response — fine for a display that
    // only needs to be right to the second.
    const serverSkewMs = data.now ? Date.parse(data.now) - Date.now() : 0;

    return html`
        <div class="season-view">
            <a class="back-link" href="#/">← Board</a>
            ${error && html`<div class="error">${error}</div>`}
            <div class="season-view-head">
                <h2 class="season-view-title">${seasonLabel(data.season)}</h2>
                <a
                    class="wiki-link"
                    href=${data.season.wikipedia_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >Wikipedia ↗</a
                >
            </div>
            ${
                !data.me &&
                html`<div class="notice">
                    You're not on the watch list — you can read what you've opened, but not post.
                </div>`
            }
            <div class="episodes">
                ${data.episodes.map(
                    (ep) =>
                        html`<${EpisodeBoard}
                            key=${ep.episode}
                            ep=${ep}
                            meId=${data.me?.id ?? null}
                            serverSkewMs=${serverSkewMs}
                            open=${openEpisode === ep.episode}
                            onToggle=${() =>
                                setOpenEpisode((cur) => (cur === ep.episode ? null : ep.episode))}
                            onReveal=${reveal}
                            onPost=${addPost}
                            onDelete=${removePost}
                            onEdit=${editPost}
                            onReact=${setReaction}
                            onTimer=${setTimer}
                            onOffsetAdjust=${setOffsetAdjust}
                            onSkip=${setTimerSkip}
                        />`,
                )}
            </div>
        </div>
    `;
}

// One episode's board. Locked boards are the default: you see the count and who
// wrote, plus your own notes, and nothing else until you choose to open it.
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
    const placed = useMemo(() => orderPosts(ep.posts), [ep.posts]);

    // Episode-scoped, so the chip and the note it points at cannot drift apart, and
    // so one board's half-written reply does not follow you to another.
    const [replyTo, setReplyTo] = useState(null);
    // Episode-scoped for the same reason as replyTo — one note editable per
    // board at a time, by construction.
    //
    // Passed to PostList below as onStartEdit=${setEditingId} — a raw setter,
    // not a call guarded by EditForm's canCancel(). So clicking the ✎ on a
    // different note unmounts an in-flight EditForm instead of being blocked
    // while its save is still in flight. That's mild, and in fact correct: the
    // user already pressed Save, so letting that save land is the right
    // outcome, not a bug. canCancel() only guards backing out via Cancel or
    // Escape — i.e. not saving at all — it isn't meant to, and doesn't, cover
    // navigating away to edit something else instead.
    const [editingId, setEditingId] = useState(null);
    // Which post's ⋯ menu is open, or null for none — one at a time, same as
    // editingId, and episode-scoped for the same reason.
    const [menuFor, setMenuFor] = useState(null);
    // Owned here rather than inside PostForm so tapping Reply can focus the box.
    const inputRef = useRef(null);

    const startReply = (post) => {
        setReplyTo({
            id: post.id,
            author_name: post.mine ? 'You' : post.author_name,
            snippet: quoteSnippet(post.body),
        });
        // Raises the keyboard on a phone with the chip already in place.
        inputRef.current?.focus();
    };

    const submitPost = async (body) => {
        const replyToId = replyTo?.id ?? null;
        // A chip whose note was deleted mid-compose can only keep failing, and
        // it takes the whole compose box down with it: the text stays (a failed
        // post must not discard it), so every later attempt sends the same dead
        // parent id and fails identically. Dropping the chip lets the next
        // attempt go out as an ordinary note; the banner says what happened.
        //
        // Both paths clear through a functional update keyed on the id, for the
        // reason saveEdit's does: the user may have raised a chip on a
        // different note while this was in flight, and neither a late success
        // nor a dead parent should close over it.
        const clearChip = () => setReplyTo((cur) => (cur?.id === replyToId ? null : cur));
        const posted = await onPost(ep.episode, body, replyToId, (err) => {
            if (replyTargetGone(replyToId, err)) clearChip();
        });
        if (posted) clearChip();
        return posted;
    };

    const saveEdit = async (postId, body) => {
        const saved = await onEdit(postId, body);
        // Stay in the editor on failure: the banner explains why, and the rewritten
        // text is still in the box rather than discarded.
        // The functional update matters: the user may have cancelled this note's
        // editor and opened a different one while this save was in flight, so a
        // stale success must not close an editor it does not own.
        if (saved) setEditingId((cur) => (cur === postId ? null : cur));
    };

    // Choosing an emoji closes the menu, whether it added or removed one.
    const react = (postId, emoji, on) => {
        setMenuFor(null);
        return onReact(postId, emoji, on);
    };

    const summary =
        ep.count === 0 ? 'no notes' : `${ep.count} ${ep.count === 1 ? 'note' : 'notes'}`;
    const others = ep.authors.filter((a) => !a.mine).map((a) => a.name);

    return html`
        <div
            id=${`episode-card-${ep.episode}`}
            class=${'episode-card' + (ep.readable ? '' : ' locked')}
        >
            <button class="episode-head" aria-expanded=${open} onClick=${onToggle}>
                <span class="episode-name">Episode ${ep.episode}</span>
                <span class="episode-meta">
                    ${ep.readable ? '' : '🔒 '}${summary}${
                        others.length ? ` · ${others.join(', ')}` : ''
                    }
                </span>
            </button>
            ${
                open &&
                html`
                    <div class="episode-body">
                        ${
                            // The controls sit above the discussion, not below
                            // it, so they hold one position: a board's notes
                            // grow as people post and as revealing unhides
                            // them, and anything underneath that list moves
                            // every time it does.
                            //
                            // One row: reveal on the left, timer pushed to the
                            // right. Rendered only when it would hold something,
                            // so a readable episode you can't post to doesn't
                            // leave an empty band. The row holds its height on
                            // its own (.episode-actions), so revealing removes
                            // the button without dragging the timer upward.
                            (!ep.readable || meId) &&
                            html`
                                <div class="episode-actions">
                                    ${
                                        !ep.readable &&
                                        html`<button
                                            class="reveal-btn"
                                            onClick=${() => onReveal(ep.episode)}
                                        >
                                            Show discussion
                                        </button>`
                                    }
                                    ${
                                        meId &&
                                        html`<${WatchTimer}
                                            session=${ep.session}
                                            adjustSecs=${ep.adjust_secs ?? 0}
                                            serverSkewMs=${serverSkewMs}
                                            onAction=${(action) => onTimer(ep.episode, action)}
                                            onAdjust=${(secs) => onOffsetAdjust(ep.episode, secs)}
                                            onSkip=${(delta) => onSkip(ep.episode, delta)}
                                        />`
                                    }
                                </div>
                            `
                        }
                        <${PostList}
                            placed=${placed}
                            meId=${meId}
                            onReply=${startReply}
                            onDelete=${onDelete}
                            editingId=${editingId}
                            onStartEdit=${setEditingId}
                            onCancelEdit=${() => setEditingId(null)}
                            onSaveEdit=${saveEdit}
                            menuFor=${menuFor}
                            onToggleMenu=${(id) => setMenuFor((cur) => (cur === id ? null : id))}
                            onReact=${react}
                        />
                        ${
                            !ep.readable &&
                            ep.count > ep.posts.length &&
                            html`<div class="hidden-note">
                                — ${ep.count - ep.posts.length} notes hidden —
                            </div>`
                        }
                        ${
                            meId &&
                            html`<${PostForm}
                                inputRef=${inputRef}
                                replyTo=${replyTo}
                                onCancelReply=${() => setReplyTo(null)}
                                onPost=${submitPost}
                            />`
                        }
                    </div>
                `
            }
        </div>
    `;
}

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
    // Whether the panel's short explanation is showing via tap/click — the
    // only way it can show on a phone, which has no hover. On a pointer
    // device it can also appear on hover/focus of the ⓘ button without this
    // ever changing, purely in CSS (`.timer-info-toggle:hover`/`:focus-visible`
    // via `:has()` in styles.css) — the paragraph always renders, and this
    // state only controls its `.open` class, the tap/keyboard path. Also
    // local — it dies with the panel, and the panel dies with `adjusting`.
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
    // session actually moved. `last_activity_at`, not `running_since`: the
    // server stamps `last_activity_at` unconditionally on every accepted
    // timer action, including a skip clamped to exactly zero effect (already
    // at the floor), where `elapsed_secs` numerically doesn't change and
    // `running_since` isn't touched either — keying on those two alone would
    // never fire there, leaving `pendingSkip` stuck at a nonzero optimistic
    // value the server never actually reflected.
    const [pendingSkip, setPendingSkip] = useState(0);
    useEffect(() => {
        setPendingSkip(0);
    }, [session?.elapsed_secs, session?.last_activity_at]);

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
                              <button class="timer-btn" onClick=${() => nudgeAdjust(60)}>
                                  +1m
                              </button>
                          </div>
                          <p class=${'timer-info-text' + (infoOpen ? ' open' : '')}>
                              Moves every note on this episode, including ones you've already
                              posted. Start the timer again to go back to adjusting live.
                          </p>
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
                                  onClick=${() => setInfoOpen((v) => !v)}
                              >
                                  <${Icon} name="info" />
                              </button>
                              <button class="timer-btn" onClick=${() => applySkip(-60)}>−1m</button>
                              <button class="timer-btn" onClick=${() => applySkip(-15)}>
                                  −15s
                              </button>
                              <button class="timer-btn" onClick=${() => applySkip(15)}>+15s</button>
                              <button class="timer-btn" onClick=${() => applySkip(60)}>+1m</button>
                          </div>
                          <p class=${'timer-info-text' + (infoOpen ? ' open' : '')}>
                              Moves your timer, adjusting where future notes land. Stop to adjust
                              every note posted.
                          </p>
                      </div>`)
            }
        </div>
    `;
}

// Posting is not optimistic: the offset is assigned by the server from your
// live session, so there is nothing correct to render until it answers.
function PostForm({ inputRef, replyTo, onCancelReply, onPost }) {
    const [body, setBody] = useState('');
    const { busy, run } = useSubmitGuard();

    const submit = async (e) => {
        e.preventDefault();
        const posted = await run(body, (trimmed) => onPost(trimmed));
        // The box stays editable during the flight, so it may no longer hold
        // what was submitted: bodyAfterPost clears only the text that actually
        // posted, and leaves anything typed on top of it alone. It compares
        // against the raw `body` captured by this render, not the trimmed text
        // that was sent — see utils.js for why the difference bit.
        if (posted) setBody((current) => bodyAfterPost(current, body));
    };

    // Enter still posts, the way it did when this was an <input>. Shift+Enter
    // is the escape hatch for a line break, which renders because .post-body is
    // white-space: pre-wrap. `enterkeyhint="send"` on the box below is what says
    // so on a phone: a textarea's return key is otherwise labelled with a plain
    // ⏎, which promises a newline this form does not give it.
    const keyDown = (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        submit(e);
    };

    // The textarea deliberately stays enabled while a post is in flight.
    // Disabling a focused textarea blurs it, which on a phone tears the keyboard
    // down mid-post and does not bring it back — you tap the box again for every
    // note. `busy` gates the submit path instead, so a second Enter can't
    // double-post while the first is still going.
    //
    // The box sizes itself to its text through .post-input-wrap's CSS replica
    // (styles.css), which renders `data-value` — so that attribute has to carry
    // the same text the textarea does, or the box stops tracking what you type.
    return html`
        <form class="post-form" onSubmit=${submit}>
            ${
                replyTo &&
                html`<div class="reply-chip">
                    <span class="reply-chip-text"
                        >↰ ${replyTo.author_name}: ${replyTo.snippet}</span
                    >
                    <button
                        type="button"
                        class="post-action"
                        title="Cancel reply"
                        aria-label="Cancel reply"
                        onClick=${onCancelReply}
                    >
                        <span aria-hidden="true">×</span>
                    </button>
                </div>`
            }
            <div class="post-input-wrap" data-value=${body}>
                <textarea
                    ref=${inputRef}
                    class="post-input"
                    rows="1"
                    maxlength="2000"
                    enterkeyhint="send"
                    placeholder="Write a note…"
                    value=${body}
                    onInput=${(e) => setBody(e.target.value)}
                    onKeyDown=${keyDown}
                ></textarea>
            </div>
            <button
                class="post-submit"
                type="submit"
                aria-busy=${busy}
                disabled=${busy || !body.trim()}
            >
                ${busy ? html`<span class="spinner" aria-hidden="true"></span>Posting…` : 'Post'}
            </button>
        </form>
    `;
}
