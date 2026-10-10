import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Transcripts live under ~/.claude/projects: a scratch HOME, so the real ones are never read.
process.env.HOME = mkdtempSync(join(tmpdir(), 'ccdeck-history-'));
const { listHistory } = await import('../src/history.js');

test('History leaves out `claude -p` runs, even one whose prompt names a session', async () => {
  const dir = join(process.env.HOME, '.claude', 'projects', '-work-cyberdeck');
  mkdirSync(dir, { recursive: true });
  const line = (entrypoint, text) => [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
    JSON.stringify({ type: 'user', entrypoint, cwd: '/work/cyberdeck', message: { role: 'user', content: text } }),
  ].join('\n') + '\n' + 'x'.repeat(200);
  writeFileSync(join(dir, '11111111-1111-1111-1111-111111111111.jsonl'), line('cli', 'Pager firmware: ANCS client'));
  writeFileSync(join(dir, '22222222-2222-2222-2222-222222222222.jsonl'), line('sdk-cli', 'Grade these replies about the CyberDeck session'));
  const h = await listHistory();
  assert.deepEqual(h.sessions.map((s) => s.title), ['Pager firmware: ANCS client']);
  assert.equal(h.total, 1);
});
