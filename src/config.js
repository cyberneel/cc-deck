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
  // Bearer token gating the MCP endpoint (/mcp). Empty = MCP disabled.
  mcpToken: process.env.CCDECK_MCP_TOKEN || '',
  // Read-only bearer: same /mcp endpoint but WITHOUT the session-control tools
  // (create/send). Used to auto-wire launched sessions so they can search + leave
  // handoff notes, but can't start or drive other sessions.
  mcpTokenReadonly: process.env.CCDECK_MCP_TOKEN_READONLY || '',
  // Auto-wire every new session with the read-only cc-deck MCP + a handoff nudge.
  sessionMcp: /^(1|on|true|yes)$/i.test(process.env.CCDECK_SESSION_MCP || ''),
  // Public origin for OAuth metadata (e.g. https://claude.example.com). Derived
  // from request headers if unset — set it if the derived host is ever wrong.
  publicUrl: process.env.CCDECK_PUBLIC_URL || '',
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
