-- Survivor, shared with Outwatch (../Outwatch). Outwatch binds this same
-- database and is a Survivor-only frontend onto it: it finds the show by this
-- exact name, so renaming it breaks Outwatch. Seasons 1–51 are Outwatch's
-- reference data, carried over with their subtitles, Wikipedia links, and
-- episode counts (reunion specials excluded). Later seasons are added from
-- either app rather than by migration.
INSERT INTO shows (name, url, created_at) VALUES
    ('Survivor', 'https://en.wikipedia.org/wiki/Survivor_(American_TV_series)', '2026-10-10T00:00:00.000Z');

INSERT INTO seasons (show_id, number, subtitle, url, episode_count, created_at)
SELECT shows.id, v.column1, v.column2, v.column3, v.column4, '2026-10-10T00:00:00.000Z'
FROM shows, (VALUES
    (1, 'Borneo', 'https://en.wikipedia.org/wiki/Survivor:_Borneo', 13),
    (2, 'The Australian Outback', 'https://en.wikipedia.org/wiki/Survivor:_The_Australian_Outback', 15),
    (3, 'Africa', 'https://en.wikipedia.org/wiki/Survivor:_Africa', 14),
    (4, 'Marquesas', 'https://en.wikipedia.org/wiki/Survivor:_Marquesas', 14),
    (5, 'Thailand', 'https://en.wikipedia.org/wiki/Survivor:_Thailand', 14),
    (6, 'The Amazon', 'https://en.wikipedia.org/wiki/Survivor:_The_Amazon', 14),
    (7, 'Pearl Islands', 'https://en.wikipedia.org/wiki/Survivor:_Pearl_Islands', 14),
    (8, 'All-Stars', 'https://en.wikipedia.org/wiki/Survivor:_All-Stars', 16),
    (9, 'Vanuatu', 'https://en.wikipedia.org/wiki/Survivor:_Vanuatu', 14),
    (10, 'Palau', 'https://en.wikipedia.org/wiki/Survivor:_Palau', 14),
    (11, 'Guatemala', 'https://en.wikipedia.org/wiki/Survivor:_Guatemala', 14),
    (12, 'Panama', 'https://en.wikipedia.org/wiki/Survivor:_Panama', 15),
    (13, 'Cook Islands', 'https://en.wikipedia.org/wiki/Survivor:_Cook_Islands', 15),
    (14, 'Fiji', 'https://en.wikipedia.org/wiki/Survivor:_Fiji', 14),
    (15, 'China', 'https://en.wikipedia.org/wiki/Survivor:_China', 14),
    (16, 'Micronesia', 'https://en.wikipedia.org/wiki/Survivor:_Micronesia', 14),
    (17, 'Gabon', 'https://en.wikipedia.org/wiki/Survivor:_Gabon', 13),
    (18, 'Tocantins', 'https://en.wikipedia.org/wiki/Survivor:_Tocantins', 14),
    (19, 'Samoa', 'https://en.wikipedia.org/wiki/Survivor:_Samoa', 15),
    (20, 'Heroes vs. Villains', 'https://en.wikipedia.org/wiki/Survivor:_Heroes_vs._Villains', 14),
    (21, 'Nicaragua', 'https://en.wikipedia.org/wiki/Survivor:_Nicaragua', 15),
    (22, 'Redemption Island', 'https://en.wikipedia.org/wiki/Survivor:_Redemption_Island', 14),
    (23, 'South Pacific', 'https://en.wikipedia.org/wiki/Survivor:_South_Pacific', 15),
    (24, 'One World', 'https://en.wikipedia.org/wiki/Survivor:_One_World', 14),
    (25, 'Philippines', 'https://en.wikipedia.org/wiki/Survivor:_Philippines', 14),
    (26, 'Caramoan', 'https://en.wikipedia.org/wiki/Survivor:_Caramoan', 14),
    (27, 'Blood vs. Water', 'https://en.wikipedia.org/wiki/Survivor:_Blood_vs._Water', 14),
    (28, 'Cagayan', 'https://en.wikipedia.org/wiki/Survivor:_Cagayan', 13),
    (29, 'San Juan del Sur', 'https://en.wikipedia.org/wiki/Survivor:_San_Juan_del_Sur', 14),
    (30, 'Worlds Apart', 'https://en.wikipedia.org/wiki/Survivor:_Worlds_Apart', 14),
    (31, 'Cambodia', 'https://en.wikipedia.org/wiki/Survivor:_Cambodia', 14),
    (32, 'Kaôh Rōng', 'https://en.wikipedia.org/wiki/Survivor:_Kaôh_Rōng', 14),
    (33, 'Millennials vs. Gen X', 'https://en.wikipedia.org/wiki/Survivor:_Millennials_vs._Gen_X', 13),
    (34, 'Game Changers', 'https://en.wikipedia.org/wiki/Survivor:_Game_Changers', 12),
    (35, 'Heroes vs. Healers vs. Hustlers', 'https://en.wikipedia.org/wiki/Survivor:_Heroes_vs._Healers_vs._Hustlers', 13),
    (36, 'Ghost Island', 'https://en.wikipedia.org/wiki/Survivor:_Ghost_Island', 13),
    (37, 'David vs. Goliath', 'https://en.wikipedia.org/wiki/Survivor:_David_vs._Goliath', 13),
    (38, 'Edge of Extinction', 'https://en.wikipedia.org/wiki/Survivor:_Edge_of_Extinction', 13),
    (39, 'Island of the Idols', 'https://en.wikipedia.org/wiki/Survivor:_Island_of_the_Idols', 13),
    (40, 'Winners at War', 'https://en.wikipedia.org/wiki/Survivor:_Winners_at_War', 14),
    (41, '', 'https://en.wikipedia.org/wiki/Survivor_41', 13),
    (42, '', 'https://en.wikipedia.org/wiki/Survivor_42', 13),
    (43, '', 'https://en.wikipedia.org/wiki/Survivor_43', 13),
    (44, '', 'https://en.wikipedia.org/wiki/Survivor_44', 13),
    (45, '', 'https://en.wikipedia.org/wiki/Survivor_45', 13),
    (46, '', 'https://en.wikipedia.org/wiki/Survivor_46', 13),
    (47, '', 'https://en.wikipedia.org/wiki/Survivor_47', 14),
    (48, '', 'https://en.wikipedia.org/wiki/Survivor_48', 13),
    (49, '', 'https://en.wikipedia.org/wiki/Survivor_49', 13),
    (50, 'In the Hands of the Fans', 'https://en.wikipedia.org/wiki/Survivor_50', 13),
    (51, '', 'https://en.wikipedia.org/wiki/Survivor_51', 13)
) AS v
WHERE shows.name = 'Survivor';
