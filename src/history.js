import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;
const MAX_RESULTS = 80;

export function isSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

// Pull cwd + a human title (first real user prompt) from a session transcript,
// reading only the head of the file so this stays fast across many sessions.
async function extractMeta(file) {
  return new Promise((resolve) => {
    let cwd = '';
    let title = '';
    let gitBranch = '';
    let lines = 0;
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    const done = () => {
      rl.close();
      resolve({ cwd, title, gitBranch });
    };
    rl.on('line', (line) => {
      if (!line) return;
      if (++lines > 400) return done(); // head only
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
      if (!title && o.type === 'user' && o.isSidechain !== true && o.message) {
        const text = contentToText(o.message.content);
        if (text && !isNoise(text)) title = text.replace(/\s+/g, ' ').trim().slice(0, 140);
      }
      if (cwd && title) done();
    });
    rl.on('close', () => resolve({ cwd, title, gitBranch }));
    rl.on('error', () => resolve({ cwd, title, gitBranch }));
  });
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
  }
  return '';
}

// Skip slash-command wrappers, tool results, and the system caveat preamble.
function isNoise(text) {
  return (
    /^\s*<(command-name|command-message|local-command|user-memory)/.test(text) ||
    /^\s*Caveat: The messages below/.test(text) ||
    /^\s*\[Request interrupted/.test(text) ||
    text.trim().length === 0
  );
}

export async function listHistory() {
  let projectDirs;
  try {
    projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { sessions: [], truncated: false };
  }

  const files = [];
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, d.name);
    let entries;
    try { entries = await readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -6);
      if (!isSessionId(id)) continue;
      const full = join(dir, name);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.size < 200) continue; // skip empty/aborted sessions
      files.push({ id, file: full, mtime: s.mtimeMs, size: s.size });
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const truncated = files.length > MAX_RESULTS;
  const top = files.slice(0, MAX_RESULTS);

  const sessions = await Promise.all(
    top.map(async (f) => {
      const meta = await extractMeta(f.file);
      return {
        sessionId: f.id,
        cwd: meta.cwd || '',
        gitBranch: meta.gitBranch || '',
        title: meta.title || '(no prompt text)',
        lastModified: f.mtime,
        sizeKb: Math.round(f.size / 1024),
      };
    }),
  );

  return { sessions, truncated, total: files.length };
}
