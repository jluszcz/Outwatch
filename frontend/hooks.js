import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { createRefreshGuard } from './refresh-guard.js';
import { createSubmitGuard } from './submit-guard.js';
import { parseHashRoute } from './utils.js';

// The theme in effect before anything has been rendered: a manual choice if one
// was stored, otherwise whatever the OS asks for. Shared by useTheme's initial
// state and useIsDark's, so the two cannot drift.
function preferredTheme() {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
    const [theme, setTheme] = useState(preferredTheme);

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

// Whether the dark theme is in effect, for the one thing CSS cannot express:
// swapping an icon's outline path for its filled one. Everything else themes
// through light-dark() tokens, which resolve from color-scheme without anyone
// having to know which theme won.
//
// Reads the same data-theme attribute useTheme writes rather than the media
// query directly, so the manual toggle counts and the OS preference is only
// consulted for the first paint, before useTheme's effect has written anything.
// A MutationObserver rather than a shared context: the attribute is already the
// app-wide source of truth, and this avoids threading a provider through App →
// SeasonView → EpisodeBoard → PostList → Post just to reach the menu.
export function useIsDark() {
    const [dark, setDark] = useState(
        () => (document.documentElement.dataset.theme || preferredTheme()) === 'dark',
    );

    useEffect(() => {
        const root = document.documentElement;
        const observer = new MutationObserver(() => setDark(root.dataset.theme === 'dark'));
        observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
        // useTheme's effect may have written the attribute between this
        // component's render and this effect, so re-read rather than trusting
        // the initial state to still be right.
        setDark(root.dataset.theme === 'dark');
        return () => observer.disconnect();
    }, []);

    return dark;
}

// Guards a shared-resource refetch against races with optimistic mutations.
// The rules live in `createRefreshGuard` (refresh-guard.js), which is where they
// are tested; this hook is the wiring that gives them a fetcher and somewhere to
// put the data.
//
// `fetcher` returns the data; `apply` writes it to state. refresh() resolves
// true when the response was applied and false when it was stale or deferred.
export function useRefreshGuard(fetcher, apply) {
    // One guard per mounted component, created on first render and kept for the
    // component's life — its counters are the state being guarded.
    const guardRef = useRef(null);
    if (guardRef.current === null) guardRef.current = createRefreshGuard();
    const guard = guardRef.current;

    const refresh = useCallback(async () => {
        const token = guard.startFetch();
        if (token === null) return false;
        try {
            const data = await fetcher();
            if (!guard.isCurrent(token)) return false;
            apply(data);
            return true;
        } finally {
            guard.endFetch();
        }
    }, [guard, fetcher, apply]);

    const beginMutation = useCallback(() => guard.beginMutation(), [guard]);

    const endMutation = useCallback(() => {
        // Best-effort: the mutation's own error banner already reflects
        // reality, and the next focus refresh retries.
        if (guard.endMutation()) refresh().catch(() => {});
    }, [guard, refresh]);

    return { refresh, beginMutation, endMutation };
}

// Wiring around createSubmitGuard: one guard per mounted form, kept for the
// form's life. `busy` is component state purely so the button can render a
// spinner — the guard, not the state, decides whether a submit or a cancel is
// allowed, so the rules stay in one testable place.
export function useSubmitGuard() {
    const guardRef = useRef(null);
    if (guardRef.current === null) guardRef.current = createSubmitGuard();
    const guard = guardRef.current;
    const [busy, setBusy] = useState(false);

    // Resolves whatever `action` resolves, or false when the guard refused —
    // callers distinguish "posted" from "not posted" on that.
    const run = useCallback(
        async (text, action) => {
            if (!guard.canSubmit(text) || !guard.begin()) return false;
            setBusy(true);
            try {
                return await action(text.trim());
            } finally {
                guard.end();
                setBusy(false);
            }
        },
        [guard],
    );

    const canCancel = useCallback(() => guard.canCancel(), [guard]);

    return { busy, run, canCancel };
}

// The app has exactly one route beyond the board, so a hash and a listener beat
// a router library. A hash also means Back returns to the board, a reload keeps
// your place, and a season is a link you can paste into chat.
export function useHashRoute() {
    const [route, setRoute] = useState(() => parseHashRoute(window.location.hash));

    useEffect(() => {
        const handler = () =>
            setRoute((current) => {
                const next = parseHashRoute(window.location.hash);
                // Returning the same object lets Preact bail out. Without this
                // every hashchange — including one that lands on the hash we
                // are already on — would be a new object and a re-render.
                return next.seasonId === current.seasonId && next.episode === current.episode
                    ? current
                    : next;
            });
        window.addEventListener('hashchange', handler);
        return () => window.removeEventListener('hashchange', handler);
    }, []);

    return route;
}

// Refetch when the tab regains focus, so changes other people made while this
// tab was in the background show up without a reload.
export function useRefreshOnFocus(refresh, onError) {
    useEffect(() => {
        const handler = () => {
            if (document.visibilityState !== 'visible') return;
            refresh().then(
                // A discarded stale response says nothing about server health —
                // only clear the banner when the data actually applied.
                (applied) => applied && onError(null),
                (err) => onError(err.message),
            );
        };
        document.addEventListener('visibilitychange', handler);
        window.addEventListener('focus', handler);
        return () => {
            document.removeEventListener('visibilitychange', handler);
            window.removeEventListener('focus', handler);
        };
    }, [refresh, onError]);
}
