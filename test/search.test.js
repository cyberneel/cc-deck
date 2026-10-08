import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankSessions } from '../src/mcp.js';

test('search returns the sessions holding the most query words, titled ones first', () => {
  const c = (id, title, has, mtime) => ({ id, title, has: new Set(has), mtime });
  const words = ['rtk', 'base', 'station', 'survey-in'];
  const cands = [
    c('noise-new', '', ['rtk', 'base', 'station'], 30), // another session that only lists it
    c('real', 'Base station setup (research)', ['rtk', 'base', 'station'], 20),
    c('one-word', '', ['base'], 40),
  ];
  // Nobody has "survey-in": the 3-of-4 group wins, and the one named for it leads.
  assert.deepEqual(rankSessions(words, cands).map((x) => x.id), ['real', 'noise-new']);
  // A title alone counts (a just-started session's transcript may not say it yet).
  assert.deepEqual(rankSessions(['telemetry'], [c('t', 'Car telemetry last night', [], 1)]).map((x) => x.id), ['t']);
  // A title word has to start with the query word: "day" doesn't name "Friday (ctx)".
  const day = [c('fri', 'Friday (ctx)', ['day', 'telemetry'], 9), c('car', 'Car telemetry last night', ['day', 'telemetry'], 1)];
  assert.deepEqual(rankSessions(['day', 'telemetry'], day).map((x) => x.id), ['car', 'fri']);
  // Under half the words is not a match.
  assert.deepEqual(rankSessions(words, [c('one-word', '', ['base'], 40)]), []);
});
