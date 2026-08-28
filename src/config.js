import { resolve } from 'node:path';
import { homedir } from 'node:os';
import dotenv from 'dotenv';

dotenv.config();

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
  bind: process.env.CCDECK_BIND || '127.0.0.1',
  password: process.env.CCDECK_PASSWORD || '',
  secret: process.env.CCDECK_SECRET || '',
  // Directories under which new sessions may be launched / browsed.
  roots: parseRoots(process.env.CCDECK_ROOTS),
  // Directories whose Claude transcripts are hidden from the History tab — e.g.
  // dirs where another app (hyre) runs `claude -p` headlessly. Colon-separated.
  excludeDirs: (process.env.CCDECK_EXCLUDE_DIRS || '')
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p)),
  // tmux session name prefix for sessions this app manages.
  prefix: 'ccdeck-',
  // Dedicated tmux socket so cc-deck's sessions live on their own server,
  // isolated from your personal `tmux` (and protected with exit-empty off).
  tmuxSocket: process.env.CCDECK_TMUX_SOCKET || 'ccdeck',
  // Command launched inside each new session.
  launchCommand: process.env.CCDECK_LAUNCH || 'claude',
  // Permission mode each new session starts in (Claude's --permission-mode):
  // acceptEdits | auto | plan | bypassPermissions | manual | default. Empty =
  // Claude's own default. The user can still cycle with shift+tab in-session.
  permissionMode: (process.env.CCDECK_PERMISSION_MODE || '').trim(),
  // Remote hosts whose tmux sessions cc-deck lists + attaches over SSH (tailnet).
  // Comma/space-separated entries: "sshTarget" or "label=sshTarget"
  // (e.g. "laptop=cyber@laptop.tailnet.ts.net dell-arch-cyber"). Needs key-based SSH.
  remoteHosts: (process.env.CCDECK_REMOTE_HOSTS || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      const label = (eq > 0 ? entry.slice(0, eq) : entry.split('@').pop()).replace(/[^A-Za-z0-9_.-]/g, '');
      const sshTarget = eq > 0 ? entry.slice(eq + 1) : entry;
      return { label, sshTarget };
    })
    .filter((h) => h.label && h.sshTarget),
  // Bearer token gating the MCP endpoint (/mcp). Empty = MCP disabled.
  mcpToken: process.env.CCDECK_MCP_TOKEN || '',
  // Read-only bearer: same /mcp endpoint but WITHOUT the session-control tools
  // (create/send). Used to auto-wire launched sessions so they can search + leave
  // handoff notes, but can't start or drive other sessions.
  mcpTokenReadonly: process.env.CCDECK_MCP_TOKEN_READONLY || '',
  // Auto-wire every new session with the read-only cc-deck MCP + a handoff nudge.
  sessionMcp: /^(1|on|true|yes)$/i.test(process.env.CCDECK_SESSION_MCP || ''),
  // Auto-wire every new session with the SHARED logged-in browser (chrome-devtools-mcp
  // → browserCdp) + a coordination nudge, so sessions (and Friday) share one browser
  // without colliding — each works in its own tab via cc-deck's browser broker/registry.
  sessionBrowser: /^(1|on|true|yes)$/i.test(process.env.CCDECK_SESSION_BROWSER || ''),
  // CDP endpoint of that shared browser (the one cc-deck's broker manages + sessions attach to).
  browserCdp: process.env.CCDECK_BROWSER_CDP || 'http://127.0.0.1:9222',
  // Public origin for OAuth metadata (e.g. https://claude.example.com). Derived
  // from request headers if unset — set it if the derived host is ever wrong.
  publicUrl: process.env.CCDECK_PUBLIC_URL || '',
  // Push session-state transitions to Friday's Reach Manager (POST to the url) the instant
  // they happen, so Friday reacts without polling cc-deck. OPT-IN: unset url = disabled
  // (cc-deck runs standalone). Point url at Friday's /api/reach and password at its app
  // password. e.g. CCDECK_FRIDAY_REACH_URL=http://127.0.0.1:8790/api/reach
  fridayReach: {
    url: process.env.CCDECK_FRIDAY_REACH_URL || '',
    password: process.env.CCDECK_FRIDAY_REACH_PASSWORD || '',
  },
  cookieName: 'ccdeck',
  cookieMaxAge: 60 * 60 * 24 * 30, // 30 days (seconds)
};

if (!config.password) {
  console.warn('[cc-deck] WARNING: CCDECK_PASSWORD is not set — login is effectively disabled. Set it in .env.');
}
if (!config.secret) {
  console.warn('[cc-deck] WARNING: CCDECK_SECRET is not set — using an insecure default. Set a random value in .env.');
  config.secret = 'insecure-development-secret-change-me';
}
