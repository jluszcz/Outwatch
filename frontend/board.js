import { h } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import htm from 'htm';
import {
    seasonLabel,
    seasonParts,
    isFullyWatched,
    sortSeasons,
    sortBySeenCount,
    selectableSeasons,
} from './utils.js';

const html = htm.bind(h);

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

export function Header({ theme, onToggleTheme }) {
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
    const { number, subtitle } = seasonParts(season);
    return html`
        <tr class=${fullyWatched ? 'watched-all' : ''}>
            <td class="season-cell">
                <a
                    class="season-link"
                    href=${`#/season/${season.id}`}
                    aria-label=${seasonLabel(season)}
                    ><span class="season-num">${number}</span
                    >${subtitle ? html`<span class="season-sub">${subtitle}</span>` : null}</a
                >
                ${
                    season.post_count > 0
                        ? html`<span class="post-badge" title=${`${season.post_count} notes`}>
                              💬 ${season.post_count}
                          </span>`
                        : null
                }
            </td>
            ${users.map((u) => {
                const checked = season.watched_by.includes(u.id);
                const isMe = u.id === meId;
                const isCurrentlyWatching = u.currently_watching_season_id === season.id;
                return html`
                    <td key=${u.id} class=${'check-cell' + (isMe ? ' mine' : '')}>
                        <label class="check-hit">
                            ${
                                isCurrentlyWatching
                                    ? html`<span
                                          class="watching-indicator"
                                          role="img"
                                          aria-label=${`${u.name} is currently watching this season`}
                                          >▶</span
                                      >`
                                    : null
                            }
                            <input
                                type="checkbox"
                                checked=${checked}
                                disabled=${!isMe}
                                aria-label=${`${u.name} watched ${seasonLabel(season)}`}
                                title=${isMe ? '' : `Only ${u.name} can change this`}
                                onChange=${
                                    isMe ? (e) => onToggle(season.id, e.target.checked) : undefined
                                }
                            />
                        </label>
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
                            class=${
                                'nw-chip' + (isMe ? ' mine' : '') + (cwId != null ? ' active' : '')
                            }
                        >
                            ${
                                cwId != null
                                    ? html`<span class="nw-marker" aria-hidden="true">▶</span>`
                                    : null
                            }
                            <span class="nw-name">${isMe ? 'You' : u.name}</span>
                            ${
                                isMe
                                    ? html`<select
                                          class="nw-select"
                                          aria-label="Your currently watching season"
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
                                      >`
                            }
                        </div>
                    `;
                })}
            </div>
        </div>
    `;
}

export function Board({ users, seasons, meId, onToggle, onSetCurrentlyWatching }) {
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
                    aria-pressed=${sortMode === 'season'}
                    onClick=${() => setSortMode('season')}
                >
                    Season
                </button>
                <button
                    class=${'sort-btn' + (sortMode === 'seen' ? ' active' : '')}
                    aria-pressed=${sortMode === 'seen'}
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
                                        ${u.name}${
                                            u.id === meId
                                                ? html`<span class="you"> (you)</span>`
                                                : null
                                        }
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
