import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;

export function isSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

// Locate a transcript file by sessionId across all project dirs (filename is the
// session UUID, so the match is unique). Optionally biased by a known cwd.
export async function findTranscriptFile(sessionId, cwd) {
  if (cwd) {
    const guess = join(PROJECTS_DIR, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`);
    try { await readFile(guess, { encoding: 'utf8', flag: 'r' }); return guess; } catch { /* fall through */ }
  }
  let dirs;
  try { dirs = await readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names;
    try { names = await readdir(join(PROJECTS_DIR, d.name)); } catch { continue; }
    if (names.includes(`${sessionId}.jsonl`)) return join(PROJECTS_DIR, d.name, `${sessionId}.jsonl`);
  }
  return null;
}

async function parseEntries(file) {
  const raw = await readFile(file, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && o.uuid) entries.push(o);
  }
  return entries;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n');
  }
  return '';
}
function toolNames(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p && p.type === 'tool_use' && p.name).map((p) => p.name);
}
function isNoise(text) {
  return (
    /^\s*<(command-name|command-message|local-command|user-memory|system-reminder|bash-input|bash-stdout|bash-stderr)/.test(text) ||
    /^\s*Caveat: The messages below/.test(text) ||
    /^\s*\[Request interrupted/.test(text) ||
    text.trim().length === 0
  );
}

// A "display" node is a real user prompt or an assistant message with prose —
// the things worth showing as points on the graph. Tool calls/results and
// metadata lines are collapsed into edges (their cost is attributed to the
// nearest displayed message).
function isDisplay(e) {
  if (!e || e.isSidechain) return false;
  if (e.type === 'user') { const t = contentToText(e.message?.content); return !!t && !isNoise(t); }
  if (e.type === 'assistant') { return contentToText(e.message?.content).trim().length > 0; }
  return false;
}

function usageOf(e) {
  const u = e.message?.usage;
  if (!u) return null;
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cache: (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
  };
}

// Title for the header: latest custom title, else ai-title, else first prompt.
function deriveTitle(entries) {
  let custom = null, ai = null, first = '';
  for (const e of entries) {
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
    else if (e.type === 'ai-title' && e.aiTitle) ai = e.aiTitle;
    if (!first && e.type === 'user' && !e.isSidechain) {
      const t = contentToText(e.message?.content);
      if (t && !isNoise(t)) first = t.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return custom || ai || first || '(untitled session)';
}

export async function buildGraph(sessionId, cwd) {
  if (!isSessionId(sessionId)) { const e = new Error('Invalid session id'); e.statusCode = 400; throw e; }
  const file = await findTranscriptFile(sessionId, cwd);
  if (!file) { const e = new Error('Transcript not found'); e.statusCode = 404; throw e; }
  const entries = await parseEntries(file);
  const byUuid = new Map(entries.map((e) => [e.uuid, e]));

  // Nearest display ancestor-or-self, walking up parentUuid.
  const ownerCache = new Map();
  function ownerOf(uuid) {
    if (ownerCache.has(uuid)) return ownerCache.get(uuid);
    let cur = byUuid.get(uuid), owner = null;
    while (cur) {
      if (isDisplay(cur)) { owner = cur.uuid; break; }
      cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
    }
    ownerCache.set(uuid, owner);
    return owner;
  }

  // Display nodes keyed by uuid, with aggregated tokens/tools/subagents.
  const nodes = new Map();
  for (const e of entries) {
    if (!isDisplay(e)) continue;
    nodes.set(e.uuid, {
      id: e.uuid,
      role: e.type,
      ts: e.timestamp || null,
      text: contentToText(e.message?.content).replace(/\s+/g, ' ').trim().slice(0, 200),
      tokens: { in: 0, out: 0, cache: 0 },
      tools: {},
      sub: 0,
      parent: null,
    });
  }
  // Display-parent links (collapsing tool/meta chains).
  function displayParent(e) {
    let p = e.parentUuid ? byUuid.get(e.parentUuid) : null;
    while (p) { if (isDisplay(p)) return p.uuid; p = p.parentUuid ? byUuid.get(p.parentUuid) : null; }
    return null;
  }
  for (const e of entries) {
    if (!isDisplay(e)) continue;
    nodes.get(e.uuid).parent = displayParent(e);
  }
  // Attribute every entry's cost/tools/subagents to its nearest displayed node.
  for (const e of entries) {
    const owner = ownerOf(e.uuid);
    if (!owner || !nodes.has(owner)) continue;
    const n = nodes.get(owner);
    const u = usageOf(e);
    if (u) { n.tokens.in += u.in; n.tokens.out += u.out; n.tokens.cache += u.cache; }
    for (const t of toolNames(e.message?.content)) n.tools[t] = (n.tools[t] || 0) + 1;
    if (e.isSidechain) n.sub += 1;
  }

  // children index
  const children = new Map();
  for (const n of nodes.values()) {
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n.id);
  }

  // The "current" head = owner of the chronologically last entry.
  let last = null;
  for (const e of entries) if (e.timestamp && (!last || e.timestamp > last.timestamp)) last = e;
  let currentId = last ? ownerOf(last.uuid) : null;

  // Main path = current head up to its root.
  const mainSet = new Set();
  for (let id = currentId; id && nodes.has(id); id = nodes.get(id).parent) mainSet.add(id);

  // Layout: git-log style. Row = pre-order visitation; main-path child first so
  // the trunk stays in column 0 and rewind/edit branches splay to the right.
  let row = 0, lane = 0;
  const tsOf = (id) => nodes.get(id).ts || '';
  const sortedKids = (id) => (children.get(id) || []).slice().sort((a, b) => {
    const am = mainSet.has(a), bm = mainSet.has(b);
    if (am !== bm) return am ? -1 : 1;       // main-path child first
    return tsOf(a) < tsOf(b) ? -1 : 1;        // then chronological
  });
  const visit = (id, col) => {
    const n = nodes.get(id);
    n.row = row++; n.col = col;
    const kids = sortedKids(id);
    kids.forEach((k, i) => visit(k, i === 0 ? col : ++lane));
  };
  const roots = (children.get(null) || []).slice().sort((a, b) => (tsOf(a) < tsOf(b) ? -1 : 1));
  roots.forEach((r, i) => visit(r, i === 0 ? 0 : ++lane));

  // Branch points (a displayed node with >1 displayed child) for the summary.
  let branchPoints = 0;
  for (const kids of children.values()) if (kids.length > 1) branchPoints += 1;

  const out = [...nodes.values()].sort((a, b) => a.row - b.row).map((n) => ({
    id: n.id,
    parent: n.parent,
    role: n.role,
    ts: n.ts,
    text: n.text,
    tokens: n.tokens,
    tools: Object.entries(n.tools).map(([name, count]) => ({ name, count })),
    sub: n.sub,
    row: n.row,
    col: n.col,
    main: mainSet.has(n.id),
    leaf: !(children.get(n.id) || []).length,
    current: n.id === currentId,
  }));

  const totalTokens = out.reduce((s, n) => s + n.tokens.in + n.tokens.out + n.tokens.cache, 0);
  return {
    sessionId,
    title: deriveTitle(entries),
    cwd: entries.find((e) => e.cwd)?.cwd || '',
    gitBranch: entries.find((e) => e.gitBranch)?.gitBranch || '',
    nodes: out,
    maxCol: lane,
    stats: { messages: out.length, branchPoints, totalTokens },
  };
}

// Full conversation (with complete message text) along the path from the root to
// `uuid` — i.e., the thread that produced that point. For the detail panel.
export async function buildThread(sessionId, uuid, cwd) {
  if (!isSessionId(sessionId)) { const e = new Error('Invalid session id'); e.statusCode = 400; throw e; }
  const file = await findTranscriptFile(sessionId, cwd);
  if (!file) { const e = new Error('Transcript not found'); e.statusCode = 404; throw e; }
  const entries = await parseEntries(file);
  const byUuid = new Map(entries.map((e) => [e.uuid, e]));
  const path = [];
  for (let cur = byUuid.get(uuid); cur; cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null) {
    if (isDisplay(cur)) {
      path.push({
        id: cur.uuid,
        role: cur.type,
        ts: cur.timestamp || null,
        text: contentToText(cur.message?.content),
        tools: toolNames(cur.message?.content),
      });
    }
  }
  path.reverse();
  return { sessionId, uuid, messages: path };
}
