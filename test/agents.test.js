import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shownName, matchAgents, deckStatus } from '../src/agents.js';

test('shownName strips Claude status glyphs from the pane title', () => {
  assert.equal(shownName('✳ Friday (ctx)'), 'Friday (ctx)');
  assert.equal(shownName('⠂ Friday (ctx) (2)'), 'Friday (ctx) (2)');
  assert.equal(shownName('Friday (ctx)'), 'Friday (ctx)');
  assert.equal(shownName(''), '');
});

test('a parked pane maps to its job and is flagged with its main conversation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ccdeck-agents-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const kid = spawn('sleep', ['30']); // stands in for the pane's (parked) claude process
  t.after(() => { kid.kill(); process.env.HOME = prevHome; });
  await new Promise((r) => kid.once('spawn', r));
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
  const reg = (o) => writeFileSync(join(home, '.claude', 'sessions', `${kid.pid}.json`), JSON.stringify(o));
  const jobs = [
    { kind: 'background', id: 'aaaa1111', name: 'Friday (ctx)', sessionId: 'job-a', status: 'idle' },
    { kind: 'background', id: 'bbbb2222', name: 'Friday (ctx) (2)', sessionId: 'job-b', status: 'busy' },
  ];
  const pane = () => ({ name: 'ccdeck-x', dir: '/x', panePid: process.pid, paneTitle: '⠂ Friday (ctx) (2)' });

  reg({ sessionId: 'main-1', parkedJobId: 'aaaa1111' });
  let [s] = matchAgents([pane()], jobs);
  assert.equal(s.liveSessionId, 'job-b'); // the title wins over the stale parkedJobId
  assert.deepEqual(s.parked, { main: 'main-1', job: 'bbbb2222', jobName: 'Friday (ctx) (2)' });

  reg({ sessionId: 'main-1' }); // not parked → no flag
  [s] = matchAgents([pane()], jobs);
  assert.equal(s.parked, undefined);
});

test('busy with only background work left reads idle once the turn ended', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ccdeck-agents-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = prevHome; });
  const dir = join(home, '.claude', 'projects', '-w-my-app');
  mkdirSync(dir, { recursive: true });
  const write = (...rows) => writeFileSync(join(dir, 'sid-1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const agent = [{ kind: 'interactive', pid: 1, cwd: '/w/my.app', sessionId: 'sid-1', status: 'busy' }];
  const status = () => deckStatus(matchAgents([{ name: 'ccdeck-x', dir: '/w/my.app', paneCommand: 'claude' }], agent)[0]);

  write({ type: 'user' }, { type: 'assistant' }); // mid-turn
  assert.equal(status(), 'running');
  write({ type: 'assistant' }, { type: 'system', subtype: 'stop_hook_summary' }, { type: 'system', subtype: 'turn_duration' }, { type: 'system', subtype: 'away_summary' }, { type: 'attachment' });
  assert.equal(status(), 'idle'); // turn over, a background agent still running
  write({ type: 'system', subtype: 'turn_duration' }, { type: 'user' }); // its notification started a new turn
  assert.equal(status(), 'running');
});

test('a prompt is answered by its option key, never a blind Enter', async () => {
  const { menuOptions, pickOption } = await import('../src/tmux.js');
  const screen = [
    'Plan: 1. migrate  2. deploy',
    '1. old list item',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for rm commands",
    '   3. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  const opts = menuOptions(screen);
  assert.deepEqual(opts.map((o) => o.n), ['1', '2', '3']); // the last menu, not the list above
  assert.equal(pickOption(opts, 'yes').key, '1');
  assert.equal(pickOption(opts, ' No ').key, '3');
  assert.equal(pickOption(opts, '2').key, '2');
  assert.equal(pickOption(opts, 'esc').key, 'Escape');
  assert.equal(pickOption(opts, 'y'), null); // not a whole word of any label
  assert.equal(pickOption(opts, 'ship it'), null);
  const picker = menuOptions('❯ 1. Postgres\n     fast\n  2. SQLite\n  3. Type something.\n  4. Chat about this');
  assert.deepEqual(pickOption(picker, 'sqlite'), { key: '2', label: 'SQLite' });
  assert.equal(pickOption(picker, 'use duckdb instead').type, true);
});
