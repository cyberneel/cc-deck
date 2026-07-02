// Minimal OAuth 2.1 authorization server so claude.ai (web/mobile) can connect to
// the /mcp endpoint. Supports Dynamic Client Registration, PKCE (S256), the
// authorization-code grant, and refresh tokens. Single-user: the resource owner
// authenticates with the cc-deck password on the consent screen. Tokens are
// HMAC-signed (no DB); clients + auth codes live in memory.
import crypto from 'node:crypto';
import { config } from './config.js';
import { checkPassword } from './auth.js';

const clients = new Map(); // client_id -> { redirectUris:[], name }
const codes = new Map();   // code -> { clientId, redirectUri, challenge, resource, exp }
const ACCESS_TTL = 3600_000;          // 1h
const REFRESH_TTL = 30 * 86_400_000;  // 30d
const CODE_TTL = 600_000;             // 10m

const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (p.exp && Date.now() > p.exp) return null;
  return p;
}

export function verifyAccessToken(token) {
  const p = verify(token);
  return p && p.t === 'access' ? p : null;
}

// Public origin (behind Cloudflare: honor x-forwarded-proto + host).
export function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, '');
  const host = req.headers.host || 'localhost';
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// RFC 9728 — points the client at this app as its own authorization server.
export function protectedResourceMeta(base) {
  return { resource: `${base}/mcp`, authorization_servers: [base] };
}
// RFC 8414 — authorization server metadata.
export function authServerMeta(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  };
}

// Dynamic Client Registration (RFC 7591). Public client, no secret.
export function registerClient(body) {
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
  if (!uris.length) { const e = new Error('redirect_uris required'); e.statusCode = 400; throw e; }
  const clientId = crypto.randomUUID();
  clients.set(clientId, { redirectUris: uris, name: body.client_name || 'MCP client' });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: body.client_name || 'MCP client',
  };
}

function validClient(clientId, redirectUri) {
  const c = clients.get(clientId);
  return c && c.redirectUris.includes(redirectUri) ? c : null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The consent + password screen (GET /oauth/authorize). Returns HTML or throws.
export function authorizePage(q) {
  if (q.response_type !== 'code') { const e = new Error('unsupported response_type'); e.statusCode = 400; throw e; }
  if (!q.code_challenge || q.code_challenge_method !== 'S256') { const e = new Error('PKCE (S256) required'); e.statusCode = 400; throw e; }
  const client = validClient(q.client_id, q.redirect_uri);
  if (!client) { const e = new Error('unknown client_id or redirect_uri'); e.statusCode = 400; throw e; }
  const hidden = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource', 'response_type']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] || '')}">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>cc-deck · authorize</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0c0c;color:#ededed;font-family:-apple-system,system-ui,sans-serif}
.card{background:#171717;border:1px solid #2c2c2c;border-radius:16px;padding:28px;max-width:400px;width:90%}
h1{font-size:18px;margin:0 0 6px}p{color:#9b9b9b;font-size:14px;line-height:1.5}
input[type=password]{width:100%;box-sizing:border-box;background:#0c0c0c;border:1px solid #2c2c2c;color:#ededed;border-radius:8px;padding:11px;font-size:15px;margin:12px 0}
button{width:100%;background:#d97757;border:none;color:#1a0f0a;font-weight:600;border-radius:9px;padding:12px;font-size:15px;cursor:pointer}
.dot{width:9px;height:9px;border-radius:50%;background:#d97757;display:inline-block;margin-right:8px}.err{color:#ff8d85;font-size:13px;min-height:16px}
</style></head><body><form class="card" method="POST" action="/oauth/authorize">
<h1><span class="dot"></span>Authorize ${esc(client.name)}</h1>
<p>This will let <strong>${esc(client.name)}</strong> search and read your cc-deck session history. Enter your cc-deck password to allow.</p>
${hidden}
<input type="password" name="password" placeholder="cc-deck password" autofocus autocomplete="current-password">
<div class="err">${q._err ? esc(q._err) : ''}</div>
<button type="submit">Allow access</button>
</form></body></html>`;
}

// Handle consent form POST → issue an auth code and return the redirect URL.
export function approveAuthorize(form) {
  if (!checkPassword(form.password || '')) { const e = new Error('Incorrect password'); e.statusCode = 401; throw e; }
  const client = validClient(form.client_id, form.redirect_uri);
  if (!client) { const e = new Error('unknown client'); e.statusCode = 400; throw e; }
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, { clientId: form.client_id, redirectUri: form.redirect_uri, challenge: form.code_challenge, resource: form.resource, exp: Date.now() + CODE_TTL });
  const u = new URL(form.redirect_uri);
  u.searchParams.set('code', code);
  if (form.state) u.searchParams.set('state', form.state);
  return u.toString();
}

function pkceOk(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const h = crypto.createHash('sha256').update(verifier).digest('base64url');
  return h === challenge;
}

// Token endpoint (POST /oauth/token), form-encoded.
export function tokenExchange(form) {
  const issue = () => ({
    access_token: sign({ t: 'access', scope: 'mcp', iat: Date.now(), exp: Date.now() + ACCESS_TTL }),
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL / 1000),
    refresh_token: sign({ t: 'refresh', iat: Date.now(), exp: Date.now() + REFRESH_TTL }),
    scope: 'mcp',
  });
  if (form.grant_type === 'authorization_code') {
    const rec = codes.get(form.code);
    codes.delete(form.code); // single use
    if (!rec || rec.exp < Date.now()) { const e = new Error('invalid_grant'); e.statusCode = 400; throw e; }
    if (rec.clientId !== form.client_id || rec.redirectUri !== form.redirect_uri) { const e = new Error('invalid_grant'); e.statusCode = 400; throw e; }
    if (!pkceOk(form.code_verifier, rec.challenge)) { const e = new Error('invalid_grant (PKCE)'); e.statusCode = 400; throw e; }
    return issue();
  }
  if (form.grant_type === 'refresh_token') {
    const p = verify(form.refresh_token);
    if (!p || p.t !== 'refresh') { const e = new Error('invalid_grant'); e.statusCode = 400; throw e; }
    return issue();
  }
  const e = new Error('unsupported_grant_type'); e.statusCode = 400; throw e;
}
