import { applyD1Migrations, env } from 'cloudflare:test';

// Apply the real migrations/*.sql (read in vitest.config.mjs and passed in via the
// TEST_MIGRATIONS binding) so tests run against the exact schema that ships to D1 —
// foreign keys and indexes included. applyD1Migrations is idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
