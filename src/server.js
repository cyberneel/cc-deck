import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep, basename, relative } from 'node:path';
import { statSync, createWriteStream, createReadStream } from 'node:fs';
import { mkdir, stat, readdir, rm, access } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import { config } from './config.js';
import { checkPassword, issueToken, verifyToken } from './auth.js';
import {
  listSessions,
  createSession,
  killSession,
  renameSession,
  capturePane,
  listDirs,
  createDir,
  sessionDir,
  resolveAllowedDir,
  sendText,
} from './tmux.js';
import { attachHandler } from './pty.js';
import { initServer } from './tmux.js';
import { getAgents, matchAgents } from './agents.js';
import { listHistory, claudeLiveMeta } from './history.js';
import { buildGraph, buildThread } from './graph.js';
import { runHandoff } from './handoff.js';
import { listArtifacts, deleteArtifacts } from './storage.js';
import { createMcpServer } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as oauth from './oauth.js';
import { consumeNotesSeed, consumeNotesSeedMany, pendingCounts, readPending, readPendingMany, countNotes } from './notes.js';

// A session's Claude id lineage: the live id (changes on resume/fork/reboot) plus
// resumedFrom (the stable @ccdeck_resume anchor). Notes are matched across all of it.
const lineageIds = (s) => [s?.liveSessionId, s?.resumedFrom];
import { captureSnapshot, restoreIfBoot, loadSnapshot } from './restore.js';

// Active sessions enriched with each one's live Claude status (busy/idle/waiting),
// Claude's own session name (custom /rename title, else its auto-title), and the
// current permission mode (auto/plan/acceptEdits/default).
async function enrichedSessions() {
  const sessions = await listSessions();
  try {
    matchAgents(sessions, await getAgents());
    const notes = await pendingCounts(); // external-note counts keyed by Claude id
    await Promise.all(sessions.map(async (s) => {
      if (!s.liveSessionId) return;
      const m = await claudeLiveMeta(s.dir, s.liveSessionId);
      if (m.title) s.title = m.title;
      if (m.mode) s.mode = m.mode;
      s.noteCount = countNotes(notes, lineageIds(s));
    }));
  } catch { /* degrade */ }
  return sessions;
}
import { getBurn } from './burn.js';
import { getUsage } from './usage.js';
import { getPricing } from './pricing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

// Tolerate an empty body on requests that declare application/json (e.g. a
// bodyless DELETE/logout) instead of failing with 400 "body cannot be empty".
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body || !body.trim()) return done(null, undefined);
  try {
    done(null, JSON.parse(body));
  } catch (err) {
    err.statusCode = 400;
    done(err);
  }
});
// OAuth token + consent endpoints post form-encoded bodies.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
  try { done(null, Object.fromEntries(new URLSearchParams(body || ''))); }
  catch (err) { err.statusCode = 400; done(err); }
});

await app.register(fastifyCookie);
await app.register(fastifyWebsocket);
await app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024, files: 500 } });
// Serve assets with no-cache so the browser revalidates each load (304 when
// unchanged, fresh when redeployed) — important for iOS home-screen apps that
// otherwise cache the old bundle. ETags still make unchanged loads cheap.
await app.register(fastifyStatic, {
  root: publicDir,
  prefix: '/',
  cacheControl: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
});

// Paths reachable without auth (login assets + PWA manifest/icons the browser
// fetches before login).
const PUBLIC_PATHS = new Set([
  '/login.html', '/login.css', '/api/login', '/favicon.ico', '/sw.js',
  '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png',
  '/mcp', // MCP endpoint does its own bearer/OAuth auth (below)
  // OAuth endpoints for claude.ai connectors — reachable without a cc-deck cookie.
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/mcp',
  '/oauth/register', '/oauth/authorize', '/oauth/token',
]);

function isAuthed(req) {
  const token = req.cookies?.[config.cookieName];
  return verifyToken(token);
}

// Auth gate for every HTTP request except the public allowlist and login assets.
app.addHook('onRequest', async (req, reply) => {
  if (req.raw.url?.startsWith('/ws/')) return; // websockets auth in their own handler
  const path = req.raw.url?.split('?')[0] || '/';
  if (PUBLIC_PATHS.has(path)) return;
  if (isAuthed(req)) return;

  if (path.startsWith('/api/')) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply.redirect('/login.html');
});

// ---- Auth routes ----
app.post('/api/login', async (req, reply) => {
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return reply.code(401).send({ error: 'invalid password' });
  }
  const token = issueToken();
  reply.setCookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https',
    path: '/',
    maxAge: config.cookieMaxAge,
  });
  return { ok: true };
});

app.post('/api/logout', async (req, reply) => {
  reply.clearCookie(config.cookieName, { path: '/' });
  return { ok: true };
});

// ---- Session API ----
app.get('/api/sessions', async () => {
  return { sessions: await enrichedSessions() };
});

app.post('/api/sessions', async (req, reply) => {
  const { dir, title, resume, fork, browser } = req.body || {};
  if (!dir) return reply.code(400).send({ error: 'dir is required' });
  try {
    // Don't launch a duplicate: if the session being resumed is already running,
    // hand back the existing one so the client can just open it. Forking is the
    // exception — it intentionally branches off into a NEW session even when the
    // original is live, so skip the dedup guard.
    if (resume && !fork) {
      const existing = (await enrichedSessions()).find(
        (s) => s.resumedFrom === resume || s.liveSessionId === resume,
      );
      if (existing) return { name: existing.name, alreadyRunning: true };
    }
    // Resuming a session? Seed it with any external notes saved from outside chats
    // so it picks up what happened elsewhere (consumed so it won't re-inject).
    const seed = resume && !fork ? await consumeNotesSeed(resume) : undefined;
    const name = await createSession({ dir, title, resume, fork, seed, browser });
    return { name };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

// Past Claude sessions on disk (resumable via `claude --resume`), excluding any
// that are currently running — those live in the Active tab, so History stays clean.
app.get('/api/history', async () => {
  const hist = await listHistory();
  try {
    const live = new Set();
    for (const s of await enrichedSessions()) {
      if (s.liveSessionId) live.add(s.liveSessionId);
      if (s.resumedFrom) live.add(s.resumedFrom);
    }
    const notes = await pendingCounts();
    const sessions = hist.sessions
      .filter((s) => !live.has(s.sessionId))
      .map((s) => ({ ...s, noteCount: notes.get(s.sessionId) || 0 }));
    const excluded = hist.sessions.length - sessions.length;
    return { ...hist, sessions, total: Math.max(sessions.length, hist.total - excluded) };
  } catch {
    return hist;
  }
});

// Read pending external notes for a session (for the note viewer). If the id
// belongs to a running session's lineage, show notes for the whole lineage (so
// the viewer matches the badge count even after the live id changed on resume).
app.get('/api/notes/:sessionId', async (req, reply) => {
  try {
    const id = req.params.sessionId;
    let s;
    try { s = (await enrichedSessions()).find((x) => lineageIds(x).includes(id)); } catch { /* offline */ }
    return { notes: s ? await readPendingMany(lineageIds(s)) : await readPending(id) };
  } catch (err) { return reply.code(err.statusCode || 500).send({ error: err.message }); }
});

app.delete('/api/sessions/:name', async (req, reply) => {
  try {
    await killSession(req.params.name);
    return { ok: true };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

// Inject any pending external notes into a RUNNING session (live), then consume.
app.post('/api/sessions/:name/apply-notes', async (req, reply) => {
  try {
    const s = (await enrichedSessions()).find((x) => x.name === req.params.name);
    if (!s?.liveSessionId) return reply.code(400).send({ error: 'No live Claude session to apply notes to' });
    const seed = await consumeNotesSeedMany(lineageIds(s));
    if (!seed) return { applied: 0 };
    await sendText(req.params.name, seed);
    return { applied: 1 };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

app.patch('/api/sessions/:name', async (req, reply) => {
  const { title } = req.body || {};
  try {
    await renameSession(req.params.name, title);
    return { ok: true };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

app.get('/api/sessions/:name/preview', async (req, reply) => {
  try {
    const text = await capturePane(req.params.name);
    return { text };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

// ---- Session graph (read-only branch/conversation tree) ----
app.get('/api/transcripts/:id/graph', async (req, reply) => {
  try {
    return await buildGraph(req.params.id, req.query.cwd);
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});
app.get('/api/transcripts/:id/thread', async (req, reply) => {
  try {
    return await buildThread(req.params.id, req.query.uuid, req.query.cwd);
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

// Share context from one session into a new or running session (handoff).
app.post('/api/handoff', async (req, reply) => {
  const b = req.body || {};
  if (!b.sourceId && !(Array.isArray(b.sources) && b.sources.length)) {
    return reply.code(400).send({ error: 'sourceId or sources is required' });
  }
  try {
    return await runHandoff({
      sourceId: b.sourceId, cwd: b.cwd, uuid: b.uuid || null,
      sources: Array.isArray(b.sources) ? b.sources : null, // multi-session seed
      scope: b.scope === 'thread' ? 'thread' : 'summary',
      dest: b.dest === 'running' ? 'running' : 'new',
      targetSession: b.targetSession, targetDir: b.targetDir, title: b.title,
      browser: !!b.browser,
    });
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

// Upload files/folders into a session's working directory. Multipart; each
// part's filename carries its relative path (for folder uploads). Writes are
// confined to the session's cwd (which must be under an allowed root).
function safeRelPath(name) {
  const parts = String(name || '').split('/').filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/');
}
const pathExists = (p) => access(p).then(() => true).catch(() => false);

// Find a non-conflicting path by appending " (1)", " (2)", … before the extension.
async function uniquePath(p) {
  if (!(await pathExists(p))) return p;
  const dir = dirname(p), b = basename(p);
  const dot = b.lastIndexOf('.');
  const stem = dot > 0 ? b.slice(0, dot) : b;
  const ext = dot > 0 ? b.slice(dot) : '';
  for (let i = 1; i < 10000; i++) {
    const cand = join(dir, `${stem} (${i})${ext}`);
    if (!(await pathExists(cand))) return cand;
  }
  return p;
}

// Which of the given relative names already exist under `dir` (overwrite check).
app.post('/api/upload/check', async (req, reply) => {
  let baseDir;
  try { baseDir = await resolveAllowedDir(req.query.dir); } catch (err) { return reply.code(err.statusCode || 400).send({ error: err.message }); }
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  const exists = [];
  for (const n of names) {
    const rel = safeRelPath(n);
    if (rel && (await pathExists(resolve(baseDir, rel)))) exists.push(rel);
  }
  return { exists };
});

app.post('/api/upload', async (req, reply) => {
  let baseDir;
  try {
    // Prefer an explicit (validated) destination dir; fall back to the session cwd.
    baseDir = req.query.dir ? await resolveAllowedDir(req.query.dir) : await sessionDir(req.query.session);
  } catch (err) { return reply.code(err.statusCode || 400).send({ error: err.message }); }
  // On a name conflict: 'skip' (default), 'overwrite', or 'rename' (keep both).
  const mode = req.query.mode || (req.query.overwrite === '1' ? 'overwrite' : 'skip');
  const names = [];
  const skipped = [];
  try {
    for await (const part of req.files()) {
      // The relative path is carried in the field name ("f:<path>") because
      // multipart basenames part.filename — so folder structure survives.
      const raw = part.fieldname && part.fieldname.startsWith('f:') ? part.fieldname.slice(2) : part.filename;
      const rel = safeRelPath(raw);
      if (!rel) { part.file.resume(); continue; }
      let dest = resolve(baseDir, rel);
      // Defense in depth: the resolved path must stay inside the target dir.
      if (dest !== baseDir && !dest.startsWith(baseDir + sep)) { part.file.resume(); continue; }
      if (await pathExists(dest)) {
        if (mode === 'skip') { part.file.resume(); skipped.push(rel); continue; }
        if (mode === 'rename') dest = await uniquePath(dest);
        // 'overwrite' keeps dest as-is
      }
      await mkdir(dirname(dest), { recursive: true });
      await pipeline(part.file, createWriteStream(dest));
      names.push(relative(baseDir, dest)); // actual written path (may be renamed)
    }
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
  return { count: names.length, dir: baseDir, names, skipped };
});

// ---- file explorer (browse / download / delete within allowed roots) ----
app.get('/api/files', async (req, reply) => {
  try {
    const abs = await resolveAllowedDir(req.query.path || config.roots[0]);
    const ents = await readdir(abs, { withFileTypes: true });
    const entries = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue; // hide dotfiles
      const s = await stat(join(abs, e.name)).catch(() => null);
      entries.push({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        sizeKb: s && s.isFile() ? Math.round(s.size / 1024) : null,
        mtime: s ? s.mtimeMs : null,
      });
    }
    entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    const parent = config.roots.some((r) => abs === r) ? null : dirname(abs);
    return { path: abs, parent, roots: config.roots, entries };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

app.get('/api/files/download', async (req, reply) => {
  try {
    const p = resolve(req.query.path || '');
    const ok = config.roots.some((r) => p === r || p.startsWith(r + sep));
    if (!ok) return reply.code(400).send({ error: 'Path must be under an allowed root' });
    const s = await stat(p);
    if (!s.isFile()) return reply.code(400).send({ error: 'Not a file' });
    reply.header('Content-Disposition', `attachment; filename="${basename(p).replace(/"/g, '')}"`);
    reply.header('Content-Type', 'application/octet-stream');
    return reply.send(createReadStream(p));
  } catch (err) {
    return reply.code(err.statusCode || 404).send({ error: 'File not found' });
  }
});

app.post('/api/files/delete', async (req, reply) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  const result = { deleted: 0, errors: [] };
  for (const raw of paths) {
    const p = resolve(String(raw || ''));
    // Refuse to delete an allowed root itself; only things strictly under one.
    const inside = config.roots.some((r) => p.startsWith(r + sep)) && !config.roots.includes(p);
    if (!inside) { result.errors.push(`${raw}: outside allowed roots`); continue; }
    try { await rm(p, { recursive: true, force: false }); result.deleted += 1; }
    catch (e) { result.errors.push(`${basename(p)}: ${e.code || e.message}`); }
  }
  return result;
});

// ---- Storage / retention hub (controlled, selective deletes) ----
app.get('/api/storage', async (req, reply) => {
  try {
    return await listArtifacts();
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});
app.post('/api/storage/delete', async (req, reply) => {
  const b = req.body || {};
  try {
    // Protect transcripts of currently-running sessions from deletion.
    const protectedIds = new Set();
    for (const s of await enrichedSessions()) {
      if (s.liveSessionId) protectedIds.add(s.liveSessionId);
      if (s.resumedFrom) protectedIds.add(s.resumedFrom);
    }
    return await deleteArtifacts(
      { handoffs: b.handoffs || [], caches: b.caches || [], transcripts: b.transcripts || [] },
      protectedIds,
    );
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

// ---- MCP endpoint (remote Model Context Protocol, Streamable HTTP) ----
// Lets another Claude (claude.ai, Claude Code, …) search + pull context from your
// past sessions. Bearer-gated; disabled unless CCDECK_MCP_TOKEN is set. Stateful:
// initialize creates a session (server+transport) keyed by Mcp-Session-Id.
const mcpSessions = new Map(); // sessionId -> { server, transport }
// Accept either the static bearer token (Claude Code) or an OAuth access token (claude.ai).
function mcpAuthed(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7);
  if (config.mcpToken && tok === config.mcpToken) return true;
  if (config.mcpTokenReadonly && tok === config.mcpTokenReadonly) return true;
  return !!oauth.verifyAccessToken(tok);
}
// True only for the static-bearer (e.g. Claude Code / a headless agent), not OAuth connectors —
// gates the session-control tools that spawn/drive real claude processes.
function mcpIsStatic(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && !!config.mcpToken && h.slice(7) === config.mcpToken;
}
function mcpUnauthorized(req, reply) {
  reply.header('WWW-Authenticate', `Bearer resource_metadata="${oauth.baseUrl(req)}/.well-known/oauth-protected-resource"`);
  return reply.code(401).send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
}

// OAuth 2.1 metadata + endpoints (for claude.ai remote connectors).
app.get('/.well-known/oauth-protected-resource', async (req) => oauth.protectedResourceMeta(oauth.baseUrl(req)));
app.get('/.well-known/oauth-protected-resource/mcp', async (req) => oauth.protectedResourceMeta(oauth.baseUrl(req)));
app.get('/.well-known/oauth-authorization-server', async (req) => oauth.authServerMeta(oauth.baseUrl(req)));
app.post('/oauth/register', async (req, reply) => {
  try { return reply.code(201).send(oauth.registerClient(req.body || {})); }
  catch (err) { return reply.code(err.statusCode || 400).send({ error: err.message }); }
});
app.get('/oauth/authorize', async (req, reply) => {
  try { return reply.type('text/html').send(oauth.authorizePage(req.query)); }
  catch (err) { return reply.code(err.statusCode || 400).send(err.message); }
});
app.post('/oauth/authorize', async (req, reply) => {
  const form = req.body || {};
  try { return reply.redirect(oauth.approveAuthorize(form)); }
  catch (err) {
    if (err.statusCode === 401) return reply.type('text/html').send(oauth.authorizePage({ ...form, _err: err.message }));
    return reply.code(err.statusCode || 400).send(err.message);
  }
});
app.post('/oauth/token', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  try { return oauth.tokenExchange(req.body || {}); }
  catch (err) { return reply.code(err.statusCode || 400).send({ error: err.message }); }
});

app.post('/mcp', async (req, reply) => {
  if (!mcpAuthed(req)) return mcpUnauthorized(req, reply);
  const sid = req.headers['mcp-session-id'];
  const isInit = req.body && !Array.isArray(req.body) && req.body.method === 'initialize';
  let transport;
  if (sid && mcpSessions.has(sid)) {
    transport = mcpSessions.get(sid).transport;
  } else if (!sid && isInit) {
    const server = createMcpServer({ sessionControl: mcpIsStatic(req) });
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => mcpSessions.set(id, { server, transport }),
    });
    transport.onclose = () => { if (transport.sessionId) mcpSessions.delete(transport.sessionId); };
    await server.connect(transport);
  } else {
    return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'No valid session ID' } });
  }
  reply.hijack();
  await transport.handleRequest(req.raw, reply.raw, req.body);
});
// GET = server→client SSE stream; DELETE = end session. Both need a live session.
async function mcpBySession(req, reply) {
  if (!mcpAuthed(req)) return reply.code(401).send({ error: 'Unauthorized' });
  const sid = req.headers['mcp-session-id'];
  const entry = sid && mcpSessions.get(sid);
  if (!entry) return reply.code(400).send({ error: 'No valid session ID' });
  reply.hijack();
  await entry.transport.handleRequest(req.raw, reply.raw);
}
app.get('/mcp', mcpBySession);
app.delete('/mcp', mcpBySession);

// ---- Filesystem picker ----
app.get('/api/fs', async (req, reply) => {
  const path = req.query.path || config.roots[0];
  try {
    return await listDirs(path);
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

// Create a folder under `parent`, then return the refreshed listing + new path.
app.post('/api/fs', async (req, reply) => {
  const { parent, name } = req.body || {};
  try {
    const created = await createDir(parent, name);
    return { created, ...(await listDirs(parent)) };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

app.get('/api/config', async () => {
  return { roots: config.roots, launchCommand: config.launchCommand, home: process.env.HOME || '' };
});

// Build version = the client bundle's mtime. The UI polls this and offers a
// reload when it changes (so a redeploy is picked up without manual refresh).
app.get('/api/version', async () => {
  try { return { v: Math.round(statSync(join(publicDir, 'dashboard.js')).mtimeMs) }; }
  catch { return { v: 0 }; }
});

// ---- Usage / ROI ----
app.get('/api/burn', async () => {
  return await getBurn();
});

app.get('/api/usage', async (req, reply) => {
  try {
    return await getUsage(req.query.billingDay);
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
});

// Metadata about the last snapshot (for the "last snapshot" indicator).
app.get('/api/restore', async () => {
  const snap = await loadSnapshot();
  return { at: snap?.at || null, count: snap?.sessions?.length || 0 };
});

// Snapshot the active sessions now (so they're restored on next startup/reboot).
// Also reports how many are still "working" (in-flight) so the UI can tell you
// whether it's safe to reboot for a clean restore.
app.post('/api/restore/snapshot', async (req, reply) => {
  try {
    const count = await captureSnapshot();
    let busy = 0;
    try { busy = (await enrichedSessions()).filter((s) => s.claudeStatus === 'busy').length; } catch { /* */ }
    return { count, busy };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

// ---- WebSocket: terminal attach ----
app.register(async (instance) => {
  instance.get('/ws/attach', { websocket: true }, (socket, req) => {
    attachHandler(socket, req.raw);
  });
});

const address = await app.listen({ port: config.port, host: config.bind });
app.log.info(`cc-deck listening on ${address} (roots: ${config.roots.join(', ')})`);

// Keep cc-deck's dedicated tmux server alive even when it has no sessions.
await initServer().catch(() => {});

// On a fresh boot (no sessions running), restore the sessions that were active
// before the box went down; then keep a periodic snapshot as a safety net.
restoreIfBoot()
  .then((r) => {
    if (r?.restored) app.log.info(`restored ${r.restored}/${r.total} session(s) from snapshot`);
    else if (r?.reason) app.log.info(`session restore skipped: ${r.reason}`);
  })
  .catch((e) => app.log.warn(`session restore failed: ${e.message}`))
  .finally(() => { setInterval(() => captureSnapshot().catch(() => {}), 120_000); });

// Snapshot on graceful stop (systemctl stop / reboot) so nothing is lost.
let ccdeckStopping = false;
async function snapshotAndExit() {
  if (ccdeckStopping) return;
  ccdeckStopping = true;
  try { await Promise.race([captureSnapshot({ skipIfEmpty: true }), new Promise((r) => setTimeout(r, 5000))]); } catch { /* */ }
  process.exit(0);
}
process.on('SIGTERM', snapshotAndExit);
process.on('SIGINT', snapshotAndExit);

// Warm the pricing cache in the background so the first Usage load is instant.
getPricing()
  .then((p) => app.log.info(`pricing: ${p.source}${p.stale ? ' (stale)' : ''}`))
  .catch(() => {});
