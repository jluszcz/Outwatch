import { useState, useEffect, useCallback, useRef } from 'preact/hooks';

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
//
// Two mechanisms, both carried over from the board:
//   - Generations: only the newest fetch may apply its response. Focus and
//     visibilitychange often both fire, and a mutation starting mid-flight
//     invalidates whatever a fetch was already carrying.
//   - Deferral: a refresh asked for while a mutation is in flight is queued
//     rather than started, because its response could come from a read taken
//     before the mutation commits. The last mutation to settle runs it.
//
// `fetcher` returns the data; `apply` writes it to state. refresh() resolves
// true when the response was applied and false when it was stale or deferred.
export function useRefreshGuard(fetcher, apply) {
    const generation = useRef(0);
    const fetchesInFlight = useRef(0);
    const mutationsInFlight = useRef(0);
    const queued = useRef(false);

    const refresh = useCallback(async () => {
        if (mutationsInFlight.current > 0) {
            queued.current = true;
            return false;
        }
        const mine = ++generation.current;
        fetchesInFlight.current++;
        try {
            const data = await fetcher();
            if (mine !== generation.current) return false;
            apply(data);
            return true;
        } finally {
            fetchesInFlight.current--;
        }
    }, [fetcher, apply]);

    const beginMutation = useCallback(() => {
        mutationsInFlight.current++;
        // A fetch already in flight may have read pre-mutation state: discard
        // its response and queue a refetch so the other-user changes it was
        // carrying still arrive.
        if (fetchesInFlight.current > 0) {
            generation.current++;
            queued.current = true;
        }
    }, []);

    const endMutation = useCallback(() => {
        if (--mutationsInFlight.current === 0 && queued.current) {
            queued.current = false;
            // Best-effort: the mutation's own error banner already reflects
            // reality, and the next focus refresh retries.
            refresh().catch(() => {});
        }
    }, [refresh]);

    return { refresh, beginMutation, endMutation };
}

// The app has exactly one route beyond the board, so a hash and a listener beat
// a router library. A hash also means Back returns to the board, a reload keeps
// your place, and a season is a link you can paste into chat.
export function useHashRoute() {
    const read = () => {
        const match = /^#\/season\/(\d+)$/.exec(window.location.hash);
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
