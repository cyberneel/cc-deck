import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A private tmux server, so nothing lands on the real Polymux socket.
process.env.POLYMUX_TMUX_SOCKET = `ccdeck-test-${process.pid}`;
const { relayText, openMenu } = await import('../src/tmux.js');
const tmux = (...a) => execFileSync('tmux', ['-L', process.env.POLYMUX_TMUX_SOCKET, ...a], { stdio: 'pipe' });
const dir = mkdtempSync(join(tmpdir(), 'ccdeck-relay-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stands in for a CLI: shows each menu screen in turn and Esc moves to the next (agy skips one
// question per Esc); after the last, a prompt takes lines. Any other key while a menu is up is
// logged as a menu press (what Enter-on-a-picker did to relayed text).
writeFileSync(join(dir, 'cli.cjs'), `
const fs = require('fs'); const [out, file] = process.argv.slice(2);
const { screens, idle } = JSON.parse(fs.readFileSync(file, 'utf8'));
process.stdin.setRawMode(true); process.stdin.resume();
let i = 0, buf = '';
const show = () => process.stdout.write('\\x1b[2J\\x1b[H' + (i < screens.length ? screens[i] : idle + '\\r\\n> '));
show();
process.stdin.on('data', (d) => { const s = d.toString();
  if (i < screens.length) { if (s === '\\x1b') { i++; show(); } else fs.appendFileSync(out, 'menu-key\\n'); return; }
  buf += s; if (buf.includes('\\r')) { fs.appendFileSync(out, 'line:' + buf.replace('\\r', '') + '\\n'); buf = ''; }
});`);

let n = 0;
async function pane(t, screens, idle = ['declined']) {
  const name = `ccdeck-relay${++n}`, out = join(dir, `${n}.log`), file = join(dir, `${n}.json`);
  writeFileSync(file, JSON.stringify({ screens: screens.map((s) => s.join('\r\n')), idle: idle.join('\r\n') }));
  tmux('new-session', '-d', '-s', name, '-x', '140', '-y', '30', `node ${join(dir, 'cli.cjs')} ${out} ${file}`);
  t.after(() => { try { tmux('kill-session', '-t', name); } catch {} });
  await sleep(600);
  return { name, log: () => (existsSync(out) ? readFileSync(out, 'utf8') : '') };
}

// Real screens, trimmed (Claude Code; Codex 0.151 and agy 1.2.17 captured 2026-10-07).
const claudePicker = ['❯ 1. Texas schools', '  2. Housing', '  3. Type something.'];
const claudePerm = ['❯ 1. Yes', '  2. No'];
const codexApproval = [
  '  Would you like to run the following command?',
  '  $ touch /tmp/probe.txt',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for commands that start with `touch /tmp/probe.txt` (p)",
  '  3. No, and tell Codex what to do differently (esc)',
  '  Press enter to confirm or esc to cancel',
];
const codexPicker = [
  '  Question 1/2 (2 unanswered)', '  Which color?',
  '  › 1. Red                Choose red.',
  '    2. Blue               Choose blue.',
  '    3. None of the above  Optionally, add details in notes (tab).',
  '  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt',
];
const agyQ = (k, q, a, b) => [`Question ${k}/2: ${q}`, `> 1. ${a}`, `  2. ${b}`, '  3. Write-in...', '  ↑/↓ Navigate · enter Select · esc Skip'];

test('Claude: a question picker is closed with Esc and the text arrives as a reply', async (t) => {
  const p = await pane(t, [claudePicker]);
  assert.deepEqual(await relayText(p.name, 'Pick housing, and find me a dataset', true), { dismissed: true });
  await sleep(300);
  assert.equal(p.log(), 'line:Pick housing, and find me a dataset\n');
});

test('Claude: a permission menu is left for the user and nothing is typed', async (t) => {
  const p = await pane(t, [claudePerm]);
  const r = await relayText(p.name, 'yes go ahead', true);
  assert.deepEqual(r.opts.map((o) => o.label), ['Yes', 'No']);
  await sleep(300);
  assert.equal(p.log(), '');
});

test('Codex (no waiting state): an approval is read off the screen and never answered', async (t) => {
  const p = await pane(t, [codexApproval]);
  const r = await relayText(p.name, 'I pick the second one', null);
  assert.deepEqual(r.opts.map((o) => o.n), ['1', '2', '3']);
  await sleep(300);
  assert.equal(p.log(), '');
});

test('Codex: a request_user_input picker closes on one Esc', async (t) => {
  const p = await pane(t, [codexPicker]);
  assert.deepEqual(await relayText(p.name, 'Blue', null), { dismissed: true });
  await sleep(300);
  assert.equal(p.log(), 'line:Blue\n');
});

test('agy: each question is skipped, then the text arrives', async (t) => {
  const p = await pane(t, [agyQ(1, 'Which color?', 'Red', 'Blue'), agyQ(2, 'Which size?', 'Small', 'Large')]);
  assert.deepEqual(await relayText(p.name, 'Blue and Large', null), { dismissed: true });
  await sleep(300);
  assert.equal(p.log(), 'line:Blue and Large\n');
});

test('a numbered list in the conversation is not a menu', async (t) => {
  const p = await pane(t, [], ['Plan:', '1. migrate', '2. deploy']);
  assert.deepEqual(await openMenu(p.name, null), []);
  assert.deepEqual(await openMenu(p.name, false), []);
});

test('handoff into a running session waits out a menu, then types', async (t) => {
  const { sendWhenNoMenu } = await import('../src/handoff.js');
  const p = await pane(t, [codexApproval]);
  assert.equal(await sendWhenNoMenu(p.name, 'read the handoff', { every: 100, ms: 400 }), false);
  const sent = sendWhenNoMenu(p.name, 'read the handoff', { every: 100, ms: 5000 });
  await sleep(500);
  assert.equal(p.log(), ''); // nothing typed into the approval
  tmux('send-keys', '-t', p.name, 'Escape'); // the user answers it
  assert.equal(await sent, true);
  await sleep(300);
  assert.equal(p.log(), 'line:read the handoff\n');
});

test.after(() => { try { tmux('kill-server'); } catch {} });
