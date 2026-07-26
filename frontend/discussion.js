import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useRefreshGuard, useRefreshOnFocus } from './hooks.js';
import { seasonLabel } from './utils.js';

const html = htm.bind(h);

export function SeasonView({ seasonId }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const fetchDiscussion = useCallback(
        () => api(`/api/seasons/${seasonId}/discussion`),
        [seasonId],
    );
    // beginMutation/endMutation are unused until Task 12 wires reveal/compose
    // mutations; kept destructured now so that wiring is a one-line diff there.
    // eslint-disable-next-line no-unused-vars
    const { refresh, beginMutation, endMutation } = useRefreshGuard(fetchDiscussion, setData);
    useRefreshOnFocus(refresh, setError);

    useEffect(() => {
        setLoading(true);
        refresh()
            .catch((err) => setError(err.message))
            .finally(() => setLoading(false));
    }, [refresh]);

    if (loading) return html`<div class="loading">Loading…</div>`;
    if (error) return html`<div class="error">${error}</div>`;
    if (!data) return null;

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
                        html`<div key=${ep.episode} class="episode-card">
                            Episode ${ep.episode} — ${ep.count} notes
                        </div>`,
                )}
            </div>
        </div>
    `;
}
