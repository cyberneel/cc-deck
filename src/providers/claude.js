// Claude Code provider. Owns everything CLI-specific about a `claude` session:
// how it launches/resumes/forks, its permission-mode flag, and the cc-deck MCP +
// shared-browser auto-wire (which uses Claude's --mcp-config / --append-system-prompt).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';

const RESUME_ID_RE = /^[0-9a-fA-F-]{36}$/;
const SESSION_MCP_PATH = join(homedir(), '.claude', 'cc-deck', 'session-mcp.json');
const BROWSER_MCP_PATH = join(homedir(), '.claude', 'cc-deck', 'browser-mcp.json');
const SESSION_NUDGE = "You are one of several cc-deck sessions the user runs in parallel. Before substantial work you may use the cc-deck tools (search_sessions, get_session_context) to check whether related work already lives in another session; if a request clearly belongs to a different session, prefer leaving a handoff note (save_session_summary) over duplicating it here. You cannot start or drive other sessions yourself.";
const BROWSER_NUDGE = "You can drive a shared, already-logged-in Chrome via the chrome-* tools — it is SHARED with other cc-deck sessions and with Friday, so coordinate through cc-deck's broker: call browser_tabs to see what is open and who has each tab; do your work in your OWN tab (chrome new_page, navigate it, then browser_claim it with a short note); NEVER navigate, click, or close a tab you did not open (those hold other agents' logged-in work); when finished, close your tab (chrome close_page) and browser_release it.";

function badId() { const e = new Error('Invalid resume session id'); e.statusCode = 400; return e; }

export const claude = {
  kind: 'claude',
  label: 'Claude',
  command: () => config.launchCommand,
  resumeIdRe: RESUME_ID_RE,

  // Post-command launch args: resume/fork by id + the configured permission mode.
  launchArgs({ resume, fork }) {
    let args = '';
    if (resume) {
      if (!RESUME_ID_RE.test(resume)) throw badId();
      args = ` --resume ${resume}`;
      if (fork) args += ' --fork-session'; // branch into a new id, leave the original untouched
    }
    if (/^(acceptEdits|auto|plan|bypassPermissions|manual|default)$/.test(config.permissionMode)) {
      args += ` --permission-mode ${config.permissionMode}`;
    }
    return args;
  },

  // Auto-wire the read-only cc-deck MCP (handoff-aware) and — when enabled — the
  // shared logged-in browser, under ONE combined --append-system-prompt. Writes the
  // mcp-config files and returns the flag string (empty when nothing is enabled).
  async wireFlags({ browser } = {}) {
    let flags = '';
    const nudges = [];
    const ensureDir = () => mkdir(join(homedir(), '.claude', 'cc-deck'), { recursive: true });
    if (config.sessionMcp && config.mcpTokenReadonly) {
      const cfg = { mcpServers: { 'cc-deck': { type: 'http', url: `http://127.0.0.1:${config.port}/mcp`, headers: { Authorization: `Bearer ${config.mcpTokenReadonly}` } } } };
      try { await ensureDir(); await writeFile(SESSION_MCP_PATH, JSON.stringify(cfg)); flags += ` --mcp-config ${SESSION_MCP_PATH}`; nudges.push(SESSION_NUDGE); } catch { /* skip cc-deck MCP */ }
    }
    if (config.sessionBrowser || browser) {
      const cfg = { mcpServers: { chrome: { command: 'npx', args: ['chrome-devtools-mcp@latest', '--browser-url', config.browserCdp] } } };
      try { await ensureDir(); await writeFile(BROWSER_MCP_PATH, JSON.stringify(cfg)); flags += ` --mcp-config ${BROWSER_MCP_PATH}`; if (config.sessionMcp) nudges.push(BROWSER_NUDGE); } catch { /* skip browser */ }
    }
    if (nudges.length) {
      const nudge = nudges.join(' ').replace(/'/g, "'\\''"); // shell-safe single quotes
      flags += ` --append-system-prompt '${nudge}'`;
    }
    return flags;
  },
};
