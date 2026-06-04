import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [
    join(__dirname, 'src/client/dashboard.js'),
    join(__dirname, 'src/client/terminal.js'),
  ],
  bundle: true,
  format: 'esm',
  sourcemap: true,
  minify: !watch,
  outdir: join(__dirname, 'public'),
  loader: { '.css': 'text' },
  logLevel: 'info',
};

// Ship xterm's stylesheet alongside the bundles.
await copyFile(
  join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'),
  join(__dirname, 'public/xterm.css'),
);

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await build(options);
  console.log('[esbuild] build complete');
}
