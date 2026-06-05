import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFile, readFile, writeFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Generate the service worker, stamping a fresh BUILD id so every deploy ships a
// byte-different worker the browser will install (→ "new version" prompt).
async function buildServiceWorker() {
  const src = await readFile(join(__dirname, 'src/sw.js'), 'utf8');
  const stamped = src.replace('__BUILD__', String(Date.now()));
  await writeFile(join(__dirname, 'public/sw.js'), stamped);
}

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

await buildServiceWorker();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await build(options);
  console.log('[esbuild] build complete');
}
