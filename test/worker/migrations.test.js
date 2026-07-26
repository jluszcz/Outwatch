import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

// The 50 episode counts in migration 0005 are transcribed by hand from Wikipedia
// and are the likeliest place in this feature for a quiet error. A dropped row
// leaves a 0; a slipped digit leaves a 130. Both are caught here.
describe('seeded episode counts', () => {
    it('gives all 50 seasons a plausible episode count', async () => {
        const { results } = await env.DB.prepare(
            'SELECT id, episode_count FROM seasons ORDER BY id ASC',
        ).all();
        expect(results).toHaveLength(50);
        for (const season of results) {
            expect(season.episode_count).toBeGreaterThanOrEqual(12);
            expect(season.episode_count).toBeLessThanOrEqual(17);
        }
    });

    it('has the new discussion tables', async () => {
        const { results } = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        ).all();
        const names = results.map((r) => r.name);
        expect(names).toContain('posts');
        expect(names).toContain('reveals');
        expect(names).toContain('watch_sessions');
    });
});
