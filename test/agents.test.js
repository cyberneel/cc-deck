import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shownName, matchAgents } from '../src/agents.js';

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
