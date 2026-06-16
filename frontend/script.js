import { h, render } from 'preact';
import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import htm from 'htm';
import { seasonLabel, isFullyWatched, sortSeasons } from './utils.js';

const html = htm.bind(h);

async function api(path, options = {}) {
    const r = await fetch(path, options);
    if (!r.ok) {
        let msg = `${options.method || 'GET'} ${path} failed: ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch {}
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
        const handler = e => {
            // Manual override in localStorage takes priority; only follow OS if none set.
            const stored = localStorage.getItem('theme');
            if (stored === 'light' || stored === 'dark') return;
            setTheme(e.matches ? 'dark' : 'light');
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    const toggle = useCallback(
        () => setTheme(t => t === 'dark' ? 'light' : 'dark'),
        [],
    );

    return { theme, toggle };
}

// Lucide icons (MIT) — currentColor inherits button color from CSS
const SunIcon = () => html`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4"/>
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
    </svg>
`;

const MoonIcon = () => html`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
    </svg>
`;

function Header({ theme, onToggleTheme }) {
    const title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    return html`
        <header class="header">
            <h1 class="title">Outwit, Outplay, Outlast, Outwatch</h1>
            <button class="theme-btn" title=${title} onClick=${onToggleTheme}>
                ${theme === 'dark' ? html`<${SunIcon}/>` : html`<${MoonIcon}/>`}
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
            ${users.map(u => {
                const checked = season.watched_by.includes(u.id);
                const isMe = u.id === meId;
                return html`
                    <td key=${u.id} class=${'check-cell' + (isMe ? ' mine' : '')}>
                        <input
                            type="checkbox"
                            checked=${checked}
                            disabled=${!isMe}
                            title=${isMe ? '' : `Only ${u.name} can change this`}
                            onChange=${isMe ? e => onToggle(season.id, e.target.checked) : undefined}
                        />
                    </td>
                `;
            })}
        </tr>
    `;
}

function Board({ users, seasons, meId, onToggle }) {
    const userCount = users.length;
    const sorted = useMemo(() => sortSeasons(seasons, userCount), [seasons, userCount]);
    // Show the current user's column left-most.
    const orderedUsers = useMemo(
        () => [...users].sort((a, b) => (b.id === meId) - (a.id === meId)),
        [users, meId],
    );

    return html`
        <div class="table-wrapper">
            <table id="board">
                <thead>
                    <tr>
                        <th class="season-head">Season</th>
                        ${orderedUsers.map(u => html`
                            <th key=${u.id} class=${'check-head' + (u.id === meId ? ' mine' : '')}>
                                ${u.name}${u.id === meId ? html`<span class="you"> (you)</span>` : null}
                            </th>
                        `)}
                    </tr>
                </thead>
                <tbody>
                    ${sorted.map(s => html`<${SeasonRow}
                        key=${s.id}
                        season=${s}
                        users=${orderedUsers}
                        meId=${meId}
                        fullyWatched=${isFullyWatched(s, userCount)}
                        onToggle=${onToggle}
                    />`)}
                </tbody>
            </table>
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

    const toggle = useCallback(async (seasonId, checked) => {
        // Optimistic: flip the cell, then reconcile with the server.
        setSeasons(prev => prev.map(s => {
            if (s.id !== seasonId) return s;
            const watched_by = checked
                ? [...s.watched_by, meId]
                : s.watched_by.filter(id => id !== meId);
            return { ...s, watched_by };
        }));
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
            setSeasons(prev => prev.map(s => {
                if (s.id !== seasonId) return s;
                const watched_by = checked
                    ? s.watched_by.filter(id => id !== meId)
                    : [...s.watched_by, meId];
                return { ...s, watched_by };
            }));
            setError(err.message);
        }
    }, [meId]);

    return html`
        <div class="container">
            <${Header} theme=${theme} onToggleTheme=${toggleTheme} />
            <main class="app">
                ${error && html`<div class="error">${error}</div>`}
                ${loading && html`<div class="loading">Loading…</div>`}
                ${!loading && !error && !me && html`
                    <div class="notice">You're not on the watch list — the board is read-only.</div>
                `}
                ${!loading && !error && users.length === 0 && html`
                    <div class="empty-state">No users yet. Add people to the board (see README).</div>
                `}
                ${!loading && !error && users.length > 0 && html`
                    <${Board} users=${users} seasons=${seasons} meId=${meId} onToggle=${toggle} />
                `}
            </main>
        </div>
    `;
}

render(html`<${App} />`, document.getElementById('root'));
