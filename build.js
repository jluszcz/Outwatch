import { build, context } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { argv } from 'node:process';

const execAsync = promisify(exec);
const watch = argv.includes('--watch');

const options = {
    entryPoints: ['frontend/script.js'],
    bundle: true,
    format: 'esm',
    minify: !watch,
    sourcemap: watch,
    outfile: 'public/script.js',
    target: ['es2022'],
    logLevel: 'info',
};

await mkdir('public', { recursive: true });

if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('esbuild watching frontend/');
} else {
    await build(options);
    await execAsync('csso frontend/styles.css --output public/styles.css');
}
