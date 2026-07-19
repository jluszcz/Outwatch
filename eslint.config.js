import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['public/', '.wrangler/', 'coverage/', 'node_modules/'] },
    js.configs.recommended,
    {
        rules: {
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['frontend/**/*.js'],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ['src/**/*.js'],
        languageOptions: { globals: globals.serviceworker },
    },
    {
        files: ['build.js', 'eslint.config.js', 'vitest.config.mjs'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['test/**/*.js'],
        languageOptions: { globals: { ...globals.node, ...globals.browser } },
    },
];
