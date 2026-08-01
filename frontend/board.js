import { h } from 'preact';
import { useState, useMemo, useEffect } from 'preact/hooks';
import htm from 'htm';
import {
    seasonLabel,
    seasonParts,
    abbreviateName,
    isFullyWatched,
    sortSeasons,
    sortBySeenCount,
    selectableSeasons,
} from './utils.js';
import { Icon } from './icons.js';
import { useIsDark } from './hooks.js';

const html = htm.bind(h);

// How long a jumped-to row stays lit. Long enough to find the row after the
// scroll settles, short enough that it is gone before you act on it.
const FLASH_MS = 1600;

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

function SeasonRow({ season, users, meId, fullyWatched, flash, dark, onToggle }) {
    const { number, subtitle } = seasonParts(season);
    const rowClass = [fullyWatched ? 'watched-all' : '', flash ? 'flash' : '']
        .filter(Boolean)
        .join(' ');
    // The id is what NowWatching's jump buttons scroll to. Keyed on the season
    // rather than the row's position, so it survives a re-sort.
    return html`
        <tr id=${`season-row-${season.id}`} class=${rowClass}>
            <td class="season-cell">
                <div class="season-cell-row">
                    <a href=${`#/season/${season.id}`} aria-label=${seasonLabel(season)}
                        ><span class="season-num">${number}</span
                        >${subtitle ? html`<span class="season-sub">${subtitle}</span>` : null}</a
                    >
                    ${
                        season.post_count > 0
                            ? html`<span class="post-badge" title=${`${season.post_count} notes`}
                                  ><${Icon} name="chat" filled=${dark} />${season.post_count}</span
                              >`
                            : null
                    }
                </div>
            </td>
            ${users.map((u) => {
                const checked = season.watched_by.includes(u.id);
                const isMe = u.id === meId;
                const isCurrentlyWatching = u.currently_watching_season_id === season.id;
                return html`
                    <td key=${u.id} class=${'check-cell' + (isMe ? ' mine' : '')}>
                        <label
                            class="check-hit"
                            title=${isMe ? undefined : `Only ${u.name} can change this`}
                        >
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
// everyone else's is read-only. Each chip also leads with a jump button that
// scrolls that person's season into view down in the board.
function NowWatching({ users, seasons, meId, onSetCurrentlyWatching, onJump }) {
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
                                // Gated on the season being found rather than on cwId alone: the
                                // button's label names the season, so there is nothing to say
                                // about an id the board did not send a season for.
                                current
                                    ? html`<button
                                          class="nw-jump"
                                          aria-label=${`Jump to ${
                                              isMe ? 'your' : `${u.name}'s`
                                          } current season, ${seasonLabel(current)}`}
                                          onClick=${() => onJump(current.id)}
                                      >
                                          ▶
                                      </button>`
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
    const [flashId, setFlashId] = useState(null);
    // Subscribed once for the whole board rather than per row: useIsDark costs a
    // MutationObserver per calling component, and SeasonRow renders ~50 times.
    const dark = useIsDark();
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

    useEffect(() => {
        if (flashId == null) return undefined;
        const timer = setTimeout(() => setFlashId(null), FLASH_MS);
        return () => clearTimeout(timer);
    }, [flashId]);

    // Scrolling alone leaves you hunting for the row you landed on, so the jump
    // also lights it. Focus moves to the season link — with preventScroll, since
    // scrollIntoView is what decides where the row sits — so the jump goes
    // somewhere for a keyboard user instead of only moving the viewport.
    const jumpTo = (seasonId) => {
        const row = document.getElementById(`season-row-${seasonId}`);
        if (!row) return;
        row.querySelector('.season-cell a')?.focus({ preventScroll: true });
        row.scrollIntoView({
            block: 'center',
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
        setFlashId(seasonId);
    };

    return html`
        <div>
            <${NowWatching}
                users=${orderedUsers}
                seasons=${seasons}
                meId=${meId}
                onSetCurrentlyWatching=${onSetCurrentlyWatching}
                onJump=${jumpTo}
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
                                        <span class="user-name-full">${u.name}</span
                                        ><span class="user-name-short"
                                            >${abbreviateName(u.name)}</span
                                        >${
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
                                    flash=${s.id === flashId}
                                    dark=${dark}
                                    onToggle=${onToggle}
                                />`,
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}
