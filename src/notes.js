// "External notes": summaries pushed back into a cc-deck session from an outside
// chat (via the MCP save_session_summary tool). They surface when the user next
// opens/resumes that session, so the session becomes aware of what happened
// elsewhere. Stored as markdown files keyed by the Claude sessionId. A pending
// note is `<sessionId>-<ts>.md`; once delivered it's renamed to `.md.done` (the
// file stays so Claude can Read it, but it won't be injected again).
import { mkdir, writeFile, readdir, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const NOTES_DIR = join(homedir(), '.claude', 'cc-deck', 'notes');
const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;

export async function addNote(sessionId, summary, source = 'an outside Claude chat') {
  if (!SESSION_ID_RE.test(sessionId)) { const e = new Error('invalid session id'); e.statusCode = 400; throw e; }
  await mkdir(NOTES_DIR, { recursive: true });
  const file = join(NOTES_DIR, `${sessionId}-${Date.now().toString(36)}.md`);
  const body = `# External update from ${source}\n\n_Saved via cc-deck MCP. This summarizes work that happened outside this session._\n\n${summary}\n`;
  await writeFile(file, body);
  return file;
}

async function listFiles() {
  try { return await readdir(NOTES_DIR); } catch { return []; }
}

// Pending (not-yet-delivered) note files for a session.
export async function listPending(sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return [];
  const names = await listFiles();
  return names.filter((n) => n.startsWith(`${sessionId}-`) && n.endsWith('.md')).map((n) => join(NOTES_DIR, n));
}

// Read pending note contents for a session (for the viewer), newest first.
export async function readPending(sessionId) {
  const files = await listPending(sessionId);
  const out = [];
  for (const f of files) {
    const base = f.split('/').pop();
    const ms = parseInt(base.slice(sessionId.length + 1, -3), 36);
    let text = '';
    try { text = await readFile(f, 'utf8'); } catch { continue; }
    out.push({ savedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null, text });
  }
  out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return out;
}

// Count of pending notes per session (one readdir), for badges.
export async function pendingCounts() {
  const counts = new Map();
  for (const n of await listFiles()) {
    if (!n.endsWith('.md')) continue;
    const m = n.match(/^([0-9a-fA-F-]{36})-/);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

// Mark files delivered (rename .md -> .md.done). Returns the new paths (still
// readable by Claude). Prevents re-injection on the next open.
export async function markDelivered(files) {
  const out = [];
  for (const f of files) {
    const done = `${f}.done`;
    try { await rename(f, done); out.push(done); } catch { out.push(f); }
  }
  return out;
}

// Build a one-line seed instruction pointing Claude at the delivered note files.
export function notesSeedFrom(files) {
  if (!files.length) return null;
  return `Heads up — since you last worked here, related chats saved ${files.length > 1 ? 'updates' : 'an update'}. Read ${files.length > 1 ? 'these files' : 'this file'} and factor ${files.length > 1 ? 'them' : 'it'} in: ${files.join(' ')}`;
}

// Consume all pending notes for a session: mark delivered + return the seed line.
export async function consumeNotesSeed(sessionId) {
  const pending = await listPending(sessionId);
  if (!pending.length) return null;
  const delivered = await markDelivered(pending);
  return notesSeedFrom(delivered);
}
