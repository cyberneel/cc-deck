// Snapshot the currently-active cc-deck sessions to disk so they're restored on
// the next startup (e.g. before rebooting the box). Run: `npm run snapshot`.
// Works by reading the dedicated tmux server directly — the cc-deck web process
// need not be involved.
import { captureSnapshot } from '../src/restore.js';

try {
  const n = await captureSnapshot();
  console.log(`cc-deck: snapshotted ${n} active session(s). They'll be restored automatically on next startup.`);
  process.exit(0);
} catch (e) {
  console.error('cc-deck snapshot failed:', e.message);
  process.exit(1);
}
