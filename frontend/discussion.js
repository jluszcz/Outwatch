import { h } from 'preact';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useRefreshGuard, useRefreshOnFocus } from './hooks.js';
import { seasonLabel, orderPosts, formatOffset, formatOffsetShort, authorAccent } from './utils.js';
import { sessionOffsetSecs } from '../shared/session.js';

const html = htm.bind(h);

export function SeasonView({ seasonId }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // GET /api/seasons/:id/discussion returns user ids but not names, so the
    // season view fetches the board alongside it. Both are small and the board
    // is already warm in cache.
    const fetchDiscussion = useCallback(async () => {
        const [discussion, board] = await Promise.all([
            api(`/api/seasons/${seasonId}/discussion`),
            api('/api/board'),
        ]);
        return { ...discussion, users: board.users };
    }, [seasonId]);

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
                // the last mutation settles. fetchDiscussion() re-merges `users`,
                // so no separate preservation of `prev.users` is needed here.
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

    const addPost = (episode, body) =>
        mutate(() =>
            api(`/api/seasons/${seasonId}/episodes/${episode}/posts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body }),
            }),
        );

    const removePost = (postId) => mutate(() => api(`/api/posts/${postId}`, { method: 'DELETE' }));

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
    if (error) return html`<div class="error">${error}</div>`;
    if (!data) return null;

    // Anchors the ticking chip to the server's clock rather than a possibly-
    // wrong local one. Recomputed each render from the last response, so it
    // drifts by at most the age of that response — fine for a display that
    // only needs to be right to the second.
    const serverSkewMs = data.now ? Date.parse(data.now) - Date.now() : 0;

    const nameOf = (id) => data.users.find((u) => u.id === id)?.name ?? 'Someone';
    const accentOf = (id) => authorAccent(id, data.me?.id ?? null, data.users);

    return html`
        <div class="season-view">
            <a class="back-link" href="#/">← Board</a>
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
                            nameOf=${nameOf}
                            accentOf=${accentOf}
                            serverSkewMs=${serverSkewMs}
                            onReveal=${reveal}
                            onPost=${addPost}
                            onDelete=${removePost}
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
    nameOf,
    accentOf,
    serverSkewMs,
    onReveal,
    onPost,
    onDelete,
    onTimer,
}) {
    const [open, setOpen] = useState(false);
    const placed = useMemo(() => orderPosts(ep.posts), [ep.posts]);

    const summary =
        ep.count === 0 ? 'no notes' : `${ep.count} ${ep.count === 1 ? 'note' : 'notes'}`;
    const others = ep.authors.filter((id) => id !== meId).map(nameOf);

    return html`
        <div class=${'episode-card' + (ep.readable ? '' : ' locked')}>
            <button class="episode-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
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
                        <${PostList}
                            placed=${placed}
                            meId=${meId}
                            nameOf=${nameOf}
                            accentOf=${accentOf}
                            onDelete=${onDelete}
                        />
                        ${
                            !ep.readable &&
                            html`
                                ${
                                    ep.count > ep.posts.length &&
                                    html`<div class="hidden-note">
                                        — ${ep.count - ep.posts.length} notes hidden —
                                    </div>`
                                }
                                <button class="reveal-btn" onClick=${() => onReveal(ep.episode)}>
                                    Show discussion
                                </button>
                            `
                        }
                        ${
                            meId &&
                            html`<${WatchTimer}
                                session=${ep.session}
                                serverSkewMs=${serverSkewMs}
                                onAction=${(action) => onTimer(ep.episode, action)}
                            />`
                        }
                        ${meId && html`<${PostForm} onPost=${(body) => onPost(ep.episode, body)} />`}
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

function PostList({ placed, meId, nameOf, accentOf, onDelete }) {
    if (placed.length === 0) return html`<div class="no-posts">Nothing here yet.</div>`;
    return html`
        <ol class="posts">
            ${placed.map(({ post, offset, inferred, tail }) => {
                // 'mine' | 1..N | null — null leaves the note unstriped rather
                // than inventing a colour for an author who left the roster.
                const accent = accentOf(post.user_id);
                const accentClass =
                    accent === 'mine' ? ' post-mine' : accent ? ` post-a${accent}` : '';
                return html`
                    <li key=${post.id} class=${'post' + accentClass}>
                        <span class="post-time" title=${new Date(post.created_at).toLocaleString()}>
                            ${
                                tail
                                    ? new Date(post.created_at).toLocaleDateString()
                                    : `${inferred ? '~' : ''}${formatOffsetShort(offset)}`
                            }
                        </span>
                        <span class="post-author"
                            >${post.user_id === meId ? 'You' : nameOf(post.user_id)}</span
                        >
                        <span class="post-body">${post.body}</span>
                        ${
                            post.user_id === meId &&
                            html`<button
                                class="post-delete"
                                title="Delete this note"
                                onClick=${() => onDelete(post.id)}
                            >
                                ×
                            </button>`
                        }
                    </li>
                `;
            })}
        </ol>
    `;
}

// Posting is not optimistic: the offset is assigned by the server from your
// live session, so there is nothing correct to render until it answers.
function PostForm({ onPost }) {
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);
    const inputRef = useRef(null);

    // A textarea does not size itself to its content, so the height is driven
    // from scrollHeight on every change. Resetting to 'auto' first is what lets
    // the box shrink again after a delete — scrollHeight never reports less
    // than the height already set.
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        const style = getComputedStyle(el);
        // scrollHeight leaves out the border, which box-sizing: border-box
        // counts inside the height, so skipping this clips the last line.
        const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        el.style.height = `${el.scrollHeight + border}px`;
    }, [body]);

    const submit = async (e) => {
        e.preventDefault();
        const trimmed = body.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            // Only clear the box on success — a failed post already shows the
            // error banner, and wiping what the user just typed on top of that
            // would silently discard it.
            const posted = await onPost(trimmed);
            if (posted) setBody('');
        } finally {
            setBusy(false);
        }
    };

    // Enter still posts, the way it did when this was an <input>. Shift+Enter
    // is the escape hatch for a line break, which renders because .post-body is
    // white-space: pre-wrap.
    const keyDown = (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        submit(e);
    };

    return html`
        <form class="post-form" onSubmit=${submit}>
            <textarea
                ref=${inputRef}
                class="post-input"
                rows="1"
                maxlength="2000"
                placeholder="Write a note…"
                value=${body}
                disabled=${busy}
                onInput=${(e) => setBody(e.target.value)}
                onKeyDown=${keyDown}
            ></textarea>
            <button class="post-submit" type="submit" disabled=${busy || !body.trim()}>Post</button>
        </form>
    `;
}
