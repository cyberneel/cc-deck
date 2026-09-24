// node --test test/  — the incremental transcript cache in src/graph.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'ccdeck-graph-'));
const dir = join(process.env.HOME, '.claude', 'projects', '-tmp-proj');
mkdirSync(dir, { recursive: true });
const { buildGraph, buildThread } = await import('../src/graph.js');

const id = '00000000-0000-4000-8000-000000000001';
const file = join(dir, `${id}.jsonl`);
const line = (o) => JSON.stringify(o) + '\n';
const user = (uuid, parentUuid, text, ts) => ({ uuid, parentUuid, type: 'user', timestamp: ts, message: { content: text } });
const asst = (uuid, parentUuid, content, ts) => ({ uuid, parentUuid, type: 'assistant', timestamp: ts, message: { content, usage: { input_tokens: 5, output_tokens: 7 } } });

test('appends parse incrementally, a half-written line waits, a rewrite starts over', async () => {
  const third = line(user('u3', 'a2', 'and then?', '2026-01-01T00:00:03Z'));
  writeFileSync(file,
    line(user('u1', null, 'hello', '2026-01-01T00:00:01Z')) +
    line(asst('a2', 'u1', [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(1000) } }], '2026-01-01T00:00:02Z')) +
    third.slice(0, 20));
  let g = await buildGraph(id);
  assert.equal(g.nodes.length, 2);
  assert.deepEqual(g.nodes[1].tools, [{ name: 'Bash', count: 1 }]);
  assert.equal(g.nodes[1].tokens.out, 7);

  appendFileSync(file, third.slice(20));
  g = await buildGraph(id);
  assert.deepEqual(g.nodes.map((n) => n.id), ['u1', 'a2', 'u3']);
  assert.equal(g.nodes.find((n) => n.current).id, 'u3');
  const t = await buildThread(id, 'u3');
  assert.deepEqual(t.messages.map((m) => m.text), ['hello', 'hi', 'and then?']);

  writeFileSync(file, line(user('x1', null, 'fresh', '2026-01-02T00:00:00Z')));
  g = await buildGraph(id);
  assert.deepEqual(g.nodes.map((n) => n.id), ['x1']);
});
