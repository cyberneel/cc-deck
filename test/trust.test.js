import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustKey } from '../src/tmux.js';
import { claude } from '../src/providers/claude.js';

// Claude 2.1.299's trust menu, as a Deep Session showed it on 2026-10-14 (cursor on "No, exit").
const menu = (cursorOnYes) => [
  "claude --append-system-prompt 'if unsure, answer yes or no.",
  "> keep going'",
  ' Accessing workspace:',
  ' /home/cyber/friday-sessions/autocross-roster',
  " Claude Code'll be able to read, edit, and execute files here.",
  `${cursorOnYes ? '  ' : ' ❯'} No, exit`,
  `${cursorOnYes ? ' ❯' : '  '} Yes, I trust this folder`,
  ' Enter to confirm · Esc to cancel',
].join('\n');

test('trust: move onto "Yes" first, Enter only once the screen shows it there', () => {
  const yes = claude.trust.yes;
  assert.ok(claude.trust.re.test(menu(false)));
  assert.equal(trustKey(menu(false), yes), 'Down'); // never Enter on "No, exit"
  assert.equal(trustKey(menu(true), yes), 'Enter');
  assert.equal(trustKey(' ❯ Yes, proceed\n   No, exit', yes), 'Enter');
  assert.equal(trustKey('   1. Yes, proceed\n › 2. No, exit', yes), 'Up');
  assert.equal(trustKey('Do you trust this folder?', yes), null); // menu not drawn yet
  assert.notEqual(trustKey(menu(false).replace(' ❯', '  '), yes), 'Enter'); // drawn before its highlight: Enter would pick No
});
