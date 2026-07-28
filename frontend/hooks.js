import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { createRefreshGuard } from './refresh-guard.js';

export function useTheme() {
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

// A textarea does not size itself to its content, so the height is driven from
// scrollHeight. Resetting to 'auto' first is what lets the box shrink again
// after a delete — scrollHeight never reports less than the height already set.
//
// The same text rewraps onto a different number of lines when the box gets
// narrower or wider, so the height is recomputed on a rotation or a window
// resize too, not only when the text changes. The box's width is a function of
// the viewport alone, so the window event is enough and a ResizeObserver (which
// would also have to avoid re-firing on the height changes made here) buys
// nothing.
export function useAutoSize(ref, value) {
    const fit = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        const style = getComputedStyle(el);
        // scrollHeight leaves out the border, which box-sizing: border-box
        // counts inside the height, so skipping this clips the last line.
        const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        el.style.height = `${el.scrollHeight + border}px`;
    }, [ref]);

    useEffect(fit, [value, fit]);

    useEffect(() => {
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
    }, [fit]);
}

// The app has exactly one route beyond the board, so a hash and a listener beat
// a router library. A hash also means Back returns to the board, a reload keeps
// your place, and a season is a link you can paste into chat.
export function useHashRoute() {
    const read = () => {
        // No leading zero and no bare "0" — season ids are positive integers, and
        // "0" would otherwise match, mount SeasonView, and surface the API's raw
        // "season_id must be a positive integer" error instead of falling back
        // to the board.
        const match = /^#\/season\/([1-9]\d*)$/.exec(window.location.hash);
        return match ? Number(match[1]) : null;
    };
    const [seasonId, setSeasonId] = useState(read);

    useEffect(() => {
        const handler = () => setSeasonId(read());
        window.addEventListener('hashchange', handler);
        return () => window.removeEventListener('hashchange', handler);
    }, []);

    return seasonId;
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
