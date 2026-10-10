-- Optional local dev seed: sample "watched" state so the board isn't empty.
-- Apply with:
--   npx wrangler d1 execute tvtalk --local --file=seed.sql
--
-- Survivor's seasons live in TV Talk's migration 0003 and the roster (users +
-- emails) lives in roster.sql, so both are already present before this runs —
-- do not duplicate them here. Apply roster.sql first so these user ids exist.
-- Seasons are matched by number, since watched rows key on TV Talk's surrogate
-- seasons.id. Do NOT run this against production; it inserts fake watched rows.

-- Season 1 fully watched (grays out, sinks to the bottom); a couple of partials.
INSERT OR IGNORE INTO watched (user_id, season_id, created_at)
SELECT v.column1, seasons.id, v.column3
FROM (VALUES
    ('user-1', 1,  '2026-01-01T00:00:00Z'),
    ('user-2', 1,  '2026-01-01T00:00:00Z'),
    ('user-3', 1,  '2026-01-01T00:00:00Z'),
    ('user-1', 20, '2026-01-02T00:00:00Z'),
    ('user-2', 20, '2026-01-02T00:00:00Z'),
    ('user-1', 40, '2026-01-03T00:00:00Z')
) AS v
JOIN seasons ON seasons.number = v.column2
            AND seasons.show_id = (SELECT id FROM shows WHERE name = 'Survivor');
