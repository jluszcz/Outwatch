import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';
import { argv } from 'node:process';

const watch = argv.includes('--watch');

// styles.css is an entry point too: esbuild minifies it in prod and rebuilds it
// in watch mode, so `npm run dev` serves styles on a fresh clone and picks up
// CSS edits without a manual build.
const options = {
    entryPoints: ['frontend/script.js', 'frontend/styles.css'],
    bundle: true,
    format: 'esm',
    minify: !watch,
    sourcemap: watch,
    outdir: 'public',
    target: ['es2022'],
    logLevel: 'info',
};

if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('esbuild watching frontend/');
} else {
    await build(options);
    // Watch mode emits sourcemaps into public/; production builds don't, so
    // remove leftovers from a dev session or `wrangler deploy` uploads them.
    await Promise.all(
        ['public/script.js.map', 'public/styles.css.map'].map((f) => rm(f, { force: true })),
    );
}
