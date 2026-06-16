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
