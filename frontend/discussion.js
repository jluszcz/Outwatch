import { h } from 'preact';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useRefreshGuard, useRefreshOnFocus, useAutoSize, useSubmitGuard } from './hooks.js';
import { seasonLabel, orderPosts, formatOffset, quoteSnippet } from './utils.js';
import { sessionOffsetSecs } from '../shared/session.js';
import { PostList } from './post.js';

const html = htm.bind(h);

export function SeasonView({ seasonId }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // Which episode's board is expanded, or null for none. Held here rather than
    // per-board so opening one closes the rest: the boards are a tall stack, and
    // leaving them all open buries the one you just opened.
    const [openEpisode, setOpenEpisode] = useState(null);

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
        async (run, { suppressError } = {}) => {
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

    const addPost = (episode, body, replyToId) =>
        mutate(() =>
            api(`/api/seasons/${seasonId}/episodes/${episode}/posts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body, reply_to_post_id: replyToId }),
            }),
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
    // Which post's picker is open, or null for none — one at a time, same as
    // editingId, and episode-scoped for the same reason.
    const [pickerFor, setPickerFor] = useState(null);
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
        const posted = await onPost(ep.episode, body, replyTo?.id ?? null);
        if (posted) setReplyTo(null);
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

    // Choosing an emoji closes the picker, whether it added or removed one.
    const react = (postId, emoji, on) => {
        setPickerFor(null);
        return onReact(postId, emoji, on);
    };

    const summary =
        ep.count === 0 ? 'no notes' : `${ep.count} ${ep.count === 1 ? 'note' : 'notes'}`;
    const others = ep.authors.filter((a) => !a.mine).map((a) => a.name);

    return html`
        <div class=${'episode-card' + (ep.readable ? '' : ' locked')}>
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
                                            serverSkewMs=${serverSkewMs}
                                            onAction=${(action) => onTimer(ep.episode, action)}
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
                            pickerFor=${pickerFor}
                            onTogglePicker=${(id) => setPickerFor((cur) => (cur === id ? null : id))}
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
function WatchTimer({ session, serverSkewMs, onAction }) {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!session?.running_since) return;
        const id = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [session?.running_since]);

    const offset = sessionOffsetSecs(session, Date.now() + serverSkewMs);
    // `tick` only exists to force this re-render each second.
    void tick;

    if (offset === null) {
        return html`
            <div class="timer">
                ${session && html`<span class="timer-expired">timer expired</span>`}
                <button class="timer-btn" onClick=${() => onAction('start')}>Start watching</button>
            </div>
        `;
    }

    const running = session.running_since != null;
    return html`
        <div class="timer">
            <span class=${'timer-chip' + (running ? ' running' : '')}>
                ${running ? '▶' : '⏸'} ${formatOffset(offset)}
            </span>
            <button class="timer-btn" onClick=${() => onAction(running ? 'pause' : 'resume')}>
                ${running ? 'Pause' : 'Resume'}
            </button>
            <button class="timer-btn subtle" onClick=${() => onAction('start')}>Restart</button>
        </div>
    `;
}

// Posting is not optimistic: the offset is assigned by the server from your
// live session, so there is nothing correct to render until it answers.
function PostForm({ inputRef, replyTo, onCancelReply, onPost }) {
    const [body, setBody] = useState('');
    const { busy, run } = useSubmitGuard();

    useAutoSize(inputRef, body);

    const submit = async (e) => {
        e.preventDefault();
        const trimmed = body.trim();
        const posted = await run(body, () => onPost(trimmed));
        // The box stays editable during the flight, so it may no longer hold
        // what was submitted: clear only the text that actually posted, and
        // leave anything typed on top of it alone.
        if (posted) setBody((current) => (current === trimmed ? '' : current));
    };

    // Enter still posts, the way it did when this was an <input>. Shift+Enter
    // is the escape hatch for a line break, which renders because .post-body is
    // white-space: pre-wrap.
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
            <textarea
                ref=${inputRef}
                class="post-input"
                rows="1"
                maxlength="2000"
                placeholder="Write a note…"
                value=${body}
                onInput=${(e) => setBody(e.target.value)}
                onKeyDown=${keyDown}
            ></textarea>
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
