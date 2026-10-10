import { env } from 'cloudflare:test';

// Children before parents: D1 enforces foreign keys, and every table here
// points at users, seasons, or posts. Shows are left alone. The Survivor row
// comes from TV Talk's migration 0003 and is what every route looks up.
export async function resetDatabase() {
    for (const table of [
        'reactions',
        'watch_sessions',
        'watch_offsets',
        'episode_statuses',
        'reveals',
        'posts',
        'watched',
        'currently_watching',
        'user_emails',
        'users',
        'seasons',
    ]) {
        await env.DB.exec(`DELETE FROM ${table}`);
    }
}

// Seeds Survivor seasons. `row_id` defaults to the season number, which keeps
// every fixture that writes season_id directly meaning the same season it
// always did. survivor-scope.test.js passes a different row_id on purpose, to
// pull the two apart.
export async function insertSurvivorSeasons(rows) {
    for (const {
        number,
        row_id = number,
        subtitle = '',
        url = `https://en.wikipedia.org/wiki/Survivor_${number}`,
        episode_count = 13,
    } of rows) {
        await env.DB.prepare(
            `INSERT INTO seasons (id, show_id, number, subtitle, url, episode_count, created_at)
             SELECT ?, id, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z' FROM shows WHERE name = 'Survivor'`,
        )
            .bind(row_id, number, subtitle, url, episode_count)
            .run();
    }
}

export async function survivorShowId() {
    const row = await env.DB.prepare("SELECT id FROM shows WHERE name = 'Survivor'").first();
    return row.id;
}
