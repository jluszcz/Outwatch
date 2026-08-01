import { h } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import htm from 'htm';
import RAW_GROUPS from './emoji-data.json';
import { Icon } from './icons.js';
import { isReactionEmoji } from '../shared/reactions.js';

const html = htm.bind(h);

// The full Unicode emoji set, generated into emoji-data.json by
// generate-emoji-data.js and inlined by esbuild. Shaped
// [[groupName, [[emoji, name], ...]], ...] — positional because it is machine
// written and the array form is a third of the JSON's size.
//
// Filtered on load through the very rule the Worker validates with, so the
// picker cannot offer a button the server would reject. That filter is not
// ceremony: emoji-data.json tracks the newest Unicode release, while
// `\p{RGI_Emoji}` resolves against the Unicode version the running engine was
// built with, so the freshest emoji in the file are not yet RGI anywhere and a
// few dozen entries really are dropped here. Doing it at load rather than at
// generate time means the engine deciding is the engine rendering — a browser
// never offers an emoji it cannot itself classify — and newly-recognized emoji
// appear as browsers update, with no regeneration.
//
// Not airtight in one direction: a browser whose Unicode table is *newer* than
// the Worker's can still offer something workerd refuses, which surfaces as an
// error banner on a brand-new emoji. Self-correcting as workerd updates, and
// the alternative — freezing the set to one machine's Unicode version at
// generate time — is worse for a rarer payoff.
const EMOJI_GROUPS = RAW_GROUPS.map(([group, emojis]) => [
    group,
    emojis.filter(([emoji]) => isReactionEmoji(emoji)),
]).filter(([, emojis]) => emojis.length > 0);

// emoji -> name, flattened once at module load. Used for a picker button's and
// a chip's accessible name, so it is worth the one-time pass over ~1900 entries
// rather than a scan per render.
const NAMES = new Map(EMOJI_GROUPS.flatMap(([, emojis]) => emojis));

// A flat [emoji, name] list, built once, for search. Searching the grouped
// shape would mean rebuilding the grouping on every keystroke for a result that
// is shown ungrouped anyway.
const ALL = EMOJI_GROUPS.flatMap(([, emojis]) => emojis);

// What to call an emoji out loud. Falls back to the character itself for
// anything the bundled data does not know — a reaction stored before this data
// was generated, or one from a Unicode version newer than it. A screen reader
// announcing the emoji is a worse label than its name but a much better one
// than nothing, and it keeps a chip usable rather than unlabelled.
export function emojiName(emoji) {
    return NAMES.get(emoji) ?? emoji;
}

// Emoji whose name contains every whitespace-separated term in the query, in
// any order — so "cat face" and "face cat" both find 😺. Exported for tests.
// An empty or whitespace-only query returns null rather than everything, which
// is how the component tells "show the browsable groups" from "show 0 results".
export function searchEmoji(query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    return ALL.filter(([, name]) => {
        const lower = name.toLowerCase();
        return terms.every((t) => lower.includes(t));
    });
}

// The full picker: a search field over the whole emoji set, and the set itself
// grouped by Unicode category when nothing is being searched.
//
// Roughly 1900 buttons render at once, which is the reason for the per-group
// `content-visibility: auto` in styles.css: the browser skips layout and paint
// for the groups that are scrolled out of view, so this costs about what a
// screenful costs without a windowing library, a scroll listener, or any JS
// measurement — the same "let the browser measure" call the menu's
// `position-try-fallbacks` makes.
//
// `chosen` comes from the server's `mine` flags, like the quick row's, so the
// `on` this sends is always computed from what the server last said.
//
// `onBack` returns to the menu's actions rather than closing the menu, since
// the picker replaced them: without it, an accidental ＋ costs a dismiss and a
// reopen to reach Reply. It is the only control here that does not react —
// choosing an emoji still closes the whole menu.
export function FullEmojiPicker({ post, onReact, onBack }) {
    const [query, setQuery] = useState('');
    const chosen = useMemo(
        () => new Set(post.reactions.filter((r) => r.mine).map((r) => r.emoji)),
        [post.reactions],
    );
    const matches = useMemo(() => searchEmoji(query), [query]);

    const cell = ([emoji, name]) => html`
        <button
            key=${emoji}
            class="emoji-btn"
            aria-label=${name}
            aria-pressed=${chosen.has(emoji)}
            onClick=${() => onReact(post.id, emoji, !chosen.has(emoji))}
        >
            ${emoji}
        </button>
    `;

    return html`
        <div class="emoji-full">
            <div class="emoji-head">
                <button class="emoji-back" aria-label="Back to note actions" onClick=${onBack}>
                    <${Icon} name="chevronLeft" />
                </button>
                <input
                    class="emoji-search"
                    type="search"
                    value=${query}
                    placeholder="Search emoji"
                    aria-label="Search emoji"
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                    onInput=${(e) => setQuery(e.target.value)}
                />
            </div>
            <div class="emoji-scroll">
                ${
                    matches === null
                        ? EMOJI_GROUPS.map(
                              ([group, emojis]) => html`
                                  <section key=${group} class="emoji-group">
                                      <h4 class="emoji-group-title">${group}</h4>
                                      <div class="emoji-grid">${emojis.map(cell)}</div>
                                  </section>
                              `,
                          )
                        : matches.length === 0
                          ? html`<p class="emoji-empty">No emoji match “${query}”.</p>`
                          : html`<div class="emoji-grid">${matches.map(cell)}</div>`
                }
            </div>
        </div>
    `;
}
