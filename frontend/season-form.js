import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import htm from 'htm';
import { MAX_EPISODE_COUNT, MAX_SUBTITLE_LENGTH } from '../shared/seasons.js';

const html = htm.bind(h);

// The one form behind both "Add Season N" on the board and the season page's
// edit. `onSubmit` receives `{ subtitle, episode_count }` and either resolves
// (the caller closes the form) or throws, in which case the message is shown
// here, inline, rather than as the page banner — the form is where the fix gets
// typed, and it stays open with what was entered.
export function SeasonForm({ label, initial, submitLabel, busyLabel, onSubmit, onCancel }) {
    const [subtitle, setSubtitle] = useState(initial?.subtitle ?? '');
    const [count, setCount] = useState(String(initial?.episode_count ?? ''));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // A ref rather than `busy` alone, which is stale inside the closure a fast
    // second Enter would run.
    const busyRef = useRef(false);
    const firstRef = useRef(null);

    useEffect(() => firstRef.current?.focus(), []);

    const submit = async (e) => {
        e.preventDefault();
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        try {
            await onSubmit({ subtitle: subtitle.trim(), episode_count: Number(count) });
        } catch (err) {
            setError(err.message);
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    // Cancel is refused mid-save for the same reason EditForm refuses it: the
    // request is already gone, and a late success would apply what the user
    // believes they discarded.
    const cancel = () => {
        if (!busyRef.current) onCancel();
    };

    return html`
        <form
            class="season-form"
            aria-label=${label}
            onSubmit=${submit}
            onKeyDown=${(e) => e.key === 'Escape' && cancel()}
        >
            <label class="season-form-field">
                <span class="season-form-label">Episodes</span>
                <input
                    ref=${firstRef}
                    class="season-form-input count"
                    type="number"
                    inputmode="numeric"
                    min="1"
                    max=${MAX_EPISODE_COUNT}
                    step="1"
                    required
                    value=${count}
                    onInput=${(e) => setCount(e.target.value)}
                />
            </label>
            <label class="season-form-field grow">
                <span class="season-form-label">Subtitle (optional)</span>
                <input
                    class="season-form-input"
                    type="text"
                    maxlength=${MAX_SUBTITLE_LENGTH}
                    value=${subtitle}
                    onInput=${(e) => setSubtitle(e.target.value)}
                />
            </label>
            <div class="season-form-actions">
                <button type="button" class="timer-btn subtle" onClick=${cancel}>Cancel</button>
                <button class="post-submit" type="submit" aria-busy=${busy} disabled=${busy}>
                    ${
                        busy
                            ? html`<span class="spinner" aria-hidden="true"></span>${busyLabel}`
                            : submitLabel
                    }
                </button>
            </div>
            ${error && html`<div class="season-form-error" role="alert">${error}</div>`}
        </form>
    `;
}
