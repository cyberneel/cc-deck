import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { CCDECK_TELEMETRY_URL: 'http://t/ingest', CCDECK_TELEMETRY_TOKEN: 'x', CCDECK_TENANT_ID: 't', CCDECK_SECRET: 's' });
const { onHook, startTurnTelemetry } = await import('../src/turn-telemetry.js');

test('turns per engine: claude/codex by hook_event_name, agy by header + first PreInvocation', async () => {
  const sent = [];
  mock.method(globalThis, 'fetch', async (_u, o) => { sent.push(...JSON.parse(o.body).events); return { status: 200 }; });
  mock.timers.enable({ apis: ['setInterval'] });
  startTurnTelemetry();
  onHook({ session_id: 'c1', hook_event_name: 'UserPromptSubmit' }, { engine: 'codex' });
  onHook({ conversationId: 'a1' }, { engine: 'agy', event: 'PreInvocation' });
  onHook({ conversationId: 'a1' }, { engine: 'agy', event: 'PreInvocation' }); // 2nd model call, same turn
  onHook({ conversationId: 'a1' }, { engine: 'agy', event: 'Stop' });
  onHook({ session_id: 'c1', hook_event_name: 'Stop' }, { engine: 'codex' });
  onHook({ conversationId: 'zz' }, { engine: 'agy', event: 'Stop' }); // never started: dropped
  onHook({ session_id: 'x1', hook_event_name: 'UserPromptSubmit' }, { engine: 'bogus' });
  onHook({ session_id: 'x1', hook_event_name: 'Stop' });
  mock.timers.tick(60_000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map((e) => e.engine), ['agy', 'codex', 'claude']);
  assert.equal(sent[1].meta.inflight, 0);
  mock.timers.reset();
});
