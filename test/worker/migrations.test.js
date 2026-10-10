import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

// The schema is TV Talk's (migrations/ is a copy of ../TvTalk/migrations), and
// TV Talk's own suite tests its history. What Outwatch depends on is that the
// copy carries the Survivor show it looks up by name, with the seeded seasons.
describe('Survivor in the shared schema', () => {
    it('has a Survivor show with seasons 1–51', async () => {
        const { results } = await env.DB.prepare(
            `SELECT seasons.number AS number, seasons.episode_count AS episode_count
             FROM seasons JOIN shows ON shows.id = seasons.show_id
             WHERE shows.name = 'Survivor' ORDER BY seasons.number ASC`,
        ).all();
        expect(results.map((r) => r.number)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
        for (const season of results) {
            expect(season.episode_count).toBeGreaterThanOrEqual(12);
            expect(season.episode_count).toBeLessThanOrEqual(17);
        }
    });

    it('has the tables the Worker reads', async () => {
        const { results } = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all();
        const names = results.map((r) => r.name);
        for (const table of [
            'shows',
            'seasons',
            'currently_watching',
            'posts',
            'reactions',
            'reveals',
            'watch_sessions',
            'watch_offsets',
            'episode_statuses',
        ]) {
            expect(names).toContain(table);
        }
    });
});
