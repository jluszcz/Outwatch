// How far back the feed reaches. Everything past this is gone from the panel
// and from the unread count alike, so the count can never name something the
// list has no way to show.
export const FEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// How many groups the panel gets. The unread count is deliberately not capped
// to match — see GET /api/feed.
export const FEED_MAX_EVENTS = 10;

// What ends a group: six hours between one note and the next. Notes by the same
// author on the same episode otherwise join the same line however many there
// are, because the line carries no count and two notes and five notes both mean
// go read the episode.
//
// This replaced a calendar-day rule, which was wrong for the app's main case.
// posts.created_at is always UTC, so a "day" boundary falls at 8pm Eastern —
// inside the evening someone watches an episode — and a session running
// 7:30-8:30pm ET split into two lines with two timestamps. A gap has no
// timezone in it at all, so it is right wherever the viewer is, while still
// separating a note left weeks later from the sitting that produced the rest.
export const FEED_GROUP_GAP_MS = 6 * 60 * 60 * 1000;

// Collapse a season's worth of notes into one line per person per episode per
// sitting.
//
// `rows` must arrive ordered by (author_key, season_id, episode, created_at
// ASC) — the query does that ordering, and this walk assumes it: a group only
// ever extends the row before it, so an out-of-order feed would silently
// produce more groups than it should rather than fail. Group order follows
// input order; the caller sorts by `at`.
export function groupNotes(rows) {
    const groups = [];
    let current = null;

    for (const row of rows) {
        const continues =
            current !== null &&
            current.author_key === row.author_key &&
            current.season_id === row.season_id &&
            current.episode === row.episode &&
            Date.parse(row.created_at) - Date.parse(current.at) <= FEED_GROUP_GAP_MS;

        if (continues) {
            // The rows are ascending, so the latest one seen is the newest.
            current.at = row.created_at;
            continue;
        }

        // Only the fields a byline and a link are built from. A body is never
        // copied across, which is what makes "the feed carries no bodies" a
        // property of this function rather than a promise the route has to keep.
        current = {
            author_key: row.author_key,
            author_email: row.author_email,
            user_id: row.user_id,
            season_id: row.season_id,
            episode: row.episode,
            at: row.created_at,
        };
        groups.push(current);
    }

    return groups;
}
