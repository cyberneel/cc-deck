import { readdir, stat, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { findTranscriptFile, isSessionId } from './graph.js';

// App-owned artifact locations.
const HANDOFF_DIR = join(homedir(), '.claude', 'cc-deck', 'handoffs');
const CACHE_DIR = process.env.CCDECK_CACHE_DIR || join(homedir(), '.cache', 'cc-deck');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;

async function listFiles(dir) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const f = join(dir, name);
    const s = await stat(f).catch(() => null);
    if (s && s.isFile()) out.push({ name, sizeKb: Math.round(s.size / 1024), mtime: s.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// All Claude transcripts on disk, grouped by project directory — including ones
// the History tab hides (e.g. CCDECK_EXCLUDE_DIRS), so the hub can purge junk
// like headless /tmp runs. cwd label is a best-effort decode of the dir name
// (lossy for names containing '-'), but deletion keys off the exact sessionId.
async function listTranscripts() {
  let dirs;
  try { dirs = await readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return []; }
  const groups = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, d.name);
    let names;
    try { names = await readdir(dir); } catch { continue; }
    const items = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -6);
      if (!SESSION_ID_RE.test(id)) continue;
      const s = await stat(join(dir, name)).catch(() => null);
      if (s && s.isFile()) items.push({ sessionId: id, sizeKb: Math.round(s.size / 1024), mtime: s.mtimeMs });
    }
    if (!items.length) continue;
    items.sort((a, b) => b.mtime - a.mtime);
    groups.push({
      encoded: d.name,
      cwd: '/' + d.name.replace(/^-/, '').replace(/-/g, '/'),
      count: items.length,
      sizeKb: items.reduce((n, x) => n + x.sizeKb, 0),
      items,
    });
  }
  groups.sort((a, b) => b.sizeKb - a.sizeKb);
  return groups;
}

// Everything the hub manages: cc-deck's own artifacts (handoffs, caches) plus all
// Claude transcripts grouped by directory.
export async function listArtifacts() {
  const [handoffs, caches, transcripts] = await Promise.all([
    listFiles(HANDOFF_DIR), listFiles(CACHE_DIR), listTranscripts(),
  ]);
  const sum = (a) => a.reduce((n, x) => n + x.sizeKb, 0);
  const tKb = transcripts.reduce((n, g) => n + g.sizeKb, 0);
  const tCount = transcripts.reduce((n, g) => n + g.count, 0);
  return {
    handoffs, caches, transcripts,
    dirs: { handoffs: HANDOFF_DIR, caches: CACHE_DIR },
    totals: { handoffsKb: sum(handoffs), cachesKb: sum(caches), transcriptsKb: tKb, transcriptCount: tCount },
  };
}

// Delete a single basename within a fixed dir (no path traversal).
async function unlinkIn(dir, name, result) {
  const base = basename(name || '');
  if (!base || base !== name) { result.errors.push(`${name}: invalid name`); return; }
  const f = join(dir, base);
  try {
    const s = await stat(f);
    await unlink(f);
    result.deleted += 1; result.freedKb += Math.round(s.size / 1024);
  } catch (e) { result.errors.push(`${name}: ${e.code || e.message}`); }
}

// Selectively delete chosen artifacts. `protectedIds` = session ids that are
// currently running (their transcripts are refused to avoid corrupting a live
// session). Everything is explicit/opt-in — nothing is deleted that wasn't named.
export async function deleteArtifacts({ handoffs = [], caches = [], transcripts = [] }, protectedIds = new Set()) {
  const result = { deleted: 0, freedKb: 0, errors: [] };
  for (const n of handoffs) await unlinkIn(HANDOFF_DIR, n, result);
  for (const n of caches) await unlinkIn(CACHE_DIR, n, result);
  for (const id of transcripts) {
    if (!isSessionId(id)) { result.errors.push(`${id}: invalid id`); continue; }
    if (protectedIds.has(id)) { result.errors.push(`${id}: session is running`); continue; }
    const f = await findTranscriptFile(id);
    if (!f) { result.errors.push(`${id}: not found`); continue; }
    try {
      const s = await stat(f);
      await unlink(f);
      result.deleted += 1; result.freedKb += Math.round(s.size / 1024);
    } catch (e) { result.errors.push(`${id}: ${e.code || e.message}`); }
  }
  return result;
}
