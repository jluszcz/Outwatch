import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import htm from 'htm';
import { authorAccent, formatOffsetShort } from './utils.js';
import { useAutoSize } from './hooks.js';

const html = htm.bind(h);

// The accent class for a note — 'mine' | 1..N | null, where null leaves it
// unstriped rather than inventing a colour for an author who left the roster.
export function accentClass(source) {
    const accent = authorAccent(source);
    return accent === 'mine' ? ' post-mine' : accent ? ` post-a${accent}` : '';
}

export function PostList({
    placed,
    meId,
    onReply,
    onDelete,
    editingId,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
}) {
    if (placed.length === 0) return html`<div class="no-posts">Nothing here yet.</div>`;
    return html`
        <ol class="posts">
            ${placed.map(
                (entry) =>
                    html`<${Post}
                        key=${entry.post.id}
                        entry=${entry}
                        meId=${meId}
                        onReply=${onReply}
                        onDelete=${onDelete}
                        editing=${editingId === entry.post.id}
                        onStartEdit=${onStartEdit}
                        onCancelEdit=${onCancelEdit}
                        onSaveEdit=${onSaveEdit}
                    />`,
            )}
        </ol>
    `;
}

// The quoted note above a reply. Three forms, matching what the server sends:
// nothing at all, a locked stub, or the parent's live text — live because the
// reply stores an id rather than a copy, so an edit to the parent shows through
// here. Takes the quoted author's accent, not the replier's.
function Quote({ quote }) {
    if (quote.locked) {
        return html`<div class="post-quote post-quote-locked">
            🔒 hidden until you open this episode
        </div>`;
    }
    return html`
        <div class=${'post-quote' + accentClass(quote)}>
            <span class="post-quote-author">${quote.mine ? 'You' : quote.author_name}</span>
            <span class="post-quote-body">${quote.body}</span>
        </div>
    `;
}

// Editing happens where the note sits, so the surrounding conversation stays
// visible while you rewrite. The textarea deliberately stays enabled while
// saving, for the same reason PostForm's does: disabling a focused textarea
// blurs it, which on a phone tears down the keyboard mid-save and does not
// bring it back. `busy` gates the submit path instead.
function EditForm({ post, onSave, onCancel }) {
    const [body, setBody] = useState(post.body);
    const [busy, setBusy] = useState(false);
    const ref = useRef(null);
    useAutoSize(ref, body);

    useEffect(() => ref.current?.focus(), []);

    const save = async (e) => {
        e.preventDefault();
        const trimmed = body.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            await onSave(post.id, trimmed);
        } finally {
            setBusy(false);
        }
    };

    // Matching PostForm's keys, plus Escape to back out.
    const keyDown = (e) => {
        if (e.key === 'Escape') {
            onCancel();
            return;
        }
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        save(e);
    };

    return html`
        <form class="post-edit" onSubmit=${save}>
            <textarea
                ref=${ref}
                class="post-input"
                rows="1"
                maxlength="2000"
                value=${body}
                onInput=${(e) => setBody(e.target.value)}
                onKeyDown=${keyDown}
            ></textarea>
            <div class="post-edit-actions">
                <button type="button" class="timer-btn subtle" onClick=${onCancel}>Cancel</button>
                <button
                    class="post-submit"
                    type="submit"
                    aria-busy=${busy}
                    disabled=${busy || !body.trim()}
                >
                    ${busy ? html`<span class="spinner" aria-hidden="true"></span>Saving…` : 'Save'}
                </button>
            </div>
        </form>
    `;
}

// One note. The time, author, and action row sit on the note's first line; the
// quote block, body, and reactions stack inside .post-content, so a plain note
// still reads as a single line on a wide screen while anything richer grows
// downward instead of sideways.
function Post({ entry, meId, onReply, onDelete, editing, onStartEdit, onCancelEdit, onSaveEdit }) {
    const { post, offset, inferred, tail } = entry;
    return html`
        <li class=${'post' + accentClass(post)}>
            <span class="post-time" title=${new Date(post.created_at).toLocaleString()}>
                ${
                    tail
                        ? new Date(post.created_at).toLocaleDateString()
                        : `${inferred ? '~' : ''}${formatOffsetShort(offset)}`
                }
            </span>
            <span class="post-author">${post.mine ? 'You' : post.author_name}</span>
            ${
                post.edited_at &&
                html`<span class="post-edited" title=${new Date(post.edited_at).toLocaleString()}>
                    · edited
                </span>`
            }
            <div class="post-content">
                ${post.reply_to && html`<${Quote} quote=${post.reply_to} />`}
                ${
                    editing
                        ? html`<${EditForm}
                              post=${post}
                              onSave=${onSaveEdit}
                              onCancel=${onCancelEdit}
                          />`
                        : html`<span class="post-body">${post.body}</span>`
                }
            </div>
            ${
                meId &&
                html`<div class="post-actions">
                    <button
                        class="post-action"
                        title="Reply to this note"
                        onClick=${() => onReply(post)}
                    >
                        ↰
                    </button>
                    ${
                        post.mine &&
                        !editing &&
                        html`<button
                            class="post-action"
                            title="Edit this note"
                            onClick=${() => onStartEdit(post.id)}
                        >
                            ✎
                        </button>`
                    }
                    ${
                        post.mine &&
                        html`<button
                            class="post-action"
                            title="Delete this note"
                            onClick=${() => onDelete(post.id)}
                        >
                            ×
                        </button>`
                    }
                </div>`
            }
        </li>
    `;
}
