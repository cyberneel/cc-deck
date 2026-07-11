// Session snapshot + restore. cc-deck's tmux sessions live in RAM, so a host
// reboot loses them (only the Claude transcripts survive on disk). This captures
// each active session's directory/title + the Claude session id to resume, so on
// the next startup we can relaunch them with `claude --resume <id>`.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listSessions, createSession } from './tmux.js';
import { getAgents, matchAgents } from './agents.js';

const DIR = join(homedir(), '.claude', 'cc-deck');
const FILE = process.env.CCDECK_RESTORE_FILE || join(DIR, 'restore.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Write a snapshot of the currently-active sessions (atomic). Returns the count.
// skipIfEmpty: don't clobber a good snapshot with an empty one — used on shutdown,
// where a reboot teardown race can make listSessions() return 0 mid-kill. In that
// case we keep the last periodic snapshot instead of wiping it (the real bug that
// lost sessions across `sudo reboot`).
export async function captureSnapshot({ skipIfEmpty = false } = {}) {
  const sessions = await listSessions();
  try { matchAgents(sessions, await getAgents()); } catch { /* resume ids best-effort */ }
  const entries = sessions
    .filter((s) => s.dir)
    .map((s) => ({ dir: s.dir, title: s.title, resume: s.liveSessionId || s.resumedFrom || null }));
  if (!entries.length && skipIfEmpty) return -1; // keep last-good snapshot
  await mkdir(DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ at: Date.now(), version: 1, sessions: entries }, null, 2));
  await rename(tmp, FILE);
  return entries.length;
}

export async function loadSnapshot() {
  try { return JSON.parse(await readFile(FILE, 'utf8')); } catch { return null; }
}

// Restore from the snapshot ONLY on a fresh boot (no managed sessions running) —
// so a normal `systemctl restart` (where KillMode=process keeps tmux alive) never
// duplicates sessions. Returns { restored, total } or a skip reason.
export async function restoreIfBoot() {
  if (process.env.CCDECK_RESTORE === 'off') return { skipped: true, reason: 'disabled (CCDECK_RESTORE=off)' };
  const running = await listSessions();
  if (running.length) return { skipped: true, reason: `${running.length} session(s) already running` };
  const snap = await loadSnapshot();
  if (!snap || !Array.isArray(snap.sessions) || !snap.sessions.length) return { skipped: true, reason: 'no snapshot' };

  let restored = 0;
  for (const e of snap.sessions) {
    try {
      await createSession({ dir: e.dir, title: e.title, resume: e.resume || undefined });
      restored += 1;
    } catch {
      // Resume id invalid / transcript gone → fall back to a fresh session in the dir.
      if (e.resume) { try { await createSession({ dir: e.dir, title: e.title }); restored += 1; } catch { /* dir gone */ } }
    }
    await sleep(800); // stagger claude launches
  }
  return { restored, total: snap.sessions.length };
}
