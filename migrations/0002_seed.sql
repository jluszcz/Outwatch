-- The shows the group started with. Everything after this is added from the
-- board. Episode counts from each season's Wikipedia episode table.
INSERT INTO shows (name, url, created_at) VALUES
    ('The Great British Bake Off', 'https://en.wikipedia.org/wiki/The_Great_British_Bake_Off', '2026-09-25T00:00:00.000Z'),
    ('Lanterns',                   'https://en.wikipedia.org/wiki/Lanterns_(TV_series)',       '2026-09-25T00:00:00.000Z');

INSERT INTO seasons (show_id, number, subtitle, url, episode_count, created_at)
SELECT id, 14, '', 'https://en.wikipedia.org/wiki/The_Great_British_Bake_Off_series_14', 10, '2026-09-25T00:00:00.000Z'
FROM shows WHERE name = 'The Great British Bake Off';

INSERT INTO seasons (show_id, number, subtitle, url, episode_count, created_at)
SELECT id, 1, '', 'https://en.wikipedia.org/wiki/Lanterns_(TV_series)', 8, '2026-09-25T00:00:00.000Z'
FROM shows WHERE name = 'Lanterns';
