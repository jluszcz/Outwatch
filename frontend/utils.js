// Display label for a season row: "Season 20: Heroes vs. Villains", or just
// "Season 41" when the season has no subtitle.
export function seasonLabel(season) {
    return season.subtitle ? `Season ${season.id}: ${season.subtitle}` : `Season ${season.id}`;
}

// The same label split for layouts that put the number and the subtitle on
// separate lines. `subtitle` is '' when the season has none, so callers can
// test it directly rather than checking the season object again.
export function seasonParts(season) {
    return { number: `Season ${season.id}`, subtitle: season.subtitle ?? '' };
}

// A column header collapsed to initials: "Bob & Carol" becomes "B & C". Only a
// shared column (two names joined by "&") is abbreviated, because that is
// exactly the case that wraps — the check columns size to their longest word,
// so a name with a space in it takes two or three lines at every phone width
// while a single name always takes one. Anything without an "&" is returned
// unchanged rather than reduced to initials, which would be unreadable for a
// one-person column with a two-word name.
// How many distinct author colours the stylesheet defines. The roster is a
// handful of people, so this only wraps in a case that should not happen.
const ACCENT_SLOTS = 5;

// Which accent a note's left stripe should use. 'mine' for the caller's own
// notes, which take the same blue their board column already uses; otherwise a
// 1-based slot from the author's position in the roster of individuals. The
// server assigns that position in an order that does not depend on the viewer,
// so a person keeps the same colour across reloads and across everyone's
// screens — only "yours" changes depending on who is looking. null when the
// server could not place the author, which leaves the note unstriped rather
// than inventing a colour for them.
export function authorAccent(post) {
    if (post.mine) return 'mine';
    if (post.author_index == null) return null;
    return (post.author_index % ACCENT_SLOTS) + 1;
}

export function abbreviateName(name) {
    const parts = name
        .split('&')
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length < 2) return name;
    // Array.from, not [0], so a name starting with an astral character (an
    // emoji, say) yields that whole character instead of half a surrogate pair.
    return parts.map((part) => Array.from(part)[0].toUpperCase()).join(' & ');
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

// watched_by with the user present (watched) or absent — never duplicated:
// overlapping optimistic updates and their reverts could otherwise append the
// same user twice and inflate seen counts. Does not mutate the input.
export function setWatched(watchedBy, userId, watched) {
    const without = watchedBy.filter((id) => id !== userId);
    return watched ? [...without, userId] : without;
}

// Whether checking a season would also clear it as your currently-watching
// season: true only when you're marking it watched and it's the one you're on.
// (You can't be mid-watch on a season you've just finished.)
export function clearsCurrentlyWatching(me, seasonId, checked) {
    return checked && me?.currently_watching_season_id === seasonId;
}

// The episode numbers of a season, 1..count.
export function episodeNumbers(count) {
    return Array.from({ length: count || 0 }, (_, i) => i + 1);
}

// A watch offset as "+5:00", or "+1:05:00" once it passes an hour. Minutes are
// padded only when there is an hour part, so short offsets stay easy to scan.
export function formatOffset(secs) {
    const total = Math.max(0, Math.round(secs));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    return `+${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

// The same offset in its largest whole unit — "45s", "4m", "5h" — for the post
// timeline, where the exact second is noise next to the note itself. Truncates
// rather than rounds, so a note stamped at 5:09:29 reads "5h" and never claims
// a boundary it has not reached. The live timer chip keeps formatOffset, which
// has to tick through every second.
export function formatOffsetShort(secs) {
    const total = Math.max(0, Math.floor(secs));
    if (total >= 3600) return `${Math.floor(total / 3600)}h`;
    if (total >= 60) return `${Math.floor(total / 60)}m`;
    return `${total}s`;
}

// Places every note on one timeline so a conversation written days apart reads
// in episode order. Returns { post, offset, inferred, tail, created } — `created`
// is the parsed created_at used as the sort key (and tiebreaker within a tail),
// returned alongside the rest so callers don't have to re-parse it. Does not
// mutate the input.
//
// An author who ran a timer has real offsets. An author who never did gets an
// inferred zero — their own earliest note on the episode — so their notes still
// interleave instead of piling up at one end. An author with both (their session
// went stale and they came back later) keeps the real offsets, and the strays
// drop to the tail: giving that note a computed "+51:10:00" would be a lie
// dressed as data.
export function orderPosts(posts) {
    const timedAuthors = new Set(posts.filter((p) => p.offset_secs != null).map((p) => p.user_id));

    const zeroByAuthor = new Map();
    for (const p of posts) {
        if (timedAuthors.has(p.user_id)) continue;
        const at = Date.parse(p.created_at);
        const zero = zeroByAuthor.get(p.user_id);
        if (zero === undefined || at < zero) zeroByAuthor.set(p.user_id, at);
    }

    const placed = posts.map((post) => {
        const created = Date.parse(post.created_at);
        if (post.offset_secs != null) {
            return { post, offset: post.offset_secs, inferred: false, tail: false, created };
        }
        if (timedAuthors.has(post.user_id)) {
            return { post, offset: null, inferred: false, tail: true, created };
        }
        const offset = Math.round((created - zeroByAuthor.get(post.user_id)) / 1000);
        return { post, offset, inferred: true, tail: false, created };
    });

    return placed.sort((a, b) => {
        if (a.tail !== b.tail) return a.tail ? 1 : -1;
        if (!a.tail && a.offset !== b.offset) return a.offset - b.offset;
        return a.created - b.created;
    });
}

// A note reduced to one line for the reply chip: newlines and runs of
// whitespace collapse to single spaces so a multi-line note cannot make the
// compose box grow, and anything past `max` is cut with an ellipsis.
export function quoteSnippet(body, max = 60) {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// What the compose box should hold once a post has succeeded. The box stays
// editable while the request is in flight (disabling a focused textarea blurs
// it, which tears down a phone keyboard mid-post), so by the time the server
// answers it may hold something the user typed on top of the note — clear it
// only when it still holds exactly what went out, and leave anything newer
// alone.
//
// `sent` is the raw contents of the box at submit time, deliberately not the
// trimmed body the API received. Comparing against the trimmed form silently
// failed for every note with surrounding whitespace — a trailing space is what
// a phone's predictive keyboard leaves after each accepted word — so the note
// posted and then sat in the box looking unposted.
export function bodyAfterPost(current, sent) {
    return current === sent ? '' : current;
}
