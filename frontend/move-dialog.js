import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { useSubmitGuard } from './hooks.js';
import { moveTarget, episodeNumbers } from './utils.js';

const html = htm.bind(h);

// Moves the caller's own notes on one episode to another Survivor episode — the
// repair for notes posted on the wrong one. TV Talk (../TvTalk) has the same
// dialog with a show picker as well; Outwatch's API only speaks Survivor, so
// moving notes to another show is done from there.
//
// A native modal <dialog>, the app's only one: showModal() brings the focus
// trap, Escape, and the backdrop with it. Not optimistic, like SeasonForm: the
// server decides which notes are the caller's and folds each episode's timer
// correction into the moved offsets, so success refetches the view (onMoved)
// rather than guessing. The pickers start on the episode the notes are already
// on, and Move stays disabled until the target differs. Seasons come from
// /api/board, fetched on open, so a season added since the page loaded is
// offered too.
export function MoveNotesDialog({ seasonId, episode, count, onMoved, onCancel }) {
    const dialogRef = useRef(null);
    const [seasons, setSeasons] = useState(null);
    const [target, setTarget] = useState({ seasonId, episode });
    const [error, setError] = useState(null);
    const { busy, run, canCancel } = useSubmitGuard();

    useEffect(() => {
        dialogRef.current?.showModal();
        api('/api/board')
            .then((board) => setSeasons(board.seasons))
            .catch((err) => setError(err.message));
    }, []);

    // Escape fires `cancel` before the dialog closes itself; the dialog's
    // lifetime belongs to the parent's state, so it is refused here and handed
    // to onCancel — which is also refused while a move is in flight.
    const dismiss = (e) => {
        e?.preventDefault();
        if (canCancel()) onCancel();
    };
    // A browser may close the dialog without a cancelable `cancel` — Chrome
    // does on a second Escape with no user activation in between — which would
    // leave it closed while the parent still has it mounted, and the Move
    // comments button, already `moving`, could not reopen it. Mirror that close
    // into the parent's state, or reopen it while a move is in flight.
    const closed = () => {
        if (canCancel()) onCancel();
        else dialogRef.current?.showModal();
    };
    // A backdrop click is one that both starts and ends on the dialog itself: a
    // drag from inside the form released over the backdrop also targets the
    // dialog, as the nearest common ancestor, and must not dismiss.
    const pressedRef = useRef(null);

    const pick = (change) => setTarget((cur) => moveTarget(seasons, { ...cur, ...change }));
    const unchanged = target.seasonId === seasonId && target.episode === episode;
    const targetSeason = seasons?.find((s) => s.id === target.seasonId);
    const note =
        `Moves the ${count} ${count === 1 ? 'note' : 'notes'} you wrote on Episode ${episode}, ` +
        "keeping their times. Everyone else's stay put.";

    const submit = (e) => {
        e.preventDefault();
        if (unchanged) return;
        run('move', async () => {
            setError(null);
            try {
                await api(`/api/seasons/${seasonId}/episodes/${episode}/posts/move`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to_season_id: target.seasonId,
                        to_episode: target.episode,
                    }),
                });
                await onMoved();
            } catch (err) {
                setError(err.message);
            }
        });
    };

    return html`
        <dialog
            ref=${dialogRef}
            class="move-dialog"
            aria-labelledby="move-dialog-title"
            onCancel=${dismiss}
            onClose=${closed}
            onPointerDown=${(e) => (pressedRef.current = e.target)}
            onClick=${(e) =>
                e.target === dialogRef.current && pressedRef.current === e.target && dismiss()}
        >
            <form class="season-form" onSubmit=${submit}>
                <h3 class="move-dialog-title" id="move-dialog-title">Move comments</h3>
                <p class="move-dialog-note">${note}</p>
                ${
                    seasons
                        ? html`
                              <label class="season-form-field grow">
                                  <span class="season-form-label">Season</span>
                                  <select
                                      class="season-form-input"
                                      value=${target.seasonId}
                                      onChange=${(e) => pick({ seasonId: Number(e.target.value) })}
                                  >
                                      ${seasons.map(
                                          (s) =>
                                              html`<option key=${s.id} value=${s.id}>
                                                  ${s.id}${s.subtitle ? `: ${s.subtitle}` : ''}
                                              </option>`,
                                      )}
                                  </select>
                              </label>
                              <label class="season-form-field">
                                  <span class="season-form-label">Episode</span>
                                  <select
                                      class="season-form-input"
                                      value=${target.episode}
                                      onChange=${(e) => pick({ episode: Number(e.target.value) })}
                                  >
                                      ${episodeNumbers(targetSeason?.episode_count).map(
                                          (n) => html`<option key=${n} value=${n}>${n}</option>`,
                                      )}
                                  </select>
                              </label>
                          `
                        : !error && html`<div class="loading">Loading…</div>`
                }
                <div class="season-form-actions">
                    <button
                        type="button"
                        class="timer-btn subtle"
                        disabled=${busy}
                        onClick=${() => dismiss()}
                    >
                        Cancel
                    </button>
                    <button
                        class="post-submit"
                        type="submit"
                        aria-busy=${busy}
                        disabled=${busy || !seasons || unchanged}
                    >
                        ${busy ? html`<span class="spinner" aria-hidden="true"></span>Moving…` : 'Move'}
                    </button>
                </div>
                ${error && html`<div class="season-form-error" role="alert">${error}</div>`}
            </form>
        </dialog>
    `;
}
