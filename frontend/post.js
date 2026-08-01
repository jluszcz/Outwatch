import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import htm from 'htm';
import { authorAccent, formatOffsetShort } from './utils.js';
import { useIsDark, useSubmitGuard } from './hooks.js';
import { Icon } from './icons.js';
import { REACTIONS } from '../shared/reactions.js';
import { FullEmojiPicker, emojiName } from './emoji-picker.js';

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
    menuFor,
    onToggleMenu,
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
                        menuOpen=${menuFor === entry.post.id}
                        onToggleMenu=${onToggleMenu}
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

    // Same box as PostForm's, sized by .post-input-wrap's CSS replica: the
    // wrapper's `data-value` is what that replica renders, so it has to carry
    // the same text the textarea does.
    return html`
        <form class="post-edit" onSubmit=${save}>
            <div class="post-input-wrap" data-value=${body}>
                <textarea
                    ref=${ref}
                    class="post-input"
                    rows="1"
                    maxlength="2000"
                    value=${body}
                    onInput=${(e) => setBody(e.target.value)}
                    onKeyDown=${keyDown}
                ></textarea>
            </div>
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

// A note's existing reactions. The server sends them ordered by when each emoji
// first landed on the note, with the counts and names already resolved, so this
// only draws them. Any emoji can appear here, not just the quick row's four —
// hence `emojiName` for the label rather than a lookup in that row's set.
// `mine` fills the chip in and is what tapping it toggles. The bar still renders for a viewer
// with no `meId` — the counts and names are information they're entitled to
// see — but each chip is disabled, since reacting, like every other control in
// the action row, requires being on the roster. Defensive rather than reachable:
// a caller with no roster row gets `readable === false` for every episode and an
// empty `visible` array server-side, so no post — and so no chip — is ever
// serialized to them in the first place. That also means the usual "browsers
// suppress `title` on a disabled element" concern for the `title` above never
// arises in practice, since there is no rendered, disabled chip for it to apply to.
function ReactionBar({ post, meId, onReact }) {
    return html`
        <div class="reaction-bar">
            ${post.reactions.map(
                (r) => html`
                    <button
                        key=${r.emoji}
                        class=${'reaction-chip' + (r.mine ? ' mine' : '')}
                        aria-pressed=${r.mine}
                        aria-label=${`${emojiName(r.emoji)}: ${r.count}`}
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

// The quick row at the top of the action menu: the four emoji from
// `shared/reactions.js` worth reaching without opening the full picker, plus a
// ＋ that opens it. `chosen` comes from the server's `mine` flags rather than a
// local toggle, so the `on` this sends is always computed from what the server
// last said (see `PUT .../reactions`).
//
// The ＋ is a fifth cell in the same grid rather than a control of its own, so
// it reads as "and the rest of them" continuing the row rather than as a
// separate action sitting among Reply/Edit/Delete.
function EmojiPicker({ post, onReact, onOpenFull }) {
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
            <button class="emoji-btn emoji-more" aria-label="More emoji" onClick=${onOpenFull}>
                ＋
            </button>
        </div>
    `;
}

// The scrim and the menu itself: everything that exists only while the menu is
// open. Split from PostMenu so it mounts with the menu rather than with the
// note, which is what keeps `useIsDark`'s MutationObserver down to the one open
// menu instead of one per rendered note on the board. Its effects get to key on
// mount for the same reason.
//
// Two layouts, one DOM: a dropdown anchored to the trigger inside the
// position: relative .post-actions, which the `max-width: 640px` block turns
// into a bottom sheet by switching it to position: fixed — fixed escapes an
// untransformed ancestor, so no JS measures anything. The scrim is present in
// both, transparent on desktop and dimming on a phone, and is what handles
// click-outside either way. The close button renders in both too but is hidden
// on a pointer device: a dropdown you dismiss by clicking anywhere off it does
// not need one, while a sheet across the bottom of a phone does — and its
// top-right corner is the one spot in the sheet furthest from the bottom edge,
// where iOS Safari's collapsed toolbar swallows the first tap.
//
// Deliberately not role="menu": that role promises arrow-key roving between
// items, which this does not implement. Plain buttons in a labelled group get
// native Tab order and an honest accessibility tree; aria-haspopup and
// aria-expanded on the trigger say what it opens.
function PostMenuPanel({
    post,
    editing,
    onClose,
    onDismiss,
    onReply,
    onReact,
    onStartEdit,
    onDelete,
}) {
    const dark = useIsDark();
    const menuRef = useRef(null);
    // The full picker replaces the menu's body rather than opening a layer of
    // its own: it reuses the same dropdown on a pointer device and the same
    // bottom sheet on a phone, so there is no second scrim, no nesting, and
    // nothing new to dismiss. Choosing an emoji closes the whole menu, like
    // every other item, but the picker's back button and Escape return to the
    // actions rather than dismissing: the picker replaced them, so without a way
    // back an accidental ＋ costs a dismiss and a reopen to reach Reply.
    const [full, setFull] = useState(false);
    const mounted = useRef(false);

    useEffect(() => {
        // The first action, not the first button — the close button leads in
        // DOM order (it is the sheet's top-right corner), and opening a menu
        // onto its own escape hatch would be a strange place to land.
        menuRef.current?.querySelector('.emoji-btn, .post-menu-item')?.focus();
    }, []);

    // Escape means "undo the last thing that opened", so it steps out of the
    // picker before it dismisses the menu. That makes its meaning depend on
    // `full`, which is why this resubscribes rather than binding once on mount
    // the way the focus effect above does — at most twice per opened menu,
    // since `full` only flips when the ＋ or the back button is pressed.
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.key !== 'Escape') return;
            if (full) setFull(false);
            else onDismiss();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [full]);

    // Focus follows the swap, or a keyboard user is left on a button that no
    // longer exists and the browser drops them back to the document. Skipped on
    // mount, where the effect above has already placed focus — this one owns
    // only the transitions between the menu's two bodies.
    useEffect(() => {
        if (!mounted.current) {
            mounted.current = true;
            return;
        }
        menuRef.current?.querySelector(full ? '.emoji-search' : '.emoji-more')?.focus();
    }, [full]);

    // Every item closes the menu first, then acts.
    const choose = (act) => () => {
        onClose();
        act();
    };

    return html`
        <div class="post-menu-scrim" onClick=${onDismiss}></div>
        <div class="post-menu" ref=${menuRef} role="group" aria-label="Note actions">
            <button class="post-menu-close" aria-label="Close menu" onClick=${onDismiss}>
                <${Icon} name="x" />
            </button>
            ${
                full
                    ? html`<${FullEmojiPicker}
                          post=${post}
                          onReact=${onReact}
                          onBack=${() => setFull(false)}
                      />`
                    : html`<${EmojiPicker}
                          post=${post}
                          onReact=${onReact}
                          onOpenFull=${() => setFull(true)}
                      />`
            }
            ${
                !full &&
                html`<div class="post-menu-items">
                    <button class="post-menu-item" onClick=${choose(() => onReply(post))}>
                        <${Icon} name="reply" filled=${dark} />
                        <span>Reply</span>
                    </button>
                    ${
                        post.mine &&
                        !editing &&
                        html`<button
                            class="post-menu-item"
                            onClick=${choose(() => onStartEdit(post.id))}
                        >
                            <${Icon} name="pencil" filled=${dark} />
                            <span>Edit</span>
                        </button>`
                    }
                    ${
                        post.mine &&
                        html`<button
                            class="post-menu-item post-menu-item-delete"
                            onClick=${choose(() => onDelete(post.id))}
                        >
                            <${Icon} name="trash" filled=${dark} />
                            <span>Delete</span>
                        </button>`
                    }
                </div>`
            }
        </div>
    `;
}

// Everything you can do to a note, behind one ⋯ button. Four inline buttons on
// your own notes crowded the meta line and left every note carrying controls it
// mostly does not need; one trigger opening a labelled menu costs a tap and
// gives each action a name and a target you can actually hit.
//
// This half renders on every note, so it deliberately holds nothing but the
// trigger and the two ways out — the menu's own state and subscriptions live in
// PostMenuPanel, which only exists while the menu is open.
function PostMenu({ post, editing, open, onToggle, onReply, onReact, onStartEdit, onDelete }) {
    const triggerRef = useRef(null);

    const close = () => onToggle(post.id);
    // Escape, a click on the scrim, and the sheet's close button are the three
    // ways out that leave you where you started, so they hand focus back to the
    // trigger — the close button included, since it is the phone's stand-in for
    // the Escape a phone has no key for. Choosing an item
    // deliberately does not: Reply focuses the compose box, Edit focuses the
    // edit box, and Delete removes the note — restoring focus here would fight
    // all three.
    const dismiss = () => {
        triggerRef.current?.focus();
        close();
    };

    return html`
        <div class="post-actions">
            <button
                ref=${triggerRef}
                class="post-action post-menu-trigger"
                title="Note actions"
                aria-label="Note actions"
                aria-haspopup="true"
                aria-expanded=${open}
                onClick=${() => onToggle(post.id)}
            >
                <${Icon} name="dots" />
            </button>
            ${
                open &&
                html`<${PostMenuPanel}
                    post=${post}
                    editing=${editing}
                    onClose=${close}
                    onDismiss=${dismiss}
                    onReply=${onReply}
                    onReact=${onReact}
                    onStartEdit=${onStartEdit}
                    onDelete=${onDelete}
                />`
            }
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
    menuOpen,
    onToggleMenu,
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
            </div>
            ${
                meId &&
                html`<${PostMenu}
                    post=${post}
                    editing=${editing}
                    open=${menuOpen}
                    onToggle=${onToggleMenu}
                    onReply=${onReply}
                    onReact=${onReact}
                    onStartEdit=${onStartEdit}
                    onDelete=${onDelete}
                />`
            }
        </li>
    `;
}
