import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import htm from 'htm';
import { authorAccent, formatOffsetShort } from './utils.js';
import { useAutoSize, useSubmitGuard } from './hooks.js';
import { REACTIONS } from '../shared/reactions.js';

const html = htm.bind(h);

// emoji -> label, built once rather than a REACTIONS.find() per chip per
// render. Used for a chip's accessible name (see ReactionBar).
const REACTION_LABELS = new Map(REACTIONS.map(({ emoji, label }) => [emoji, label]));

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
    pickerFor,
    onTogglePicker,
    onReact,
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
                        pickerOpen=${pickerFor === entry.post.id}
                        onTogglePicker=${onTogglePicker}
                        onReact=${onReact}
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
    const { busy, run, canCancel } = useSubmitGuard();
    const ref = useRef(null);
    useAutoSize(ref, body);

    useEffect(() => ref.current?.focus(), []);

    const save = async (e) => {
        e.preventDefault();
        await run(body, (trimmed) => onSave(post.id, trimmed));
    };

    // A save in flight must finish before the user can back out — otherwise a
    // "cancelled" edit that was already in flight lands anyway when the PATCH
    // resolves, with nothing telling the user it happened. Matches the Save
    // button, which is already disabled while busy.
    const cancel = () => {
        if (canCancel()) onCancel();
    };

    // Matching PostForm's keys, plus Escape to back out.
    const keyDown = (e) => {
        if (e.key === 'Escape') {
            cancel();
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
                <button type="button" class="timer-btn subtle" onClick=${cancel}>Cancel</button>
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

// A note's existing reactions. The server sends them in set order with the
// counts and names already resolved, so this only draws them. `mine` fills the
// chip in and is what tapping it toggles. The bar still renders for a viewer
// with no `meId` — the counts and names are information they're entitled to
// see — but each chip is disabled, since reacting, like every other control in
// the action row, requires being on the roster.
function ReactionBar({ post, meId, onReact }) {
    return html`
        <div class="reaction-bar">
            ${post.reactions.map(
                (r) => html`
                    <button
                        key=${r.emoji}
                        class=${'reaction-chip' + (r.mine ? ' mine' : '')}
                        aria-pressed=${r.mine}
                        aria-label=${`${REACTION_LABELS.get(r.emoji)}: ${r.count}`}
                        title=${r.names.join(', ')}
                        disabled=${!meId}
                        onClick=${() => onReact(post.id, r.emoji, !r.mine)}
                    >
                        <span aria-hidden="true">${r.emoji}</span>${r.count}
                    </button>
                `,
            )}
        </div>
    `;
}

// Inline below the note rather than an absolutely positioned popover: nothing
// to clip inside a scrolling board, and the 44px targets fall out of the grid.
function EmojiPicker({ post, onReact }) {
    const chosen = new Set(post.reactions.filter((r) => r.mine).map((r) => r.emoji));
    return html`
        <div class="emoji-picker">
            ${REACTIONS.map(
                ({ emoji, label }) => html`
                    <button
                        key=${emoji}
                        class="emoji-btn"
                        aria-label=${label}
                        aria-pressed=${chosen.has(emoji)}
                        onClick=${() => onReact(post.id, emoji, !chosen.has(emoji))}
                    >
                        ${emoji}
                    </button>
                `,
            )}
        </div>
    `;
}

// One note. The time, author, and action row sit on the note's first line; the
// quote block, body, and reactions stack inside .post-content, so a plain note
// still reads as a single line on a wide screen while anything richer grows
// downward instead of sideways.
function Post({
    entry,
    meId,
    onReply,
    onDelete,
    editing,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    pickerOpen,
    onTogglePicker,
    onReact,
}) {
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
                ${
                    post.reactions.length > 0 &&
                    html`<${ReactionBar} post=${post} meId=${meId} onReact=${onReact} />`
                }
                ${pickerOpen && html`<${EmojiPicker} post=${post} onReact=${onReact} />`}
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
                    <button
                        class="post-action"
                        title="React to this note"
                        aria-expanded=${pickerOpen}
                        onClick=${() => onTogglePicker(post.id)}
                    >
                        ☺+
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
