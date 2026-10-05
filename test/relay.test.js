import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A private tmux server, so nothing lands on the real Polymux socket.
process.env.POLYMUX_TMUX_SOCKET = `ccdeck-test-${process.pid}`;
const { relayText } = await import('../src/tmux.js');
const tmux = (...a) => execFileSync('tmux', ['-L', process.env.POLYMUX_TMUX_SOCKET, ...a], { stdio: 'pipe' });
const dir = mkdtempSync(join(tmpdir(), 'ccdeck-relay-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stands in for the CLI's menus: Esc closes the menu and opens a prompt; any other key while
// the menu is up is logged as a menu press (what Enter-on-a-picker did to relayed text).
writeFileSync(join(dir, 'menu.cjs'), `
const fs = require('fs'); const [out, kind] = process.argv.slice(2);
process.stdin.setRawMode(true); process.stdin.resume();
console.log(kind === 'picker' ? '❯ 1. Texas schools\\n  2. Housing\\n  3. Type something.' : '❯ 1. Yes\\n  2. No');
let menu = true, buf = '';
process.stdin.on('data', (d) => { const s = d.toString();
  if (menu) { if (s === '\\x1b') { menu = false; process.stdout.write('\\x1b[2J\\x1b[Hdeclined\\n> '); } else fs.appendFileSync(out, 'menu-key\\n'); return; }
  buf += s; if (buf.includes('\\r')) { fs.appendFileSync(out, 'line:' + buf.replace('\\r', '') + '\\n'); buf = ''; }
});`);

async function pane(t, kind) {
  const name = `ccdeck-relay${kind}`, out = join(dir, `${kind}.log`);
  tmux('new-session', '-d', '-s', name, '-x', '80', '-y', '20', `node ${join(dir, 'menu.cjs')} ${out} ${kind}`);
  t.after(() => { try { tmux('kill-session', '-t', name); } catch {} });
  await sleep(600);
  return { name, log: () => (existsSync(out) ? readFileSync(out, 'utf8') : '') };
}

test('a question picker is closed with Esc and the text arrives as a reply', async (t) => {
  const p = await pane(t, 'picker');
  assert.deepEqual(await relayText(p.name, 'Pick housing, and find me a dataset', true), { dismissed: true });
  await sleep(300);
  assert.equal(p.log(), 'line:Pick housing, and find me a dataset\n');
});

test('a permission menu is left for the user and nothing is typed', async (t) => {
  const p = await pane(t, 'perm');
  const r = await relayText(p.name, 'yes go ahead', true);
  assert.deepEqual(r.opts.map((o) => o.label), ['Yes', 'No']);
  await sleep(300);
  assert.equal(p.log(), '');
});

test.after(() => { try { tmux('kill-server'); } catch {} });
