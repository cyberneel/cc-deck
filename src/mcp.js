// cc-deck MCP server: exposes your past Claude session transcripts as tools so
// another Claude (claude.ai web/mobile, Claude Code, etc.) can search them and
// pull relevant context. Reuses the transcript machinery from graph/handoff/history.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildGraph, buildThread, isSessionId } from './graph.js';
import { listHistory } from './history.js';
import { summarize } from './handoff.js';
import { addNote } from './notes.js';
import { createSession, sendText, listSessions } from './tmux.js';
import { getAgents, matchAgents } from './agents.js';

// Find a RUNNING session by any id in its lineage (live id or resumedFrom).
async function findLiveSession(id) {
  const sessions = await listSessions();
  try { matchAgents(sessions, await getAgents()); } catch { /* */ }
  return sessions.find((s) => s.liveSessionId === id || s.resumedFrom === id);
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const READ_CAP = 1_000_000; // bytes read per transcript when searching

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
  const results = [];
  for (const f of files) {
    if (results.length >= limit) break;
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
  if (!head) return `Session ${sessionId} has no conversation content.`;
  const { messages } = await buildThread(sessionId, head.id);
  const header = `# ${g.title}\n_dir: ${g.cwd || '?'}${g.gitBranch ? ' · branch: ' + g.gitBranch : ''} · ${messages.length} messages_\n\n`;
  if (format === 'summary') {
    const src = redact(messages.map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text}`).join('\n\n').slice(0, 120_000));
    return header + redact(await summarize(src));
  }
  const body = redact(messages.map((m) => `## ${m.role === 'user' ? 'User' : 'Claude'}\n${m.text}`).join('\n\n'));
  const capped = body.length > maxChars ? body.slice(0, maxChars) + '\n\n…[truncated; ask for format:"summary" for the whole thing]' : body;
  return header + capped;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });

export function createMcpServer({ sessionControl = false } = {}) {
  const server = new McpServer({ name: 'cc-deck', version: '1.0.0' });

  server.registerTool('search_sessions', {
    title: 'Search past cc-deck sessions',
    description: "Search the user's past Claude Code (cc-deck) session transcripts by keyword to find sessions relevant to the current question. Returns matching sessions with a snippet and a sessionId you can pass to get_session_context.",
    inputSchema: {
      query: z.string().min(1).max(200).describe('Keywords to search for across session transcripts (e.g. "logsync annotations", "proto field ids").'),
      limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8).'),
    },
  }, async ({ query, limit }) => {
    const r = await searchSessions(query, limit || 8);
    if (!r.length) return text(`No sessions matched "${query}".`);
    return text(r.map((s, i) =>
      `${i + 1}. ${s.title}\n   sessionId: ${s.sessionId}\n   dir: ${s.cwd || '?'}${s.gitBranch ? ' · ' + s.gitBranch : ''} · ${s.lastModified.slice(0, 10)}\n   …${s.snippet}…`).join('\n\n'));
  });

  server.registerTool('list_recent_sessions', {
    title: 'List recent cc-deck sessions',
    description: "List the user's most recent Claude Code (cc-deck) sessions (title, directory, date). Use to see what they've been working on lately.",
    inputSchema: { limit: z.number().int().min(1).max(40).optional().describe('How many (default 15).') },
  }, async ({ limit }) => {
    const { sessions } = await listHistory();
    const top = sessions.slice(0, limit || 15);
    if (!top.length) return text('No past sessions found.');
    return text(top.map((s, i) =>
      `${i + 1}. ${redact(s.title)}\n   sessionId: ${s.sessionId}\n   dir: ${s.cwd || '?'}${s.gitBranch ? ' · ' + s.gitBranch : ''} · ${new Date(s.lastModified).toISOString().slice(0, 10)}`).join('\n\n'));
  });

  server.registerTool('get_session_context', {
    title: 'Get context from a cc-deck session',
    description: "Fetch the content of a specific past session so you can use it as context. format 'summary' returns a concise AI briefing (goal, decisions, current state, files, next steps); format 'transcript' returns the raw conversation (truncated).",
    inputSchema: {
      session_id: z.string().describe('The sessionId from search_sessions / list_recent_sessions.'),
      format: z.enum(['summary', 'transcript']).optional().describe("'summary' (default) or 'transcript'."),
      max_chars: z.number().int().min(2000).max(120000).optional().describe('For transcript format, cap on characters (default 40000).'),
    },
  }, async ({ session_id, format, max_chars }) => {
    if (!isSessionId(session_id)) return text('Invalid session_id.');
    try { return text(await getContext(session_id, format || 'summary', max_chars || 40000)); }
    catch (e) { return text(`Could not load session: ${e.message}`); }
  });

  server.registerTool('save_session_summary', {
    title: 'Save a summary back to a cc-deck session',
    description:
      "Save a concise summary of THIS conversation's outcomes back into a specific cc-deck (Claude Code) session, so that session becomes aware of what happened here the next time the user opens or resumes it. " +
      'IMPORTANT: Only call this AFTER explicitly asking the user whether they want a summary saved back to that session, and confirming which session_id it should attach to (from a prior search_sessions / get_session_context result). ' +
      'The summary should capture decisions made, conclusions reached, and any action items relevant to that session\'s work.',
    inputSchema: {
      session_id: z.string().describe('The cc-deck sessionId this summary should attach to (from search_sessions / get_session_context).'),
      summary: z.string().min(1).max(8000).describe('A concise summary of the outcomes/decisions/action-items from this conversation, written for the other session to pick up.'),
    },
  }, async ({ session_id, summary }) => {
    if (!isSessionId(session_id)) return text('Invalid session_id.');
    try { await addNote(session_id, summary); }
    catch (e) { return text(`Could not save: ${e.message}`); }
    return text('Saved. This summary will surface in that cc-deck session the next time the user opens or resumes it.');
  });

  // Session-control tools (spawn/drive real claude processes) — only exposed to
  // the static-bearer caller (Friday / Claude Code), never OAuth connectors.
  if (sessionControl) {
    server.registerTool('create_session', {
      title: 'Start a cc-deck coding session',
      description: 'Launch a new cc-deck (Claude Code) session in a repo directory, seeded with a task/context prompt that is typed into Claude once it boots. Use to spin up work on a task.',
      inputSchema: {
        dir: z.string().describe('Absolute path to the repo/working directory (must be under an allowed root).'),
        prompt: z.string().min(1).describe('The task + context to type into Claude after it boots.'),
        title: z.string().optional().describe('Short session title; defaults to the folder name.'),
      },
    }, async ({ dir, prompt, title }) => {
      try {
        const name = await createSession({ dir, title, seed: prompt });
        return text(redact(`Started session ${name} in ${dir}. It's booting; its Claude sessionId will appear shortly via list_recent_sessions.`));
      } catch (e) { return text(`Could not start session: ${e.message}`); }
    });

    server.registerTool('send_to_session', {
      title: 'Send input to a running cc-deck session',
      description: 'Type a line into an already-running cc-deck session (a live nudge, submitted with Enter). The session must be active — resume it in cc-deck first if not.',
      inputSchema: {
        session_id: z.string().describe('A Claude session id (as used by list_recent_sessions / get_session_context).'),
        text: z.string().min(1).describe('The text to send; it is submitted with Enter.'),
      },
    }, async ({ session_id, text: line }) => {
      if (!isSessionId(session_id)) return text('Invalid session_id.');
      const s = await findLiveSession(session_id);
      if (!s) return text('Session not active — resume it in cc-deck first.');
      try { await sendText(s.name, line); return text(redact(`Sent to "${s.title || s.name}".`)); }
      catch (e) { return text(`Could not send: ${e.message}`); }
    });
  }

  return server;
}
