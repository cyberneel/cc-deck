import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import { checkPassword, issueToken, verifyToken } from './auth.js';
import {
  listSessions,
  createSession,
  killSession,
  renameSession,
  capturePane,
  listDirs,
} from './tmux.js';
import { attachHandler } from './pty.js';
import { initServer } from './tmux.js';
import { getAgents, matchAgents } from './agents.js';
import { listHistory } from './history.js';

// Active sessions enriched with each one's live Claude status (busy/idle/waiting).
async function enrichedSessions() {
  const sessions = await listSessions();
  try { matchAgents(sessions, await getAgents()); } catch { /* degrade */ }
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

await app.register(fastifyCookie);
await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

// Paths reachable without auth.
const PUBLIC_PATHS = new Set(['/login.html', '/login.css', '/api/login', '/favicon.ico']);

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
  const { dir, title, resume } = req.body || {};
  if (!dir) return reply.code(400).send({ error: 'dir is required' });
  try {
    // Don't launch a duplicate: if the session being resumed is already running,
    // hand back the existing one so the client can just open it.
    if (resume) {
      const existing = (await enrichedSessions()).find(
        (s) => s.resumedFrom === resume || s.liveSessionId === resume,
      );
      if (existing) return { name: existing.name, alreadyRunning: true };
    }
    const name = await createSession({ dir, title, resume });
    return { name };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

// Past Claude sessions on disk (resumable via `claude --resume`).
app.get('/api/history', async () => {
  return await listHistory();
});

app.delete('/api/sessions/:name', async (req, reply) => {
  try {
    await killSession(req.params.name);
    return { ok: true };
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

// ---- Filesystem picker ----
app.get('/api/fs', async (req, reply) => {
  const path = req.query.path || config.roots[0];
  try {
    return await listDirs(path);
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

app.get('/api/config', async () => {
  return { roots: config.roots, launchCommand: config.launchCommand, home: process.env.HOME || '' };
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

// ---- WebSocket: terminal attach ----
app.register(async (instance) => {
  instance.get('/ws/attach', { websocket: true }, (socket, req) => {
    attachHandler(socket, req.raw);
  });
});

const address = await app.listen({ port: config.port, host: config.bind });
app.log.info(`cc-deck listening on ${address} (roots: ${config.roots.join(', ')})`);

// Keep cc-deck's dedicated tmux server alive even when it has no sessions.
initServer().catch(() => {});

// Warm the pricing cache in the background so the first Usage load is instant.
getPricing()
  .then((p) => app.log.info(`pricing: ${p.source}${p.stale ? ' (stale)' : ''}`))
  .catch(() => {});
