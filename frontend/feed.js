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
//
// `onDismiss` (Escape, the scrim, the close button) hands focus back to the
// bell; `onClose` (choosing a feed line) does not, matching PostMenu's items —
// a feed line navigates away, so there is nowhere for focus to usefully return
// to.
function FeedPanel({ data, error, onClose, onDismiss }) {
    const panelRef = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'Escape') onDismiss();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onDismiss]);

    // What the panel opened with, frozen for as long as it stays open — not a
    // read of the live `data` prop, which FeedBell can replace out from under
    // it. `data` is shared with the badge, and useRefreshGuard can run a
    // queued refetch (beginMutation/endMutation in openPanel below) while the
    // panel is still on screen; applying that response here would re-render
    // the open list with every `unread` mark cleared, mid-read. The spec's
    // rule is that a mark holds until the *next* fetch, not until whichever
    // fetch happens to land while the panel is open, so the panel has to keep
    // looking at the response it was opened with. FeedPanel mounts fresh each
    // time the panel opens, so the snapshot naturally refreshes on the next
    // open.
    //
    // Not a bare useState initialiser, though: the panel can open before the
    // first fetch has ever resolved, and an initialiser runs once, on mount.
    // Freezing `null` there left the panel on "Loading…" for as long as it
    // stayed open — the response arriving was just a new prop into an
    // already-mounted component, and only closing and reopening it recovered.
    // So adopt the first non-null response, and only that one: once the
    // snapshot holds something, this stops firing and a later refetch still
    // cannot clear the marks out from under a reader.
    const [snapshot, setSnapshot] = useState(() => data);
    useEffect(() => {
        if (snapshot == null && data != null) setSnapshot(data);
    }, [snapshot, data]);

    // Focus the first real item, not the first button: .feed-close leads in
    // DOM order (it's the sheet's top-right corner), so a selector list that
    // included it would win here the same way PostMenuPanel's focus effect
    // documents avoiding for '.post-menu-close'. It's also display: none on a
    // pointer device, where a selector that could only match it would be a
    // silent no-op and leave a keyboard user's focus in the document instead
    // of the panel. Falls back to the panel itself — given a tabIndex below
    // for exactly this — when there is nothing to focus yet: still loading,
    // empty, or errored.
    useEffect(() => {
        const first = panelRef.current?.querySelector('.feed-item');
        (first ?? panelRef.current)?.focus();
    }, []);

    const events = snapshot?.events ?? [];
    // Skew, not the frozen fetch-time stamp itself: computed once against
    // snapshot.now and then applied to a live Date.now(), the same split
    // discussion.js's serverSkewMs draws, so an age keeps advancing for as
    // long as the panel stays open instead of stopping the instant the
    // response landed.
    const serverSkewMs = snapshot ? Date.parse(snapshot.now) - Date.now() : 0;
    const nowMs = Date.now() + serverSkewMs;

    return html`
        <div class="feed-scrim" onClick=${onDismiss}></div>
        <div
            class="feed-panel"
            ref=${panelRef}
            role="group"
            aria-label="Recent activity"
            tabindex="-1"
        >
            <button class="feed-close" onClick=${onDismiss} aria-label="Close">
                <${Icon} name="x" />
            </button>
            ${
                error
                    ? html`<p class="feed-empty">Couldn't load activity.</p>`
                    : !snapshot
                      ? html`<p class="feed-empty">Loading…</p>`
                      : events.length === 0
                        ? html`<p class="feed-empty">Nothing new yet.</p>`
                        : html`
                              <ul class="feed-list">
                                  ${events.map(
                                      (event) => html`
                                          <li
                                              key=${`${event.season_id}-${event.episode}-${event.at}-${event.author_name}`}
                                          >
                                              <a
                                                  class=${
                                                      'feed-item' + (event.unread ? ' unread' : '')
                                                  }
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
    const triggerRef = useRef(null);

    const fetchFeed = useCallback(() => api('/api/feed'), []);
    const applyFeed = useCallback((next) => {
        setData(next);
        setSeen(false);
    }, []);
    const { refresh, beginMutation, endMutation } = useRefreshGuard(fetchFeed, applyFeed);
    useRefreshOnFocus(refresh, setError);

    useEffect(() => {
        refresh().catch((err) => setError(err.message));
    }, [refresh]);

    const close = useCallback(() => setOpen(false), []);
    // Escape, the scrim, and the close button leave you where you started, so
    // they hand focus back to the trigger — matching PostMenu's `dismiss`.
    // Choosing a feed line does not: it navigates away, so `close` (not this)
    // is what that path uses.
    const dismiss = useCallback(() => {
        triggerRef.current?.focus();
        close();
    }, [close]);

    const markSeen = useCallback(async () => {
        setSeen(true);
        // Brackets the same optimistic-write race every other mutation in this
        // app guards against: a focus refetch landing between the optimistic
        // setSeen(true) and this POST resolving would otherwise apply a
        // response fetched before the server was stamped, carrying the old
        // unread_count — the badge would come back and stay wrong until some
        // later fetch. beginMutation defers that refetch until endMutation
        // below lets it through.
        beginMutation();
        try {
            await api('/api/feed/seen', { method: 'POST' });
        } catch {
            // Not worth a banner in the header: the badge coming back is the
            // whole story, and the next open retries it.
            setSeen(false);
        } finally {
            endMutation();
        }
    }, [beginMutation, endMutation]);

    // Marking read is driven by an effect rather than by the click, because
    // the two things it needs — the panel being open and there being a
    // response to mark — do not always arrive together. Opening before the
    // first fetch resolves has nothing to stamp yet, and stamping anyway would
    // burn unread marks the panel never got to show; but the click has long
    // since returned by the time the response lands, so nothing was left to
    // retry it and that opening never marked anything read at all. Keyed on
    // both, it fires whenever the pair is first satisfied, whichever order
    // they arrive in.
    //
    // The ref makes it once per opening rather than once per response: the
    // POST's own endMutation can release a queued refetch, and that new `data`
    // must not stamp the server a second time.
    const markedRef = useRef(false);
    useEffect(() => {
        if (!open) {
            markedRef.current = false;
            return;
        }
        if (!data || markedRef.current) return;
        markedRef.current = true;
        markSeen();
    }, [open, data, markSeen]);

    const unread = seen ? 0 : (data?.unread_count ?? 0);
    const label = unread > 0 ? `What's new (${unread} unread)` : "What's new";

    return html`
        <div class="feed-wrap">
            <button
                ref=${triggerRef}
                class="feed-btn"
                aria-haspopup="true"
                aria-expanded=${open}
                aria-label=${label}
                title=${label}
                onClick=${() => (open ? close() : setOpen(true))}
            >
                <${Icon} name="bell" filled=${dark} />
                ${unread > 0 ? html`<span class="feed-badge">${unread}</span>` : null}
            </button>
            ${
                open &&
                html`<${FeedPanel}
                    data=${data}
                    error=${error}
                    onClose=${close}
                    onDismiss=${dismiss}
                />`
            }
        </div>
    `;
}
