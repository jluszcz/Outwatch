-- GET /api/feed reads every note in the past 30 days (`WHERE created_at >= ?`).
-- The only other index on posts is idx_posts_board (season_id, episode, id),
-- whose leading column the feed does not filter on, so that query had no index
-- to use and scanned the whole table.
--
-- Worth an index on a table this small because of when it runs rather than how
-- much it currently costs: the what's-new bell fetches on every page load for
-- every user, and posts is the one table here that only ever grows.
CREATE INDEX idx_posts_created ON posts (created_at);
