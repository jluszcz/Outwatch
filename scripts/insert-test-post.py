#!/usr/bin/env python3
"""Insert a fake discussion post into the local D1 database, for manually
exercising the discussion UI (long notes, old/future timestamps, different
authors) without going through the app.

Only ever opens the local miniflare SQLite file under
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/ — no network calls, no
wrangler CLI — so it cannot reach production.

Usage:
    scripts/insert-test-post.py
    scripts/insert-test-post.py --author Bob --season 5 --episode 3 --length 60
    scripts/insert-test-post.py --time 5 --unit hours
    scripts/insert-test-post.py --time 2 --unit days --future
"""

import argparse
import random
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
D1_GLOB = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite"

LOREM_WORDS = (
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod "
    "tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam "
    "quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo "
    "consequat duis aute irure in reprehenderit voluptate velit esse cillum "
    "eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident "
    "sunt culpa qui officia deserunt mollit anim id est laborum"
).split()

UNIT_CHOICES = ("seconds", "minutes", "hours", "days")


def has_survivor(path):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return conn.execute("SELECT 1 FROM shows WHERE name = 'Survivor'").fetchone() is not None
    except sqlite3.OperationalError:
        return False
    finally:
        conn.close()


def find_db_path():
    # metadata.sqlite is miniflare's own bookkeeping, not the D1 database
    # contents, which live in a file named after a hash of the database id.
    # Only TV Talk's schema has a Survivor show; a leftover local copy of the
    # old outwatch database does not, and is skipped rather than ambiguous.
    matches = [
        p for p in REPO_ROOT.glob(D1_GLOB) if p.name != "metadata.sqlite" and has_survivor(p)
    ]
    if not matches:
        sys.exit(
            "No local D1 database with a Survivor show found under .wrangler/state/. "
            "Run `npx wrangler d1 migrations apply tvtalk --local` first."
        )
    return pick_db(matches)


def created_at(path):
    # Birth time where the platform records one (macOS). Not mtime: opening a
    # WAL database, even to read it, can checkpoint and bump that, so the stale
    # file would look fresh the moment anyone inspected it. The ctime fallback
    # (Linux) is no better — it moves whenever mtime does — so off macOS the
    # choice is a best guess and --db is the reliable override.
    st = path.stat()
    return getattr(st, "st_birthtime", st.st_ctime)


def pick_db(matches):
    # The file is named after an id workerd derives from the database id, and
    # that derivation is internal to it: a wrangler/miniflare upgrade can change
    # it, and wrangler then starts a fresh file beside the old one, which is
    # never touched again. So with several to choose from, the newest-created
    # is the one `wrangler dev` reads. Said out loud, since it is a guess.
    if len(matches) == 1:
        return matches[0]
    newest = max(matches, key=created_at)
    stale = "\n".join(f"  {m}" for m in matches if m != newest)
    print(
        f"Found {len(matches)} local D1 databases; using the newest:\n  {newest}\n"
        f"Older ones are likely left over from a wrangler upgrade and safe to delete "
        f"(or pass --db to choose):\n{stale}",
        file=sys.stderr,
    )
    return newest


def build_author_pool(conn):
    users = conn.execute("SELECT id, name FROM users").fetchall()
    emails_by_user = {}
    for user_id, email, name in conn.execute("SELECT user_id, email, name FROM user_emails"):
        emails_by_user.setdefault(user_id, []).append((email, name))

    pool = []
    for user_id, column_name in users:
        emails = emails_by_user.get(user_id, [])
        individuals = [(email, name) for email, name in emails if name is not None]
        if individuals:
            for email, name in individuals:
                pool.append({"display_name": name, "email": email, "user_id": user_id})
        elif emails:
            email = emails[0][0]
            pool.append({"display_name": column_name, "email": email, "user_id": user_id})
    return pool


def resolve_author(pool, requested_name):
    if requested_name is None:
        return random.choice(pool)
    for author in pool:
        if author["display_name"].lower() == requested_name.lower():
            return author
    available = ", ".join(sorted(a["display_name"] for a in pool))
    sys.exit(f'No roster author named "{requested_name}". Available: {available}')


def validate_season(conn, season_number):
    row = conn.execute(
        "SELECT id, episode_count FROM seasons WHERE number = ? "
        "AND show_id = (SELECT id FROM shows WHERE name = 'Survivor')",
        (season_number,),
    ).fetchone()
    if row is None:
        sys.exit(f"No Survivor season {season_number} in the local database.")
    return row


def generate_lorem(length):
    words = random.choices(LOREM_WORDS, k=length)
    words[0] = words[0].capitalize()
    return " ".join(words) + "."


def compute_created_at(time, unit, future):
    delta = timedelta(**{unit: time})
    now = datetime.now(timezone.utc)
    when = now + delta if future else now - delta
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--author", help="Roster name (e.g. Alice, Bob). Default: random.")
    parser.add_argument("--season", type=int, default=1, help="Survivor season number. Default: 1.")
    parser.add_argument("--episode", type=int, default=1, help="Episode number. Default: 1.")
    parser.add_argument("--length", type=int, default=20, help="Post length in words. Default: 20.")
    parser.add_argument("--time", type=int, default=0, help="Relative time magnitude. Default: 0 (now).")
    parser.add_argument("--unit", choices=UNIT_CHOICES, default="minutes", help="Unit for --time. Default: minutes.")
    parser.add_argument("--future", action="store_true", help="Shift into the future instead of the past.")
    parser.add_argument("--db", type=Path, help="Local D1 SQLite file to write to. Default: found under .wrangler/state/.")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.length < 1:
        sys.exit("--length must be at least 1.")
    if args.time < 0:
        sys.exit("--time must not be negative; use --future to shift forward instead.")
    if args.episode < 1:
        sys.exit("--episode must be at least 1.")

    if args.db and not args.db.is_file():
        # sqlite3.connect would create an empty database at a mistyped path.
        sys.exit(f"--db: no such file: {args.db}")
    db_path = args.db or find_db_path()
    conn = sqlite3.connect(db_path)
    try:
        pool = build_author_pool(conn)
        if not pool:
            sys.exit("No roster found in the local database. Apply roster.sql first.")
        author = resolve_author(pool, args.author)

        season_row_id, episode_count = validate_season(conn, args.season)
        if args.episode > episode_count:
            print(
                f"Warning: episode {args.episode} exceeds season {args.season}'s "
                f"episode_count ({episode_count}); inserting anyway.",
                file=sys.stderr,
            )

        body = generate_lorem(args.length)
        created_at = compute_created_at(args.time, args.unit, args.future)

        cursor = conn.execute(
            """
            INSERT INTO posts
                (season_id, episode, user_id, body, created_at, offset_secs, author_email, reply_to_post_id, edited_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL)
            """,
            (season_row_id, args.episode, author["user_id"], body, created_at, author["email"]),
        )
        conn.commit()

        preview = body if len(body) <= 60 else body[:57] + "..."
        print(
            f"Inserted post {cursor.lastrowid}: {author['display_name']} on season "
            f"{args.season} episode {args.episode} at {created_at}\n  {preview}"
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
