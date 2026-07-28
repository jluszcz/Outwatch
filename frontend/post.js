import { h } from 'preact';
import htm from 'htm';
import { authorAccent, formatOffsetShort } from './utils.js';

const html = htm.bind(h);

// The accent class for a note — 'mine' | 1..N | null, where null leaves it
// unstriped rather than inventing a colour for an author who left the roster.
export function accentClass(source) {
    const accent = authorAccent(source);
    return accent === 'mine' ? ' post-mine' : accent ? ` post-a${accent}` : '';
}

export function PostList({ placed, meId, onReply, onDelete }) {
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

// One note. The time, author, and action row sit on the note's first line; the
// quote block, body, and reactions stack inside .post-content, so a plain note
// still reads as a single line on a wide screen while anything richer grows
// downward instead of sideways.
function Post({ entry, meId, onReply, onDelete }) {
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
            <div class="post-content">
                ${post.reply_to && html`<${Quote} quote=${post.reply_to} />`}
                <span class="post-body">${post.body}</span>
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
