// Deep Sessions MCP server: exposes your past Deep Session transcripts as tools so
// another Claude (claude.ai web/mobile, Claude Code, etc.) can search them and
// pull relevant context. Reuses the transcript machinery from graph/handoff/history.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, readFile, stat, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { buildGraph, buildThread, isSessionId } from './graph.js';
import { listHistory } from './history.js';
import { summarize } from './handoff.js';
import { addNote } from './notes.js';
import { createSession, sendText, listSessions } from './tmux.js';
import { getAgents, matchAgents } from './agents.js';
import { listTabs, claimTab, releaseTab } from './browser.js';
import { proactiveSet } from './origin.js';

const exec = promisify(execFile);

// Callers (Friday, other agents) naturally refer to a session by the human TITLE
// they see, not its UUID — so these tools accept either. Resolve leniently: a valid
// id passes through; otherwise match a session TITLE (unique, case-insensitive:
// exact first, else a unique substring). Ambiguous/no match returns null so the
// caller gets one actionable error instead of looping on a hard reject.

// RUNNING sessions with live status attached (best-effort).
async function liveSessions() {
  const sessions = await listSessions().catch(() => []);
  try { matchAgents(sessions, await getAgents()); } catch { /* */ }
  return sessions;
}
// Unique title match in `arr`, or null if zero / more than one.
function pickByTitle(arr, getTitle, q) {
  const lc = String(q || '').trim().toLowerCase();
  if (!lc) return null;
  const exact = arr.filter((x) => (getTitle(x) || '').toLowerCase() === lc);
  const cands = exact.length ? exact : arr.filter((x) => (getTitle(x) || '').toLowerCase().includes(lc));
  return cands.length === 1 ? cands[0] : null;
}
// "title=id" list of running sessions — for actionable error messages.
function liveHint(sessions) {
  return sessions.length ? sessions.map((s) => `"${s.title || s.name}"=${s.liveSessionId || s.resumedFrom || '(no id)'}`).join(', ') : 'none running';
}
// Resolve an id-or-title to a transcript session id (LIVE sessions first, then
// history). Used by the read/note tools, which operate on transcripts (live or past).
async function resolveTranscriptId(arg) {
  const val = String(arg || '').trim();
  if (isSessionId(val)) return val;
  const live = pickByTitle(await liveSessions(), (x) => x.title, val);
  if (live && (live.liveSessionId || live.resumedFrom)) return live.liveSessionId || live.resumedFrom;
  const hist = (await listHistory().catch(() => ({ sessions: [] }))).sessions || [];
  const h = pickByTitle(hist, (x) => x.title, val);
  return h ? h.sessionId : null;
}

// Resolve an id-or-title to the session's working directory: the cwd recorded in
// its transcript (works for live + past), falling back to a live session's tmux
// dir (for a just-booted session with no transcript yet). Absolute, or null.
async function resolveSessionCwd(arg) {
  const id = await resolveTranscriptId(arg);
  if (id) { try { const g = await buildGraph(id); if (g.cwd) return resolve(g.cwd); } catch { /* */ } }
  const sessions = await liveSessions();
  const val = String(arg || '').trim();
  const s = isSessionId(val)
    ? sessions.find((x) => x.liveSessionId === val || x.resumedFrom === val)
    : pickByTitle(sessions, (x) => x.title, val);
  return s && s.dir ? resolve(s.dir) : null;
}

// Files changed/created in the last 24h under `cwd` (deliverable-hunting for a
// non-git dir; git dirs use `git status` instead). ponytail: shell `find`, not a
// hand-rolled walk — it's on the box and does the prune + mtime filter in one call.
async function recentFiles(cwd) {
  try {
    const { stdout } = await exec('find', [cwd, '-type', 'f', '-mmin', '-1440',
      '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/target/*', '-not', '-path', '*/dist/*'],
      { timeout: 8000, maxBuffer: 1 << 20 });
    return stdout.split('\n').filter(Boolean)
      .map((p) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)).slice(0, 40);
  } catch { return []; }
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const READ_CAP = 1_000_000; // bytes read per transcript when searching
// Any provider's resume-id shape (Claude/Codex UUID, agy id) — used so a note can
// be keyed to a Codex/agy session by its raw conversation id, not just a title.
const ANY_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

// Best-effort scrub of likely secrets before transcript text leaves the server.
export function redact(s) {
  if (!s) return s;
  return String(s)
    .replace(/-----BEGIN[\s\S]{0,80}?PRIVATE KEY-----[\s\S]*?-----END[\s\S]{0,80}?-----/g, '[REDACTED KEY BLOCK]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]')
    // KEY=VALUE where the key name looks secret
    .replace(/\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_]*)(\s*[:=]\s*)["']?[^\s"']{6,}/gi, '$1$2[REDACTED]')
    // long hex blobs (hashes/keys)
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n');
  return '';
}
function isNoise(t) {
  return /^\s*<(command-name|command-message|local-command|user-memory|system-reminder|bash-input|bash-stdout|bash-stderr)/.test(t) ||
    /^\s*Caveat: The messages below/.test(t) || /^\s*\[Request interrupted/.test(t) || !t.trim();
}

// Parse a transcript's readable text + metadata from raw JSONL text.
function parseTranscript(text) {
  let cwd = '', gitBranch = '', custom = null, ai = null, first = '';
  const chunks = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
    if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
    else if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
    else if (o.customTitle) custom = o.customTitle;
    else if (o.aiTitle) ai = o.aiTitle;
    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain && o.message) {
      const t = contentText(o.message.content);
      if (t && !isNoise(t)) { chunks.push(t); if (!first && o.type === 'user') first = t.replace(/\s+/g, ' ').trim().slice(0, 120); }
    }
  }
  return { cwd, gitBranch, title: custom || ai || first || '(untitled session)', body: chunks.join('\n') };
}

async function allTranscripts() {
  const out = [];
  let dirs;
  try { dirs = await readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names; try { names = await readdir(join(PROJECTS_DIR, d.name)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      if (!isSessionId(id)) continue;
      const file = join(PROJECTS_DIR, d.name, n);
      const s = await stat(file).catch(() => null);
      if (s && s.isFile() && s.size >= 200) out.push({ id, file, mtime: s.mtimeMs, size: s.size });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function searchSessions(query, limit) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const files = await allTranscripts();
  const hidden = await proactiveSet(); // Friday-made sessions don't clutter the user's search
  const results = [];
  for (const f of files) {
    if (results.length >= limit) break;
    if (hidden.has(f.id)) continue;
    let text;
    try { text = (await readFile(f.file, 'utf8')).slice(0, READ_CAP); } catch { continue; }
    if (!words.every((w) => text.toLowerCase().includes(w))) continue; // cheap pre-filter
    const meta = parseTranscript(text);
    const hay = meta.body.toLowerCase();
    const idx = hay.indexOf(words[0]);
    if (idx === -1 && !words.every((w) => meta.title.toLowerCase().includes(w))) continue; // matched only in JSON noise
    const at = idx === -1 ? 0 : idx;
    const snippet = redact(meta.body.slice(Math.max(0, at - 140), at + 220).replace(/\s+/g, ' ').trim());
    results.push({
      sessionId: f.id, title: redact(meta.title), cwd: meta.cwd, gitBranch: meta.gitBranch,
      lastModified: new Date(f.mtime).toISOString(), snippet,
    });
  }
  return results;
}

async function getContext(sessionId, format, maxChars) {
  const g = await buildGraph(sessionId); // throws 404 if not found
  const head = g.nodes.find((n) => n.current) || g.nodes[g.nodes.length - 1];
  if (!head) return `Deep Session ${sessionId} has no conversation content.`;
  const { messages } = await buildThread(sessionId, head.id);
  // The deck title ("lhrdash → lhre-2027 prod migration") is the name the user knows; the
  // transcript's own title is often just the first prompt. Folder = what a voice can say.
  const live = (await liveSessions()).find((x) => x.liveSessionId === sessionId || x.resumedFrom === sessionId);
  const folder = g.cwd ? basename(g.cwd) : '';
  const header = `# ${redact((live && live.title) || g.title)}\n_folder: ${folder || '?'} (${g.cwd || '?'})${g.gitBranch ? ' · branch: ' + g.gitBranch : ''} · ${messages.length} messages_\n\n`;
  if (format === 'summary') {
    const src = redact(messages.map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text}`).join('\n\n').slice(0, 120_000));
    return header + redact(await summarize(src));
  }
  const body = redact(messages.map((m) => `## ${m.role === 'user' ? 'User' : 'Claude'}\n${m.text}`).join('\n\n'));
  // Keep the END, not the start: the latest messages (the deliverable / current
  // state) are what a caller wants; the old opening is the disposable part. Marker
  // deliberately avoids the word "truncated" so Friday's relay (which falls back to
  // the lossy summary on "[truncated") trusts this intact tail. ponytail: char slice.
  const capped = body.length > maxChars
    ? '…[earlier context omitted — ask for format:"summary" for the whole thing]\n\n' + body.slice(body.length - maxChars)
    : body;
  return header + capped;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });

export function createMcpServer({ sessionControl = false } = {}) {
  const server = new McpServer({ name: 'cc-deck', version: '1.0.0' });

  server.registerTool('search_sessions', {
    title: 'Search past Deep Sessions',
    description: "Search the user's past Deep Session transcripts by keyword to find Deep Sessions relevant to the current question. Returns matching Deep Sessions with a snippet and a sessionId you can pass to get_session_context.",
    inputSchema: {
      query: z.string().min(1).max(200).describe('Keywords to search for across Deep Session transcripts (e.g. "logsync annotations", "proto field ids").'),
      limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8).'),
    },
  }, async ({ query, limit }) => {
    const r = await searchSessions(query, limit || 8);
    if (!r.length) return text(`No Deep Sessions matched "${query}".`);
    return text(r.map((s, i) =>
      `${i + 1}. ${s.title}\n   sessionId: ${s.sessionId}\n   dir: ${s.cwd || '?'}${s.gitBranch ? ' · ' + s.gitBranch : ''} · ${s.lastModified.slice(0, 10)}\n   …${s.snippet}…`).join('\n\n'));
  });

  server.registerTool('list_recent_sessions', {
    title: 'List recent Deep Sessions',
    description: "List the user's most recent Deep Sessions (title, directory, date). Use to see what they've been working on lately.",
    inputSchema: { limit: z.number().int().min(1).max(40).optional().describe('How many (default 15).') },
  }, async ({ limit }) => {
    const { sessions } = await listHistory();
    const hidden = await proactiveSet(); // hide Friday-made sessions from "what have I worked on"
    const top = sessions.filter((s) => !hidden.has(s.sessionId)).slice(0, limit || 15);
    if (!top.length) return text('No past Deep Sessions found.');
    return text(top.map((s, i) =>
      `${i + 1}. ${redact(s.title)}\n   sessionId: ${s.sessionId}\n   dir: ${s.cwd || '?'}${s.gitBranch ? ' · ' + s.gitBranch : ''} · ${new Date(s.lastModified).toISOString().slice(0, 10)}`).join('\n\n'));
  });

  server.registerTool('get_session_context', {
    title: 'Get context from a Deep Session',
    description: "Fetch the content of a specific past Deep Session so you can use it as context. format 'summary' returns a concise AI briefing (goal, decisions, current state, files, next steps); format 'transcript' returns the raw conversation (truncated).",
    inputSchema: {
      session_id: z.string().describe("A sessionId (from search_sessions / list_recent_sessions) OR the Deep Session's title."),
      format: z.enum(['summary', 'transcript']).optional().describe("'summary' (default) or 'transcript'."),
      max_chars: z.number().int().min(2000).max(120000).optional().describe('For transcript format, cap on characters (default 40000).'),
    },
  }, async ({ session_id, format, max_chars }) => {
    const id = await resolveTranscriptId(session_id);
    if (!id) return text(`No Deep Session matches "${session_id}". Pass a sessionId from search_sessions / list_recent_sessions, or an exact Deep Session title.`);
    try { return text(await getContext(id, format || 'summary', max_chars || 40000)); }
    catch (e) { return text(`Could not load Deep Session: ${e.message}`); }
  });

  server.registerTool('save_session_summary', {
    title: 'Save a summary back to a Deep Session',
    description:
      "Save a concise summary of THIS conversation's outcomes back into a specific Deep Session (any CLI — Claude, Codex, or agy), so that Deep Session becomes aware of what happened here the next time the user opens or resumes it. This is the cross-Deep-Session note channel: it reaches a Deep Session even while it is offline. Never target your OWN session — its transcript already records the work. " +
      'IMPORTANT: Only call this AFTER explicitly asking the user whether they want a summary saved back to that Deep Session, and confirming which session_id it should attach to (from a prior search_sessions / get_session_context result). ' +
      'The summary should capture decisions made, conclusions reached, and any action items relevant to that Deep Session\'s work.',
    inputSchema: {
      session_id: z.string().describe('The sessionId this summary attaches to (from search_sessions / get_session_context) — or the Deep Session title.'),
      summary: z.string().min(1).max(8000).describe('A concise summary of the outcomes/decisions/action-items from this conversation, written for the other Deep Session to pick up.'),
    },
  }, async ({ session_id, summary }) => {
    // Resolve id-or-title; if that misses but the arg is itself a valid CLI
    // conversation id (Codex/agy sessions aren't in the Claude transcript index),
    // key the note to it directly so cross-provider notes still land.
    const arg = String(session_id || '').trim();
    const id = (await resolveTranscriptId(arg)) || (ANY_ID_RE.test(arg) ? arg : null);
    if (!id) return text(`No Deep Session matches "${session_id}". Pass a sessionId (from search_sessions / get_session_context / list_sessions) or an exact Deep Session title.`);
    try { await addNote(id, summary); }
    catch (e) { return text(`Could not save: ${e.message}`); }
    return text('Saved. This summary will surface in that Deep Session the next time the user opens or resumes it.');
  });

  server.registerTool('list_sessions', {
    title: 'List active Deep Sessions with live status',
    description:
      "List the user's currently ACTIVE Deep Sessions (Claude Code) with live, structured status — for detecting state transitions (a Deep Session finishing, waiting for the user, or exiting). " +
      'Returns a JSON array; poll and diff the `status`/`needs_input` fields to notice transitions. Each item: ' +
      '{ session_id, name, title, dir, status, needs_input, waiting_for, attached, last_activity }. ' +
      "`status` is one of: running (Claude is working), waiting_input (blocked on the user — a prompt/permission/question), idle (at its prompt, not working), done (Claude exited, the shell remains). " +
      '`name` is stable for the Deep Session\'s lifetime; `session_id` is the live Claude id (changes across resume/fork) or null if Claude isn\'t running.',
    inputSchema: {},
  }, async () => {
    const sessions = await listSessions();
    try { matchAgents(sessions, await getAgents()); } catch { /* claude agents unavailable → status degrades to idle/done */ }
    const out = sessions.map((s) => {
      const claudeAlive = s.paneCommand === 'claude' || !!s.liveSessionId;
      const status = !claudeAlive ? 'done'
        : s.claudeStatus === 'busy' ? 'running'
        : s.waitingFor ? 'waiting_input'
        : 'idle';
      return {
        session_id: s.liveSessionId || s.resumedFrom || null,
        name: s.name,
        title: redact(s.title),
        dir: s.dir,
        status,
        needs_input: status === 'waiting_input',
        waiting_for: s.waitingFor || null,
        attached: s.attached,
        last_activity: s.lastActivity ? new Date(s.lastActivity).toISOString() : null,
      };
    });
    return text(JSON.stringify(out, null, 2));
  });

  // Shared-browser broker: a visible lock registry over the one logged-in browser,
  // so many sessions (and Friday) coordinate instead of fighting over tabs. Read/
  // coordination tools — available to any authed caller (the auto-wired sessions).
  if (config.sessionBrowser) {
    server.registerTool('browser_tabs', {
      title: 'List shared-browser tabs + who has them',
      description: "See every tab in the SHARED logged-in browser and who has claimed it (the visible lock registry). Call this BEFORE touching the browser so you don't disturb tabs other Deep Sessions or Friday rely on. Returns JSON: [{ target_id, title, url, claimed_by, claimed_since }].",
      inputSchema: {},
    }, async () => { try { return text(JSON.stringify(await listTabs(), null, 2)); } catch (e) { return text('Shared browser unavailable: ' + e.message); } });

    server.registerTool('browser_claim', {
      title: 'Claim a shared-browser tab',
      description: "Register a tab you are driving in the SHARED browser so other Deep Sessions/Friday see it's in use. Open your OWN tab first (chrome new_page) and navigate it, then claim it by target_id or url with a short note. Never claim or drive a tab someone else already claimed — open your own instead.",
      inputSchema: {
        note: z.string().min(1).max(200).describe('Short description of what you are using the tab for (shown to other agents).'),
        target_id: z.string().optional().describe('The tab target id (from browser_tabs).'),
        url: z.string().optional().describe('Or identify the tab by the url you navigated it to.'),
      },
    }, async ({ note, target_id, url }) => { try { return text(JSON.stringify(await claimTab({ note, target_id, url }))); } catch (e) { return text('Could not claim: ' + e.message); } });

    server.registerTool('browser_release', {
      title: 'Release a shared-browser tab',
      description: 'Free a tab you previously claimed (call when done, then close it with chrome close_page). Identify by target_id or url.',
      inputSchema: { target_id: z.string().optional(), url: z.string().optional() },
    }, async ({ target_id, url }) => { try { return text(JSON.stringify(await releaseTab({ target_id, url }))); } catch (e) { return text('Could not release: ' + e.message); } });
  }

  // Session-control tools (spawn/drive real claude processes) — only exposed to
  // the static-bearer caller (e.g. Claude Code / a headless agent), never OAuth connectors.
  if (sessionControl) {
    server.registerTool('create_session', {
      title: 'Start a Deep Session',
      description: 'Launch a new Deep Session (Claude Code) in a repo directory, seeded with a task/context prompt that is typed into Claude once it boots. Use to spin up work on a task.',
      inputSchema: {
        dir: z.string().describe('Absolute path to the repo/working directory (must be under an allowed root).'),
        prompt: z.string().min(1).describe('The task + context to type into Claude after it boots.'),
        title: z.string().optional().describe('Short Deep Session title; defaults to the folder name.'),
      },
    }, async ({ dir, prompt, title }) => {
      try {
        // Auto-create the target dir if it's UNDER an allowed root but missing
        // (the common "new project folder" case). Never mkdir outside a root —
        // createSession's resolveAllowedDir still refuses those.
        const abs = resolve(dir);
        if (config.roots.some((r) => abs === r || abs.startsWith(r + '/'))) {
          await mkdir(abs, { recursive: true });
        }
        const name = await createSession({ dir: abs, title, seed: prompt, origin: 'proactive' });
        return text(redact(`Started Deep Session ${name} in ${abs}. It's booting; its Claude sessionId will appear shortly via list_recent_sessions.`));
      } catch (e) { return text(`ERROR: could not start Deep Session — ${e.message}`); }
    });

    // "Start it in my sds folder" — the caller (Friday) runs elsewhere (a microVM on hosted),
    // so only THIS host can say which folders exist here. Searches folder NAMES under the
    // allowed roots; spaces/case/punctuation ignored so "SDS 324E" matches sds324e.
    server.registerTool('find_folders', {
      title: 'Find a folder on this machine',
      description: "Find existing folders on this cc-deck's machine by name (the user's repos, class folders, projects), under its allowed roots. Call this BEFORE create_session to start work in the user's existing folder instead of inventing one. Returns absolute paths on this machine.",
      inputSchema: {
        query: z.string().min(1).describe('Folder name or part of it, e.g. "sds 324e" or "friday". Case, spaces, and punctuation are ignored.'),
      },
    }, async ({ query }) => {
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const q = norm(query);
      if (!q) return text('ERROR: query has no letters or digits.');
      const hits = [];
      for (const root of config.roots) {
        // ponytail: depth 4 + pruned hidden/build dirs (~0.4s on a full home); raise the depth if a folder sits deeper
        const { stdout } = await exec('find', [root, '-maxdepth', '4',
          '(', '-name', '.*', '-o', '-name', 'node_modules', '-o', '-name', 'target', '-o', '-name', '__pycache__', '-o', '-name', 'venv', ')',
          '-prune', '-o', '-type', 'd', '-print'], { timeout: 15000, maxBuffer: 8 << 20 }).catch((e) => ({ stdout: e.stdout || '' }));
        for (const p of stdout.split('\n')) if (p && norm(p.slice(p.lastIndexOf('/') + 1)).includes(q)) hits.push(p);
      }
      // Exact name first, then shallower paths (the project root over its subfolders).
      const exact = (p) => norm(p.slice(p.lastIndexOf('/') + 1)) === q;
      hits.sort((a, b) => exact(b) - exact(a) || a.split('/').length - b.split('/').length);
      if (!hits.length) return text(`No folder matching "${query}" under ${config.roots.join(', ')}. create_session will create a new folder under a root if you pass a new path.`);
      return text(hits.slice(0, 20).join('\n'));
    });

    server.registerTool('send_to_session', {
      title: 'Send input to a running Deep Session',
      description: 'Type a line into an already-running Deep Session (a live nudge, submitted with Enter). The Deep Session must be active — resume it in Deep Sessions first if not.',
      inputSchema: {
        session_id: z.string().describe("A Claude session id OR the Deep Session's title (as shown in Deep Sessions) — the Deep Session must be live."),
        text: z.string().min(1).describe('The text to send; it is submitted with Enter.'),
      },
    }, async ({ session_id, text: line }) => {
      const sessions = await liveSessions();
      const val = String(session_id || '').trim();
      const s = isSessionId(val)
        ? sessions.find((x) => x.liveSessionId === val || x.resumedFrom === val)
        : pickByTitle(sessions, (x) => x.title, val);
      if (!s) return text(`ERROR: no live Deep Session matches "${session_id}". Live now: ${liveHint(sessions)}. Pass one of those ids or an exact title (resume a past Deep Session in Deep Sessions first if it isn't listed).`);
      try { await sendText(s.name, line); return text(redact(`Sent to "${s.title || s.name}".`)); }
      catch (e) { return text(`ERROR: could not send — ${e.message}`); }
    });

    server.registerTool('get_session_files', {
      title: 'List files a Deep Session changed',
      description: "Show the files a Deep Session created/modified in its working directory (git status --short, or recently-modified files for a non-git dir). Use this to find the deliverable a Deep Session produced — a report, doc, or code file — then read_session_file to read it.",
      inputSchema: {
        session_id: z.string().describe("A sessionId (from search_sessions / list_recent_sessions) OR the Deep Session's title."),
      },
    }, async ({ session_id }) => {
      const cwd = await resolveSessionCwd(session_id);
      if (!cwd) return text(`No Deep Session/dir matches "${session_id}". Pass a sessionId or an exact Deep Session title.`);
      const parts = [`dir: ${cwd}`];
      try {
        const { stdout } = await exec('git', ['-C', cwd, 'status', '--short'], { timeout: 8000, maxBuffer: 1 << 20 });
        parts.push(stdout.trim() ? 'changed files (git status --short):\n' + stdout.trimEnd() : '(git repo, working tree clean)');
      } catch {
        const recent = await recentFiles(cwd);
        parts.push(recent.length ? 'recently modified files (last 24h):\n' + recent.join('\n') : '(not a git repo; no files modified in the last 24h)');
      }
      return text(redact(parts.join('\n\n')));
    });

    server.registerTool('read_session_file', {
      title: 'Read a file from a Deep Session directory',
      description: "Read the contents of a file inside a Deep Session's working directory (e.g. a report/doc/code file it produced). The path is confined to the Deep Session's own directory and secrets are redacted. Use get_session_files to discover paths.",
      inputSchema: {
        session_id: z.string().describe("A sessionId OR the Deep Session's title."),
        path: z.string().min(1).describe("File path relative to the Deep Session's working directory (an absolute path inside it also works)."),
      },
    }, async ({ session_id, path }) => {
      const cwd = await resolveSessionCwd(session_id);
      if (!cwd) return text(`No Deep Session/dir matches "${session_id}".`);
      const abs = resolve(cwd, path); // absolute `path` overrides cwd; the guard below re-confines it
      if (abs !== cwd && !abs.startsWith(cwd + '/')) return text(`ERROR: path escapes the Deep Session directory (${cwd}).`);
      try {
        const st = await stat(abs);
        if (!st.isFile()) return text(`ERROR: not a file: ${path}`);
        if (st.size > 512_000) return text(`ERROR: file too large (${st.size} bytes, cap 512KB). Read a smaller file or a specific part.`);
        return text(redact(`# ${path}\n\n` + await readFile(abs, 'utf8')));
      } catch (e) { return text(`Could not read "${path}": ${e.message}`); }
    });
  }

  return server;
}
