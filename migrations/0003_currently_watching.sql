ALTER TABLE users ADD COLUMN currently_watching_season_id INTEGER REFERENCES seasons(id);
