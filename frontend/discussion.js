import { h } from 'preact';
import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useRefreshGuard, useRefreshOnFocus } from './hooks.js';
import { seasonLabel, orderPosts, formatOffset } from './utils.js';

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

    const mutate = useCallback(
        async (run) => {
            beginMutation();
            try {
                await run();
                await api(`/api/seasons/${seasonId}/discussion`).then((fresh) =>
                    setData((prev) => ({ ...fresh, users: prev.users })),
                );
                setError(null);
            } catch (err) {
                setError(err.message);
            } finally {
                endMutation();
            }
        },
        [seasonId, beginMutation, endMutation],
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

    if (loading) return html`<div class="loading">Loading…</div>`;
    if (error) return html`<div class="error">${error}</div>`;
    if (!data) return null;

    const nameOf = (id) => data.users.find((u) => u.id === id)?.name ?? 'Someone';

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
                            onReveal=${reveal}
                            onPost=${addPost}
                            onDelete=${removePost}
                        />`,
                )}
            </div>
        </div>
    `;
}

// One episode's board. Locked boards are the default: you see the count and who
// wrote, plus your own notes, and nothing else until you choose to open it.
function EpisodeBoard({ ep, meId, nameOf, onReveal, onPost, onDelete }) {
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
                        ${meId && html`<${PostForm} onPost=${(body) => onPost(ep.episode, body)} />`}
                    </div>
                `
            }
        </div>
    `;
}

function PostList({ placed, meId, nameOf, onDelete }) {
    if (placed.length === 0) return html`<div class="no-posts">Nothing here yet.</div>`;
    return html`
        <ol class="posts">
            ${placed.map(
                ({ post, offset, inferred, tail }) => html`
                    <li key=${post.id} class="post">
                        <span class="post-time" title=${new Date(post.created_at).toLocaleString()}>
                            ${
                                tail
                                    ? new Date(post.created_at).toLocaleDateString()
                                    : `${inferred ? '~' : ''}${formatOffset(offset)}`
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
                `,
            )}
        </ol>
    `;
}

// Posting is not optimistic: the offset is assigned by the server from your
// live session, so there is nothing correct to render until it answers.
function PostForm({ onPost }) {
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e) => {
        e.preventDefault();
        const trimmed = body.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            await onPost(trimmed);
            setBody('');
        } finally {
            setBusy(false);
        }
    };

    return html`
        <form class="post-form" onSubmit=${submit}>
            <input
                class="post-input"
                type="text"
                maxlength="2000"
                placeholder="Write a note…"
                value=${body}
                disabled=${busy}
                onInput=${(e) => setBody(e.target.value)}
            />
            <button class="post-submit" type="submit" disabled=${busy || !body.trim()}>Post</button>
        </form>
    `;
}
