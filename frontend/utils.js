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

// A watch-timer correction as a signed m:ss — "+0:45", "−1:15", "±0:00". Unlike
// formatOffset this must show its sign and must not clamp: a backward
// correction is the common one (you started the timer before the recap), and
// hiding its sign would make the control unreadable. Uses U+2212 so it matches
// the −15s / −1m buttons beside it rather than sitting next to them as a
// hyphen.
export function formatAdjust(secs) {
    const total = Math.abs(Math.round(secs));
    const sign = secs === 0 ? '±' : secs < 0 ? '−' : '+';
    return `${sign}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// A nudge tap's next total: `delta` added to `current`, held inside ±max.
// Pulled out of WatchTimer so the arithmetic — including the "already at the
// limit" case, where the result equals `current` and the caller should treat
// the tap as a no-op — has a test that doesn't need a DOM. `max` is passed in
// rather than imported, so this file (otherwise dependency-free) doesn't need
// to reach into shared/session.js for one constant.
export function clampAdjust(current, delta, max) {
    return Math.max(-max, Math.min(max, current + delta));
}

// What a nudge's local total should settle on once its request comes back —
// or whether it should change at all. `isCurrent` is false when a newer nudge
// has been sent since this one, mirroring the generation counter
// refresh-guard.js uses to keep an out-of-order fetch response from
// overwriting a newer one: two overlapping requests can resolve in either
// order, and an older response — success or failure — settling after a newer
// one already has must not speak for it. Returns undefined in that case, for
// the caller to treat as "leave pendingAdjust alone" rather than a value to
// apply. Otherwise: the value optimistically applied if the server accepted
// it, or the last value known to actually be stored there if it didn't —
// a failed PUT leaves the server's adjust_secs (and so the component's own
// adjustSecs prop) unchanged, so nothing else notices the rejection and
// reverts the optimistic update on its own; this is the decision that does.
export function settledAdjust(isCurrent, ok, next, fallback) {
    if (!isCurrent) return undefined;
    return ok ? next : fallback;
}

// A placement's sort key: tail notes last, then watch offset, then wall-clock
// time, then post id. Compared lexicographically, this is the ordering the
// timeline has always used, with the id appended — which is what makes the
// reply clamp below land a reply *after* its parent rather than before, since
// a parent's id is always smaller than its reply's.
function sortKey(entry) {
    // Tail entries carry a null offset and are ordered among themselves by
    // wall-clock time, so they must compare equal on this component.
    return [entry.tail ? 1 : 0, entry.tail ? 0 : entry.offset, entry.created, entry.post.id];
}

function compareKeys(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

// Places every note on one timeline so a conversation written days apart reads
// in episode order. Returns { post, offset, inferred, tail, created, clamped } —
// `created` is the parsed created_at used as the sort key (and tiebreaker
// within a tail), returned alongside the rest so callers don't have to
// re-parse it; `clamped` is true only when the reply rule below actually moved
// that entry. Does not mutate the input.
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
            return {
                post,
                offset: post.offset_secs,
                inferred: false,
                tail: false,
                created,
                clamped: false,
            };
        }
        if (timedAuthors.has(post.user_id)) {
            return { post, offset: null, inferred: false, tail: true, created, clamped: false };
        }
        const offset = Math.round((created - zeroByAuthor.get(post.user_id)) / 1000);
        return { post, offset, inferred: true, tail: false, created, clamped: false };
    });

    // A reply must never render above the note it answers. It is placed by its
    // own watch offset like any other note — replies are not threaded — but two
    // people whose timers disagree can stamp a reply earlier than its parent,
    // and a note whose author's session went stale lands in the tail while a
    // reply to it does not. Both put the quote block above the note it quotes.
    //
    // The fix is to clamp a reply's sort key to its parent's already-clamped
    // key, keeping its own id in the last slot so it sorts after its parent —
    // only after is guaranteed, not immediately after: an unrelated entry that
    // shares the parent's (tail, offset, created) triple and whose id falls
    // between the two would sort in between them. Resolved by memoized
    // recursion so a chain of replies settles in one pass.
    const byId = new Map(placed.map((entry) => [entry.post.id, entry]));
    const keys = new Map();
    const resolving = new Set();

    const clampedKey = (entry) => {
        const id = entry.post.id;
        const cached = keys.get(id);
        if (cached) return cached;

        let key = sortKey(entry);
        // A cycle cannot be written — a parent has to exist before it can be
        // replied to, so ids strictly increase down a chain — but the guard
        // keeps a corrupt response from recursing forever.
        if (!resolving.has(id)) {
            resolving.add(id);
            // reply_to, not reply_to_post_id: the server serializes the parent
            // as an object, and its locked form carries an id whose post is
            // deliberately absent from this list — a miss here is the correct
            // outcome, since an unrendered parent has no order to violate.
            const parent = entry.post.reply_to && byId.get(entry.post.reply_to.id);
            if (parent) {
                const parentKey = clampedKey(parent);
                if (compareKeys(key, parentKey) < 0) {
                    key = [parentKey[0], parentKey[1], parentKey[2], id];
                    entry.clamped = true;
                }
            }
            resolving.delete(id);
        }

        keys.set(id, key);
        return key;
    };

    // Resolved up front rather than inside the comparator, so `clamped` is
    // settled on every entry before anything reads it.
    for (const entry of placed) clampedKey(entry);

    return placed.sort((a, b) => compareKeys(keys.get(a.post.id), keys.get(b.post.id)));
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

// Whether a failed post leaves behind a reply chip that can never succeed.
//
// A reply's parent id is frozen when the chip is raised, while the parent's
// visibility is recomputed on every read — so a note deleted while the reply was
// being written answers 404, and keeps answering it. The chip survives a failed
// submit (the text has to), which means every later attempt to send that note
// fails identically, with nothing on screen tying the refusal to the quote
// sitting above the box. Dropping the chip turns a dead compose box back into a
// working one and keeps what was typed; the note goes out as an ordinary note.
//
// Keyed on the chip being present rather than on the message, because the post
// route also answers 404 for a season or episode that does not exist — which
// cannot happen from a rendered board, and would cost only the quote if it did.
export function replyTargetGone(replyToId, err) {
    return replyToId != null && err?.status === 404;
}

// How long ago something happened, at the precision the feed actually claims.
//
// The five-minute floor is what keeps the panel from being wrong in its most
// visible case: a note that landed while you were reading the board reads
// "just now" instead of ticking through "1 minute ago". It also means the
// minutes tier never renders below five, so "1 minute ago" is unreachable and
// the singular only exists at the hours and days tiers.
//
// `nowMs` is the server's clock (GET /api/feed echoes one), not Date.now(), so
// a device with a wrong clock cannot age everything by a day. The clamp at zero
// covers the remaining skew in the other direction — a stamp from the near
// future reads "just now" rather than "in 3 hours".
export function relativeTime(iso, nowMs) {
    const secs = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
    if (secs <= 300) return 'just now';

    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins} minutes ago`;

    const hours = Math.floor(secs / 3600);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

    const days = Math.floor(secs / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

// One feed event as a sentence. Deliberately carries no note count — "Alice
// commented on Season 45 Episode 3" already implies one or more, and two notes
// and five notes both mean the same thing to whoever is reading it. The season
// subtitle is left out too: seasonLabel's full form is wider than the panel.
export function feedLine(event) {
    return `${event.author_name} commented on Season ${event.season_id} Episode ${event.episode}`;
}

// The app's whole routing table. Extracted from useHashRoute so the regex is
// testable on its own — the same split refresh-guard.js and submit-guard.js
// draw between a rule and the wiring around it.
//
// Both numbers carry the [1-9]\d* guard: no leading zeros and no bare 0. A "0"
// would otherwise match, mount the season view, and surface the API's raw
// "season_id must be a positive integer" instead of falling back to the board.
// An unparseable hash is the board, never a partial route.
export function parseHashRoute(hash) {
    const match = /^#\/season\/([1-9]\d*)(?:\/episode\/([1-9]\d*))?$/.exec(hash);
    if (!match) return { seasonId: null, episode: null };
    return { seasonId: Number(match[1]), episode: match[2] ? Number(match[2]) : null };
}

// Whether SeasonView's arrival jump should fire on this render: the rule behind
// the effect that scrolls the episode a feed line named into view. Extracted
// for the same reason parseHashRoute is — every condition below is a bug that
// happened, and none of them are testable inside the effect.
//
// `ready` is "the discussion has rendered its cards", not "the response
// arrived": `data` and `loading` settle in two separate renders (the fetch
// applies the data, its `finally` clears the flag), and SeasonView returns
// "Loading…" for the first of them, so a jump keyed on the response alone
// measures a document with no episode cards in it at all — and, since the deps
// it watches have both stopped changing, nothing runs it again once they mount.
//
// `openEpisode` must have caught up with `routeEpisode` for the same class of
// reason one render later: the effect that expands the board and this one run
// in the same commit, so on the commit that a new route arrives on, the DOM
// still has the *previous* episode expanded and this one collapsed.
// scrollIntoView measures a pixel target once, and the collapse that follows
// slides the destination out from under it.
//
// `scrolled` is the last route episode actually jumped to, so a refetch — focus,
// or a mutation's own refresh — cannot scroll the page out from under someone
// reading elsewhere, and neither can collapsing and reopening the board by hand.
export function shouldScrollToEpisode({ routeEpisode, openEpisode, ready, scrolled }) {
    if (routeEpisode == null || !ready) return false;
    if (openEpisode !== routeEpisode) return false;
    return scrolled !== routeEpisode;
}

// The episode header's summary of who is skipping and why. Collapses to one
// reason when everyone skipping agrees — the usual case, since a recap is a
// recap for everybody — and falls back to a reason per name when they don't. A
// single rule that always printed the reason per name would be correct but
// repetitive in the case that actually happens; a single rule that only ever
// collapsed would be wrong in the case that occasionally does.
//
// "You" leads, and the rest keep the roster order the server sent, so the line
// reads the same way on everyone's screen apart from which name is theirs.
// Returns '' rather than null so the caller can test it as a string.
export function skipLabel(statuses, meId) {
    const skips = (statuses ?? []).filter((s) => s.status === 'skipping');
    if (skips.length === 0) return '';

    const ordered = [
        ...skips.filter((s) => s.user_id === meId),
        ...skips.filter((s) => s.user_id !== meId),
    ];
    const nameOf = (s) => (s.user_id === meId ? 'You' : s.name);

    const reasons = new Set(ordered.map((s) => s.reason));
    if (reasons.size === 1) {
        return `Skipped ${ordered[0].reason}: ${ordered.map(nameOf).join(', ')}`;
    }
    return `Skipped: ${ordered.map((s) => `${nameOf(s)} (${s.reason})`).join(', ')}`;
}
