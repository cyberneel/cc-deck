import { createReadStream } from 'node:fs';
import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;
const MAX_RESULTS = 80;

export function isSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

// Claude records its session name as `custom-title` (set via /rename) and an
// auto-generated `ai-title` (a short description) in the transcript. The latest
// of these is the right display name. They live near the end of the file, so we
// read just the tail rather than the whole (possibly huge) transcript.
async function readTailTitles(file, size, bytes = 49152) {
  let text = '';
  try {
    const fh = await open(file, 'r');
    try {
      const start = Math.max(0, size - bytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return {};
  }
  let customTitle = null;
  let aiTitle = null;
  for (const line of text.split('\n')) {
    if (line.includes('"customTitle"')) {
      try { const v = JSON.parse(line).customTitle; if (v) customTitle = v; } catch { /* partial line */ }
    } else if (line.includes('"aiTitle"')) {
      try { const v = JSON.parse(line).aiTitle; if (v) aiTitle = v; } catch { /* */ }
    }
  }
  return { customTitle, aiTitle };
}

// Read cwd, git branch, first user prompt, and any title lines from the head.
function readHead(file) {
  return new Promise((resolve) => {
    let cwd = '', gitBranch = '', firstPrompt = '', customTitle = null, aiTitle = null, lines = 0;
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    const finish = () => { rl.close(); resolve({ cwd, gitBranch, firstPrompt, customTitle, aiTitle }); };
    rl.on('line', (line) => {
      if (!line) return;
      if (++lines > 400) return finish(); // head only, but scan all 400 (titles appear early)
      let o; try { o = JSON.parse(line); } catch { return; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
      if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
      else if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
      if (!firstPrompt && o.type === 'user' && o.isSidechain !== true && o.message) {
        const text = contentToText(o.message.content);
        if (text && !isNoise(text)) firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 140);
      }
    });
    rl.on('close', () => resolve({ cwd, gitBranch, firstPrompt, customTitle, aiTitle }));
    rl.on('error', () => resolve({ cwd, gitBranch, firstPrompt, customTitle, aiTitle }));
  });
}

const metaCache = new Map(); // file -> { key, meta }

async function extractMeta(file, size) {
  const [head, tail] = await Promise.all([readHead(file), readTailTitles(file, size)]);
  // Prefer the latest title (tail) over an early one (head); custom over ai.
  const name =
    tail.customTitle || head.customTitle || tail.aiTitle || head.aiTitle || head.firstPrompt || '';
  return { cwd: head.cwd, gitBranch: head.gitBranch, title: name };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
  }
  return '';
}

function isNoise(text) {
  return (
    /^\s*<(command-name|command-message|local-command|user-memory)/.test(text) ||
    /^\s*Caveat: The messages below/.test(text) ||
    /^\s*\[Request interrupted/.test(text) ||
    text.trim().length === 0
  );
}

// Live display name for an active session: latest custom/ai title from its
// transcript (path derived from cwd + id). Cached by mtime so polling is cheap.
const liveTitleCache = new Map();
export async function claudeTitleFor(cwd, sessionId) {
  if (!cwd || !isSessionId(sessionId)) return null;
  const file = join(PROJECTS_DIR, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`);
  let s;
  try { s = await stat(file); } catch { return null; }
  const key = `${s.mtimeMs}:${s.size}`;
  const cached = liveTitleCache.get(file);
  if (cached && cached.key === key) return cached.title;
  const { customTitle, aiTitle } = await readTailTitles(file, s.size);
  const title = customTitle || aiTitle || null;
  liveTitleCache.set(file, { key, title });
  return title;
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
      if (s.size < 200) continue;
      files.push({ id, file: full, mtime: s.mtimeMs, size: s.size });
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const truncated = files.length > MAX_RESULTS;
  const top = files.slice(0, MAX_RESULTS);

  const sessions = await Promise.all(
    top.map(async (f) => {
      const key = `${f.mtime}:${f.size}`;
      let meta = metaCache.get(f.file);
      if (!meta || meta.key !== key) {
        meta = { key, ...(await extractMeta(f.file, f.size)) };
        metaCache.set(f.file, meta);
      }
      return {
        sessionId: f.id,
        cwd: meta.cwd || '',
        gitBranch: meta.gitBranch || '',
        title: meta.title || '(untitled session)',
        lastModified: f.mtime,
        sizeKb: Math.round(f.size / 1024),
      };
    }),
  );

  return { sessions, truncated, total: files.length };
}
