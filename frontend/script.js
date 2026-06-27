import { h, render } from 'preact';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import {
    seasonLabel,
    isFullyWatched,
    sortSeasons,
    sortBySeenCount,
    selectableSeasons,
    clearsCurrentlyWatching,
} from './utils.js';

const html = htm.bind(h);

async function api(path, options = {}) {
    const r = await fetch(path, options);
    if (!r.ok) {
        let msg = `${options.method || 'GET'} ${path} failed: ${r.status}`;
        try {
            msg = (await r.json()).error || msg;
        } catch {}
        throw new Error(msg);
    }
    return r.json();
}

function useTheme() {
    const [theme, setTheme] = useState(() => {
        const stored = localStorage.getItem('theme');
        if (stored === 'light' || stored === 'dark') return stored;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    });

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('theme', theme);
    }, [theme]);

    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e) => {
            // Manual override in localStorage takes priority; only follow OS if none set.
            const stored = localStorage.getItem('theme');
            if (stored === 'light' || stored === 'dark') return;
            setTheme(e.matches ? 'dark' : 'light');
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

    return { theme, toggle };
}

// Lucide icons (MIT) — currentColor inherits button color from CSS
const SunIcon = () => html`
    <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <circle cx="12" cy="12" r="4" />
        <path
            d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
        />
    </svg>
`;

const MoonIcon = () => html`
    <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
`;

function Header({ theme, onToggleTheme }) {
    const title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    return html`
        <header class="header">
            <h1 class="title">Outwit, Outplay, Outlast, Outwatch</h1>
            <button class="theme-btn" title=${title} onClick=${onToggleTheme}>
                ${theme === 'dark' ? html`<${SunIcon} />` : html`<${MoonIcon} />`}
            </button>
        </header>
    `;
}

function SeasonRow({ season, users, meId, fullyWatched, onToggle }) {
    return html`
        <tr class=${fullyWatched ? 'watched-all' : ''}>
            <td class="season-cell">
                <a href=${season.wikipedia_url} target="_blank" rel="noopener noreferrer">
                    ${seasonLabel(season)}
                </a>
            </td>
            ${users.map((u) => {
                const checked = season.watched_by.includes(u.id);
                const isMe = u.id === meId;
                const isCurrentlyWatching = u.currently_watching_season_id === season.id;
                return html`
                    <td key=${u.id} class=${'check-cell' + (isMe ? ' mine' : '')}>
                        ${isCurrentlyWatching
                            ? html`<span class="watching-indicator" aria-label="Currently watching"
                                  >▶</span
                              >`
                            : null}
                        <input
                            type="checkbox"
                            checked=${checked}
                            disabled=${!isMe}
                            title=${isMe ? '' : `Only ${u.name} can change this`}
                            onChange=${isMe
                                ? (e) => onToggle(season.id, e.target.checked)
                                : undefined}
                        />
                    </td>
                `;
            })}
        </tr>
    `;
}

// A summary strip above the board: one chip per person showing the season they're
// currently on. Your own chip is editable (pick from your unwatched seasons);
// everyone else's is read-only.
function NowWatching({ users, seasons, meId, onSetCurrentlyWatching }) {
    return html`
        <div class="now-watching">
            <span class="now-watching-label">Now Watching</span>
            <div class="now-watching-items">
                ${users.map((u) => {
                    const isMe = u.id === meId;
                    const cwId = u.currently_watching_season_id;
                    const current = cwId != null ? seasons.find((s) => s.id === cwId) : null;
                    return html`
                        <div
                            key=${u.id}
                            class=${'nw-chip' +
                            (isMe ? ' mine' : '') +
                            (cwId != null ? ' active' : '')}
                        >
                            ${cwId != null ? html`<span class="nw-marker">▶</span>` : null}
                            <span class="nw-name">${isMe ? 'You' : u.name}</span>
                            ${isMe
                                ? html`<select
                                      class="nw-select"
                                      value=${cwId ?? ''}
                                      onChange=${(e) =>
                                          onSetCurrentlyWatching(
                                              e.target.value ? Number(e.target.value) : null,
                                          )}
                                  >
                                      <option value="">Not watching</option>
                                      ${selectableSeasons(seasons, meId).map(
                                          (s) => html`
                                              <option key=${s.id} value=${s.id}>
                                                  ${seasonLabel(s)}
                                              </option>
                                          `,
                                      )}
                                  </select>`
                                : html`<span class="nw-season"
                                      >${current ? seasonLabel(current) : '—'}</span
                                  >`}
                        </div>
                    `;
                })}
            </div>
        </div>
    `;
}

function Board({ users, seasons, meId, onToggle, onSetCurrentlyWatching }) {
    const [sortMode, setSortMode] = useState('season');
    const userCount = users.length;
    const sorted = useMemo(
        () =>
            sortMode === 'seen'
                ? sortBySeenCount(seasons, userCount)
                : sortSeasons(seasons, userCount),
        [seasons, userCount, sortMode],
    );
    // Show the current user's column left-most.
    const orderedUsers = useMemo(
        () => [...users].sort((a, b) => (b.id === meId) - (a.id === meId)),
        [users, meId],
    );

    return html`
        <div>
            <${NowWatching}
                users=${orderedUsers}
                seasons=${seasons}
                meId=${meId}
                onSetCurrentlyWatching=${onSetCurrentlyWatching}
            />
            <div class="sort-controls">
                <span class="sort-label">Sort by</span>
                <button
                    class=${'sort-btn' + (sortMode === 'season' ? ' active' : '')}
                    onClick=${() => setSortMode('season')}
                >
                    Season
                </button>
                <button
                    class=${'sort-btn' + (sortMode === 'seen' ? ' active' : '')}
                    onClick=${() => setSortMode('seen')}
                >
                    Seen Count
                </button>
            </div>
            <div class="table-wrapper">
                <table id="board">
                    <thead>
                        <tr>
                            <th class="season-head">Season</th>
                            ${orderedUsers.map(
                                (u) => html`
                                    <th
                                        key=${u.id}
                                        class=${'check-head' + (u.id === meId ? ' mine' : '')}
                                    >
                                        ${u.name}${u.id === meId
                                            ? html`<span class="you"> (you)</span>`
                                            : null}
                                    </th>
                                `,
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        ${sorted.map(
                            (s) =>
                                html`<${SeasonRow}
                                    key=${s.id}
                                    season=${s}
                                    users=${orderedUsers}
                                    meId=${meId}
                                    fullyWatched=${isFullyWatched(s, userCount)}
                                    onToggle=${onToggle}
                                />`,
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function App() {
    const [users, setUsers] = useState([]);
    const [seasons, setSeasons] = useState([]);
    const [me, setMe] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const { theme, toggle: toggleTheme } = useTheme();

    useEffect(() => {
        (async () => {
            try {
                const board = await api('/api/board');
                setUsers(board.users);
                setSeasons(board.seasons);
                setMe(board.me);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const meId = me?.id ?? null;

    // Keep the latest users in a ref so the optimistic callbacks can read the
    // current state without listing `users` in their deps — that would recreate
    // them on every board change and risk stale closures.
    const usersRef = useRef(users);
    usersRef.current = users;

    const setCurrentlyWatching = useCallback(
        async (seasonId) => {
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
            }
        },
        [meId],
    );

    const toggle = useCallback(
        async (seasonId, checked) => {
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
                prev.map((s) => {
                    if (s.id !== seasonId) return s;
                    const watched_by = checked
                        ? [...s.watched_by, meId]
                        : s.watched_by.filter((id) => id !== meId);
                    return { ...s, watched_by };
                }),
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
                    prev.map((s) => {
                        if (s.id !== seasonId) return s;
                        const watched_by = checked
                            ? s.watched_by.filter((id) => id !== meId)
                            : [...s.watched_by, meId];
                        return { ...s, watched_by };
                    }),
                );
                if (clearsCurrent) {
                    setUsers((prev) =>
                        prev.map((u) =>
                            u.id === meId ? { ...u, currently_watching_season_id: seasonId } : u,
                        ),
                    );
                }
                setError(err.message);
            }
        },
        [meId],
    );

    return html`
        <div class="container">
            <${Header} theme=${theme} onToggleTheme=${toggleTheme} />
            <main class="app">
                ${error && html`<div class="error">${error}</div>`}
                ${loading && html`<div class="loading">Loading…</div>`}
                ${!loading &&
                !error &&
                !me &&
                html`
                    <div class="notice">You're not on the watch list — the board is read-only.</div>
                `}
                ${!loading &&
                !error &&
                users.length === 0 &&
                html`
                    <div class="empty-state">
                        No users yet. Add people to the board (see README).
                    </div>
                `}
                ${!loading &&
                !error &&
                users.length > 0 &&
                html`
                    <${Board}
                        users=${users}
                        seasons=${seasons}
                        meId=${meId}
                        onToggle=${toggle}
                        onSetCurrentlyWatching=${setCurrentlyWatching}
                    />
                `}
            </main>
        </div>
    `;
}

render(html`<${App} />`, document.getElementById('root'));
