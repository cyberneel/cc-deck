import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEvictable } from '../src/slots.js';

test('only an idle, unattached session Friday started is closed for a slot, longest idle first', () => {
  const now = 1_000_000, ms = 300_000;
  const s = (name, origin, attached = false) => ({ name, origin, attached });
  const sessions = [s('user-idle', 'user'), s('fri-fresh', 'proactive'), s('fri-old', 'proactive'), s('fri-older-attached', 'proactive', true), s('fri-busy', 'proactive'), s('fri-oldest', 'proactive')];
  const idle = new Map([['user-idle', 0], ['fri-fresh', now - 1000], ['fri-old', now - ms], ['fri-older-attached', 0], ['fri-oldest', now - 2 * ms]]);
  assert.equal(pickEvictable(sessions, idle, now, ms).name, 'fri-oldest');
  assert.equal(pickEvictable(sessions.filter((x) => !x.name.startsWith('fri-old')), idle, now, ms), null);
});
