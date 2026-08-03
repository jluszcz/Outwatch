import { h } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useRefreshGuard, useRefreshOnFocus, useIsDark } from './hooks.js';
import { relativeTime, feedLine } from './utils.js';
import { Icon } from './icons.js';

const html = htm.bind(h);

// The panel: the scrim, the list, and the phone layout's close button. Split
// out of FeedBell so its Escape listener and its scrim are subscribed only
// while it is open — the same split PostMenu/PostMenuPanel draws, for the same
// reason.
function FeedPanel({ data, error, onClose }) {
    const dark = useIsDark();
    const panelRef = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    // Focus into the panel so a keyboard user is not left behind on the trigger
    // with a list they cannot reach.
    useEffect(() => {
        panelRef.current?.querySelector('.feed-item, .feed-close')?.focus();
    }, []);

    const events = data?.events ?? [];
    const nowMs = data ? Date.parse(data.now) : Date.now();

    return html`
        <div class="feed-scrim" onClick=${onClose}></div>
        <div class="feed-panel" ref=${panelRef} role="group" aria-label="Recent activity">
            <button class="feed-close" onClick=${onClose} aria-label="Close">
                <${Icon} name="x" filled=${dark} />
            </button>
            ${
                error
                    ? html`<p class="feed-empty">Couldn't load activity.</p>`
                    : events.length === 0
                      ? html`<p class="feed-empty">Nothing new yet.</p>`
                      : html`
                            <ul class="feed-list">
                                ${events.map(
                                    (event) => html`
                                        <li
                                            key=${`${event.season_id}-${event.episode}-${event.at}`}
                                        >
                                            <a
                                                class=${'feed-item' + (event.unread ? ' unread' : '')}
                                                href=${`#/season/${event.season_id}/episode/${event.episode}`}
                                                onClick=${onClose}
                                            >
                                                <span class="feed-text">${feedLine(event)}</span>
                                                <span class="feed-when"
                                                    >${relativeTime(event.at, nowMs)}</span
                                                >
                                            </a>
                                        </li>
                                    `,
                                )}
                            </ul>
                        `
            }
        </div>
    `;
}

// The bell and its badge.
//
// Fetches through useRefreshGuard like every other fetch in the app, so a slow
// response cannot overwrite a newer one, and refetches on focus so the badge is
// right after the tab has been in the background.
export function FeedBell() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [open, setOpen] = useState(false);
    // Whether the badge has been cleared optimistically. Deliberately separate
    // from the per-event `unread` flags, which keep their marks until the next
    // fetch — otherwise every mark would vanish from under you at the moment
    // you opened the panel to read them.
    const [seen, setSeen] = useState(false);
    const dark = useIsDark();

    const fetchFeed = useCallback(() => api('/api/feed'), []);
    const applyFeed = useCallback((next) => {
        setData(next);
        setSeen(false);
    }, []);
    const { refresh } = useRefreshGuard(fetchFeed, applyFeed);
    useRefreshOnFocus(refresh, setError);

    useEffect(() => {
        refresh().catch((err) => setError(err.message));
    }, [refresh]);

    const openPanel = useCallback(async () => {
        setOpen(true);
        setSeen(true);
        try {
            await api('/api/feed/seen', { method: 'POST' });
        } catch {
            // Not worth a banner in the header: the badge coming back is the
            // whole story, and the next open retries it.
            setSeen(false);
        }
    }, []);

    const unread = seen ? 0 : (data?.unread_count ?? 0);
    const label = unread > 0 ? `What's new (${unread} unread)` : "What's new";

    return html`
        <div class="feed-wrap">
            <button
                class="feed-btn"
                aria-haspopup="true"
                aria-expanded=${open}
                aria-label=${label}
                title=${label}
                onClick=${() => (open ? setOpen(false) : openPanel())}
            >
                <${Icon} name="bell" filled=${dark} />
                ${unread > 0 ? html`<span class="feed-badge">${unread}</span>` : null}
            </button>
            ${open && html`<${FeedPanel} data=${data} error=${error} onClose=${() => setOpen(false)} />`}
        </div>
    `;
}
