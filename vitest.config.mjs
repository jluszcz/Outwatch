import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    plugins: [
        cloudflareTest(async () => {
            const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
            return {
                wrangler: { configPath: './wrangler.toml' },
                miniflare: {
                    d1Databases: ['DB'],
                    // Hand the real migrations to the worker so the test setup can apply them.
                    bindings: { TEST_MIGRATIONS: migrations },
                },
            };
        }),
    ],
    test: {
        globals: true,
        include: ['test/**/*.test.js'],
        setupFiles: ['./test/apply-migrations.js'],
    },
});
