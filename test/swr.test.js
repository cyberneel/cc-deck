import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swr } from '../src/swr.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('swr: one shared load, stale served instantly, too-old awaited', async () => {
  let calls = 0;
  const get = swr(async () => { calls++; await sleep(30); return calls; }, 20, 120);

  // Cold: concurrent callers share ONE in-flight load.
  assert.deepEqual(await Promise.all([get(), get(), get()]), [1, 1, 1]);
  assert.equal(calls, 1);

  // Fresh: no load.
  assert.equal(await get(), 1);
  assert.equal(calls, 1);

  // Stale (past ttl, inside maxStale): old value right away, one background load.
  await sleep(25);
  const t0 = Date.now();
  assert.equal(await get(), 1);
  assert.ok(Date.now() - t0 < 15, 'stale read must not wait for the load');
  assert.equal(await get(), 1); // still in flight → no second load
  await sleep(40);
  assert.equal(calls, 2);
  assert.equal(await get(), 2);

  // Too old to trust: the caller waits for fresh data.
  await sleep(130);
  assert.equal(await get(), 3);
});

test('swr: a failed load rejects its waiters and the next call retries', async () => {
  let n = 0;
  const get = swr(async () => { if (++n === 1) throw new Error('boom'); return 'ok'; }, 1000);
  await assert.rejects(get(), /boom/);
  assert.equal(await get(), 'ok');
});
