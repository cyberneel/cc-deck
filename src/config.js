import { resolve } from 'node:path';
import { homedir } from 'node:os';
import dotenv from 'dotenv';

dotenv.config();

// Polymux was called cc-deck. Its CCDECK_* settings still work: each one fills the
// POLYMUX_* name when that is unset or empty, so an old .env, unit or tenant env needs no edit.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('CCDECK_') && !process.env[`POLYMUX_${k.slice(7)}`]?.trim()) process.env[`POLYMUX_${k.slice(7)}`] = v;
}

function parseRoots(raw) {
  const list = (raw || process.env.HOME || homedir())
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  return list;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  bind: process.env.POLYMUX_BIND || '127.0.0.1',
  password: process.env.POLYMUX_PASSWORD || '',
  secret: process.env.POLYMUX_SECRET || '',
  // Directories under which new sessions may be launched / browsed.
  roots: parseRoots(process.env.POLYMUX_ROOTS),
  // Directories whose Claude transcripts are hidden from the History tab — e.g.
  // dirs where another app (hyre) runs `claude -p` headlessly. Colon-separated.
  excludeDirs: (process.env.POLYMUX_EXCLUDE_DIRS || '')
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p)),
  // Hosted-tenant account hub. systems' provisioning injects a tokenized
  // https://systems.cyberneel.com/account?t=… URL only into hosted-tenant VMs;
  // when set, the UI shows an "Account ↗" link to it. Self-host = unset = hidden.
  accountUrl: (process.env.ACCOUNT_URL || '').trim(),
  // Origins allowed to iframe Polymux, beyond same-origin (CSP frame-ancestors).
  // The unified hub (systems /account) embeds the apps, so add its origin (and the
  // tenant's own) here. Space/comma-separated. Empty = same-origin framing only,
  // which blocks cross-origin clickjacking. Each entry must be a bare origin
  // (scheme://host[:port]) — anything else is dropped so it can't inject a header.
  frameAncestors: (process.env.POLYMUX_FRAME_ANCESTORS || '')
    .split(/[\s,]+/)
    .filter((o) => /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(o)),
  // Unified-hub SSO. When set, Polymux redeems an inbound `?sso=<token>` by POSTing
  // it to this systems verify endpoint (Polymux holds no signing secret — the token
  // is opaque and validated server-to-server). Unset = SSO off (self-host / direct).
  ssoVerifyUrl: (process.env.POLYMUX_SSO_VERIFY_URL || '').trim(),
  // This VM's tenant id (systems injects it); the redeemed token's `tenant` must
  // match it. Empty = single-tenant / self-host → skip the tenant check.
  tenantId: (process.env.POLYMUX_TENANT_ID || '').trim(),
  // Self-host update check (fetch the upstream branch every few hours → "update"
  // pill). Never on hosted tenants: their Polymux is rolled by image, not git.
  updateCheck: !(process.env.POLYMUX_TENANT_ID || '').trim() && process.env.POLYMUX_UPDATE_CHECK !== 'off',
  // Most Deep Sessions this deck runs at once. Unset/0 = no cap (self-host). A hosted
  // tenant's VM is small, so its init sets one from the VM's RAM. At the cap, src/slots.js
  // closes an idle session Friday started, or queues Friday's start until a slot opens.
  maxSessions: Math.max(0, parseInt(process.env.POLYMUX_MAX_SESSIONS || '', 10) || 0),
  // How long a session Friday started must sit idle before it may be closed for a slot.
  slotIdleMs: (Number(process.env.POLYMUX_SLOT_IDLE_SECS) || 300) * 1000,
  // tmux session name prefix for sessions this app manages.
  prefix: 'ccdeck-',
  // Dedicated tmux socket so Polymux's sessions live on their own server,
  // isolated from your personal `tmux` (and protected with exit-empty off).
  tmuxSocket: process.env.POLYMUX_TMUX_SOCKET || 'ccdeck',
  // Command launched inside each new session (the Claude CLI provider).
  launchCommand: process.env.POLYMUX_LAUNCH || 'claude',
  // The Codex CLI provider (Polymux is multi-CLI via src/providers/). Set to a
  // custom binary/path if `codex` isn't on PATH; per-session choice is in the UI.
  codexCommand: process.env.POLYMUX_CODEX_LAUNCH || 'codex',
  // Codex approval policy new Codex sessions start in (its "permission mode"):
  // e.g. untrusted | on-failure | on-request | never. Empty = Codex's own default.
  codexApproval: (process.env.POLYMUX_CODEX_APPROVAL || '').trim(),
  // The Antigravity (agy) CLI provider — binary + its execution mode (agy's
  // "permission mode": accept-edits | plan). Empty mode = agy's own default.
  agyCommand: process.env.POLYMUX_AGY_LAUNCH || 'agy',
  agyMode: (process.env.POLYMUX_AGY_MODE || '').trim(),
  // Auto-accept a CLI's "trust this folder?" prompt on launch. The directory is
  // operator-chosen (under POLYMUX_ROOTS), so this is safe by default and stops
  // sessions from stalling/closing on the trust gate. Set POLYMUX_AUTO_TRUST=off to
  // leave the prompt for the user to answer.
  autoTrust: !/^(0|off|false|no)$/i.test(process.env.POLYMUX_AUTO_TRUST || ''),
  // Permission mode each new session starts in (Claude's --permission-mode):
  // acceptEdits | auto | plan | bypassPermissions | manual | default. Empty =
  // Claude's own default. The user can still cycle with shift+tab in-session.
  permissionMode: (process.env.POLYMUX_PERMISSION_MODE || '').trim(),
  // Remote hosts whose tmux sessions Polymux lists + attaches over SSH (tailnet).
  // Comma/space-separated entries: "sshTarget" or "label=sshTarget"
  // (e.g. "laptop=cyber@laptop.tailnet.ts.net dell-arch-cyber"). Needs key-based SSH.
  remoteHosts: (process.env.POLYMUX_REMOTE_HOSTS || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      const label = (eq > 0 ? entry.slice(0, eq) : entry.split('@').pop()).replace(/[^A-Za-z0-9_.-]/g, '');
      const sshTarget = eq > 0 ? entry.slice(eq + 1) : entry;
      return { label, sshTarget };
    })
    .filter((h) => h.label && h.sshTarget),
  // Bearer token gating the MCP endpoint (/mcp). Empty = MCP disabled.
  mcpToken: process.env.POLYMUX_MCP_TOKEN || '',
  // Read-only bearer: same /mcp endpoint but WITHOUT the session-control tools
  // (create/send). Used to auto-wire launched sessions so they can search + leave
  // handoff notes, but can't start or drive other sessions.
  mcpTokenReadonly: process.env.POLYMUX_MCP_TOKEN_READONLY || '',
  // Auto-wire every new session with the read-only Polymux MCP + a handoff nudge.
  sessionMcp: /^(1|on|true|yes)$/i.test(process.env.POLYMUX_SESSION_MCP || ''),
  // Auto-wire every new session with the SHARED logged-in browser (chrome-devtools-mcp
  // → browserCdp) + a coordination nudge, so sessions (and Friday) share one browser
  // without colliding — each works in its own tab via Polymux's browser broker/registry.
  sessionBrowser: /^(1|on|true|yes)$/i.test(process.env.POLYMUX_SESSION_BROWSER || ''),
  // CDP endpoint of that shared browser (the one Polymux's broker manages + sessions attach to).
  browserCdp: process.env.POLYMUX_BROWSER_CDP || 'http://127.0.0.1:9222',
  // Public origin for OAuth metadata (e.g. https://claude.example.com). Derived
  // from request headers if unset — set it if the derived host is ever wrong.
  publicUrl: process.env.POLYMUX_PUBLIC_URL || '',
  // Push session-state transitions to Friday's Reach Manager (POST to the url) the instant
  // they happen, so Friday reacts without polling Polymux. OPT-IN: unset url = disabled
  // (Polymux runs standalone). Point url at Friday's /api/reach and password at its app
  // password. e.g. POLYMUX_FRIDAY_REACH_URL=http://127.0.0.1:8790/api/reach
  fridayReach: {
    url: process.env.POLYMUX_FRIDAY_REACH_URL || '',
    password: process.env.POLYMUX_FRIDAY_REACH_PASSWORD || '',
  },
  // Per-turn RAM/CPU → the systems fleet telemetry ingest (hosted tier sizing). OPT-IN: inert
  // unless url + token are set (systems seeds both at provision; the tenant is POLYMUX_TENANT_ID).
  telemetry: {
    url: process.env.POLYMUX_TELEMETRY_URL || '',
    token: process.env.POLYMUX_TELEMETRY_TOKEN || '',
  },
  cookieName: 'ccdeck',
  cookieMaxAge: 60 * 60 * 24 * 30, // 30 days (seconds)
};

if (!config.password) {
  console.warn('[polymux] WARNING: POLYMUX_PASSWORD is not set — login is effectively disabled. Set it in .env.');
}
if (!config.secret) {
  console.warn('[polymux] WARNING: POLYMUX_SECRET is not set — using an insecure default. Set a random value in .env.');
  config.secret = 'insecure-development-secret-change-me';
}
