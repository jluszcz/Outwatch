import { h, render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import { setWatched, clearsCurrentlyWatching } from './utils.js';
import { api } from './api.js';
import { useTheme, useRefreshGuard, useRefreshOnFocus, useHashRoute } from './hooks.js';
import { Header, Board } from './board.js';
import { SeasonView } from './discussion.js';

const html = htm.bind(h);

function App() {
    const [users, setUsers] = useState([]);
    const [seasons, setSeasons] = useState([]);
    const [me, setMe] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const { theme, toggle: toggleTheme } = useTheme();
    const routeSeasonId = useHashRoute();

    const fetchBoard = useCallback(() => api('/api/board'), []);
    const applyBoard = useCallback((board) => {
        setUsers(board.users);
        setSeasons(board.seasons);
        setMe(board.me);
    }, []);
    const { refresh, beginMutation, endMutation } = useRefreshGuard(fetchBoard, applyBoard);
    useRefreshOnFocus(refresh, setError);

    useEffect(() => {
        (async () => {
            try {
                await refresh();
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        })();
    }, [refresh]);

    const meId = me?.id ?? null;

    // Keep the latest users in a ref so the optimistic callbacks can read the
    // current state without listing `users` in their deps — that would recreate
    // them on every board change and risk stale closures.
    const usersRef = useRef(users);
    usersRef.current = users;

    const setCurrentlyWatching = useCallback(
        async (seasonId) => {
            beginMutation();
            const prevSeasonId =
                usersRef.current.find((u) => u.id === meId)?.currently_watching_season_id ?? null;
            setUsers((current) =>
                current.map((u) =>
                    u.id === meId ? { ...u, currently_watching_season_id: seasonId } : u,
                ),
            );
            try {
                await api('/api/currently-watching', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ season_id: seasonId }),
                });
                setError(null);
            } catch (err) {
                setUsers((current) =>
                    current.map((u) =>
                        u.id === meId ? { ...u, currently_watching_season_id: prevSeasonId } : u,
                    ),
                );
                setError(err.message);
            } finally {
                endMutation();
            }
        },
        [meId, beginMutation, endMutation],
    );

    const toggle = useCallback(
        async (seasonId, checked) => {
            beginMutation();
            // Marking a season seen also clears it as your currently-watching
            // season (the server does this too) — you can't be mid-watch on
            // something you've finished.
            const clearsCurrent = clearsCurrentlyWatching(
                usersRef.current.find((u) => u.id === meId),
                seasonId,
                checked,
            );

            // Optimistic: flip the cell, then reconcile with the server.
            setSeasons((prev) =>
                prev.map((s) =>
                    s.id === seasonId
                        ? { ...s, watched_by: setWatched(s.watched_by, meId, checked) }
                        : s,
                ),
            );
            if (clearsCurrent) {
                setUsers((prev) =>
                    prev.map((u) =>
                        u.id === meId ? { ...u, currently_watching_season_id: null } : u,
                    ),
                );
            }
            try {
                if (checked) {
                    await api('/api/watched', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ season_id: seasonId }),
                    });
                } else {
                    await api(`/api/watched/${seasonId}`, { method: 'DELETE' });
                }
                setError(null);
            } catch (err) {
                // Revert the optimistic change on failure.
                setSeasons((prev) =>
                    prev.map((s) =>
                        s.id === seasonId
                            ? { ...s, watched_by: setWatched(s.watched_by, meId, !checked) }
                            : s,
                    ),
                );
                if (clearsCurrent) {
                    setUsers((prev) =>
                        prev.map((u) =>
                            u.id === meId ? { ...u, currently_watching_season_id: seasonId } : u,
                        ),
                    );
                }
                setError(err.message);
            } finally {
                endMutation();
            }
        },
        [meId, beginMutation, endMutation],
    );

    return html`
        <div class="container">
            <${Header} theme=${theme} onToggleTheme=${toggleTheme} />
            <main class="app">
                ${error && html`<div class="error">${error}</div>`}
                ${loading && html`<div class="loading">Loading…</div>`}
                ${
                    !loading &&
                    !me &&
                    users.length > 0 &&
                    routeSeasonId == null &&
                    html`
                        <div class="notice">
                            You're not on the watch list — the board is read-only.
                        </div>
                    `
                }
                ${
                    !loading &&
                    !error &&
                    users.length === 0 &&
                    routeSeasonId == null &&
                    html`
                        <div class="empty-state">
                            No users yet. Add people to the board (see README).
                        </div>
                    `
                }
                ${
                    !loading &&
                    routeSeasonId != null &&
                    html`<${SeasonView} key=${routeSeasonId} seasonId=${routeSeasonId} />`
                }
                ${
                    !loading &&
                    routeSeasonId == null &&
                    users.length > 0 &&
                    html`
                        <${Board}
                            users=${users}
                            seasons=${seasons}
                            meId=${meId}
                            onToggle=${toggle}
                            onSetCurrentlyWatching=${setCurrentlyWatching}
                        />
                    `
                }
            </main>
        </div>
    `;
}

render(html`<${App} />`, document.getElementById('root'));
