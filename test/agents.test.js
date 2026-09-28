import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownName } from '../src/agents.js';

test('shownName strips Claude status glyphs from the pane title', () => {
  assert.equal(shownName('✳ Friday (ctx)'), 'Friday (ctx)');
  assert.equal(shownName('⠂ Friday (ctx) (2)'), 'Friday (ctx) (2)');
  assert.equal(shownName('Friday (ctx)'), 'Friday (ctx)');
  assert.equal(shownName(''), '');
});
