// Display label for a season row: "Season 20: Heroes vs. Villains", or just
// "Season 41" when the season has no subtitle.
export function seasonLabel(season) {
    return season.subtitle ? `Season ${season.id}: ${season.subtitle}` : `Season ${season.id}`;
}

// A season is fully watched once every user has it checked. With no users, no
// season can be "fully watched" (avoids graying out the whole board).
export function isFullyWatched(season, userCount) {
    return userCount > 0 && season.watched_by.length >= userCount;
}

// Fully-watched seasons sink to the bottom; everything else keeps natural season
// order (by number). Stable within each group. Does not mutate the input.
export function sortSeasons(seasons, userCount) {
    return [...seasons].sort((a, b) => {
        const aw = isFullyWatched(a, userCount) ? 1 : 0;
        const bw = isFullyWatched(b, userCount) ? 1 : 0;
        if (aw !== bw) return aw - bw;
        return a.id - b.id;
    });
}

// Fully-watched seasons sink to the bottom (matching sortSeasons). Within each
// tier, sorts by watcher count ascending (fewest seen first), then by season
// number for stability. Does not mutate the input.
export function sortBySeenCount(seasons, userCount) {
    return [...seasons].sort((a, b) => {
        const aw = isFullyWatched(a, userCount) ? 1 : 0;
        const bw = isFullyWatched(b, userCount) ? 1 : 0;
        if (aw !== bw) return aw - bw;
        if (a.watched_by.length !== b.watched_by.length)
            return a.watched_by.length - b.watched_by.length;
        return a.id - b.id;
    });
}

// The seasons you can pick as "currently watching": the ones you haven't watched
// yet. This enforces the invariant that your currently-watching season is always
// one of your unwatched seasons. Does not mutate the input.
export function selectableSeasons(seasons, meId) {
    return seasons.filter((s) => !s.watched_by.includes(meId));
}

// Whether checking a season would also clear it as your currently-watching
// season: true only when you're marking it watched and it's the one you're on.
// (You can't be mid-watch on a season you've just finished.)
export function clearsCurrentlyWatching(me, seasonId, checked) {
    return checked && me?.currently_watching_season_id === seasonId;
}
