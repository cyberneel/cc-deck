import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import { config } from './config.js';

const SESSION_MCP_PATH = join(homedir(), '.claude', 'cc-deck', 'session-mcp.json');
const BROWSER_MCP_PATH = join(homedir(), '.claude', 'cc-deck', 'browser-mcp.json');

// On-demand: attach chrome-devtools-mcp (a logged-in Chromium via CDP) when
// a session opts in. Guard on the file existing — a missing --mcp-config aborts the
// whole launch. Non-strict, so it adds to the session's other MCPs.
async function browserMcpFlag() {
  try { await stat(BROWSER_MCP_PATH); } catch { return ''; }
  return ` --mcp-config ${BROWSER_MCP_PATH}`;
}
const SESSION_NUDGE = "You are one of several cc-deck sessions the user runs in parallel. Before substantial work you may use the cc-deck tools (search_sessions, get_session_context) to check whether related work already lives in another session; if a request clearly belongs to a different session, prefer leaving a handoff note (save_session_summary) over duplicating it here. You cannot start or drive other sessions yourself.";

// Launch flags to wire a new session with the READ-ONLY cc-deck MCP + a handoff
// nudge (only when enabled). Loopback URL — no Cloudflare/OAuth needed on-box.
async function sessionMcpFlags() {
  if (!config.sessionMcp || !config.mcpTokenReadonly) return '';
  const cfg = { mcpServers: { 'cc-deck': { type: 'http', url: `http://127.0.0.1:${config.port}/mcp`, headers: { Authorization: `Bearer ${config.mcpTokenReadonly}` } } } };
  try {
    await mkdir(join(homedir(), '.claude', 'cc-deck'), { recursive: true });
    await writeFile(SESSION_MCP_PATH, JSON.stringify(cfg));
  } catch { return ''; }
  // Single-quote for the shell (send-keys types this into the login shell). Escape
  // any ' in the nudge as '\'' so an apostrophe can't break out of the quoting and
  // turn the rest of the prompt into stray shell tokens (that broke every launch).
  const nudge = SESSION_NUDGE.replace(/'/g, "'\\''");
  return ` --mcp-config ${SESSION_MCP_PATH} --append-system-prompt '${nudge}'`;
}

const exec = promisify(execFile);

// All tmux commands target cc-deck's dedicated socket (`-L <socket>`), so its
// sessions live on their own server — isolated from your personal tmux, and
// safe from "server exits when the last session closes" wiping everything.
export const TMUX_ARGS = ['-L', config.tmuxSocket];

// Run tmux with an argv array (never a shell string — no injection surface).
async function tmux(args) {
  try {
    const { stdout } = await exec('tmux', [...TMUX_ARGS, ...args], { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    // tmux exits non-zero with "no server running" when there are no sessions.
    const msg = (err.stderr || err.message || '').toString();
    // No tmux server yet (no sessions) surfaces in several phrasings.
    if (/no server running|no sessions|can.?t find|error connecting|no such file/i.test(msg)) return '';
    throw err;
  }
}

// Keep the dedicated server alive even with zero sessions, so removing the last
// session never tears the server (and everyone's sessions) down. Also advertise
// truecolor so Claude's 24-bit colors (diff backgrounds, highlights) pass through
// to xterm.js instead of being downsampled to 256. Server options reset when the
// server restarts, so this is (re)applied on startup and on create.
export async function initServer() {
  await tmux(['set-option', '-s', 'exit-empty', 'off']).catch(() => {});
  // Tell tmux the xterm-256color client supports RGB (24-bit) + OSC52 clipboard.
  await tmux(['set-option', '-as', 'terminal-features', ',xterm-256color:RGB:clipboard']).catch(() => {});
  await tmux(['set-option', '-g', 'default-terminal', 'tmux-256color']).catch(() => {});
  await tmux(['set-environment', '-g', 'COLORTERM', 'truecolor']).catch(() => {});
  // Copying in copy-mode emits an OSC52 sequence; the browser terminal turns that
  // into a system-clipboard write, so tmux selections sync to the device clipboard.
  await tmux(['set-option', '-g', 'set-clipboard', 'on']).catch(() => {});
}

// cc-deck color palette (kept in sync with src/client/styles.css).
const C = {
  barBg: '#171717', dim: '#9b9b9b', faint: '#6a6a6a', text: '#ededed',
  accent: '#d97757', accentInk: '#1a0f0a', border: '#2c2c2c', borderHi: '#3f3f3f',
};

// Theme a session's tmux status bar / selection to match the webapp.
async function styleSession(name) {
  const set = (k, v) => tmux(['set-option', '-t', name, k, v]).catch(() => {});
  const setw = (k, v) => tmux(['set-option', '-w', '-t', name, k, v]).catch(() => {});
  await set('status-style', `bg=${C.barBg},fg=${C.dim}`);
  await set('status-left', `#[fg=${C.accentInk},bg=${C.accent},bold] #{@ccdeck_title} #[fg=${C.faint},bg=${C.barBg}] `);
  await set('status-left-length', '40');
  await set('status-right', `#[fg=${C.faint}]%H:%M `);
  await set('message-style', `bg=${C.accent},fg=${C.accentInk}`);
  await set('mode-style', `bg=${C.accent},fg=${C.accentInk}`); // copy-mode selection
  await setw('window-status-current-style', `fg=${C.text},bg=${C.border},bold`);
  await setw('window-status-style', `fg=${C.dim},bg=${C.barBg}`);
  await setw('pane-active-border-style', `fg=${C.borderHi}`);
  await setw('pane-border-style', `fg=${C.border}`);
}

export function isManagedName(name) {
  return typeof name === 'string' && new RegExp(`^${config.prefix}[A-Za-z0-9]+$`).test(name);
}

function assertManaged(name) {
  if (!isManagedName(name)) {
    const e = new Error('Invalid or unmanaged session name');
    e.statusCode = 400;
    throw e;
  }
}

// Resolve a requested directory and ensure it lives under an allowed root.
export async function resolveAllowedDir(dir) {
  const abs = resolve(dir);
  const ok = config.roots.some((root) => abs === root || abs.startsWith(root + '/'));
  if (!ok) {
    const e = new Error(`Directory must be under: ${config.roots.join(', ')}`);
    e.statusCode = 400;
    throw e;
  }
  const s = await stat(abs).catch(() => null);
  if (!s || !s.isDirectory()) {
    const e = new Error('Directory does not exist');
    e.statusCode = 400;
    throw e;
  }
  return abs;
}

const FIELDS = [
  '#{session_name}',
  '#{session_attached}',
  '#{session_activity}',
  '#{session_created}',
  '#{@ccdeck_title}',
  '#{@ccdeck_dir}',
  '#{pane_current_command}',
  '#{@ccdeck_resume}',
  '#{pane_pid}',
].join('\t');

export async function listSessions() {
  const out = await tmux(['list-sessions', '-F', FIELDS]);
  const sessions = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, attached, activity, created, title, dir, paneCmd, resume, panePid] = line.split('\t');
    if (!isManagedName(name)) continue;
    sessions.push({
      name,
      attached: attached === '1' || Number(attached) > 0,
      // tmux activity/created are epoch seconds.
      lastActivity: Number(activity) * 1000 || null,
      created: Number(created) * 1000 || null,
      title: title || name.slice(config.prefix.length),
      dir: dir || '',
      paneCommand: paneCmd || '',
      resumedFrom: resume || null,
      panePid: Number(panePid) || null,
    });
  }
  sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  return sessions;
}

const RESUME_ID_RE = /^[0-9a-fA-F-]{36}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Some setup can only happen once Claude has booted to its prompt: `/rename`
// (the persisted title comes from the slash command, not `--name`) and seeding an
// initial prompt (e.g. a context handoff). Poll for the UI, then type them.
// Fire-and-forget.
async function scheduleBoot(name, { rename, seed }) {
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    let pane;
    try { pane = await tmux(['capture-pane', '-p', '-t', name, '-S', '-25']); } catch { return; }
    if (!pane) continue;
    if (/\? for shortcuts|❯|esc to interrupt/.test(pane)) { // Claude's UI is up
      if (rename) {
        await tmux(['send-keys', '-l', '-t', name, `/rename ${rename}`]).catch(() => {});
        await tmux(['send-keys', '-t', name, 'Enter']).catch(() => {});
      }
      if (seed) {
        if (rename) await sleep(600); // let the /rename submit first
        await tmux(['send-keys', '-l', '-t', name, seed]).catch(() => {});
        await tmux(['send-keys', '-t', name, 'Enter']).catch(() => {});
      }
      return;
    }
  }
}

// Type a single line into a managed session's prompt and submit it. Used to
// inject a context handoff into a running session. Keep `text` single-line —
// embedded newlines would submit early.
export async function sendText(name, text) {
  assertManaged(name);
  const line = (text || '').toString().replace(/[\r\n]+/g, ' ').trim();
  if (!line) return;
  await tmux(['send-keys', '-l', '-t', name, line]).catch(() => {});
  await tmux(['send-keys', '-t', name, 'Enter']).catch(() => {});
}

export async function createSession({ dir, title, resume, fork, seed, browser }) {
  const abs = await resolveAllowedDir(dir);
  const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const name = `${config.prefix}${id}`;
  const cleanTitle = (title || '').toString().slice(0, 120).replace(/[\r\n\t]/g, ' ').trim();

  // Build the launch command; optionally resume a prior Claude session by id.
  // For a fresh session with a custom title, pass it to Claude as --name so the
  // Claude session itself is named (not just cc-deck's label).
  let launch = config.launchCommand;
  if (resume) {
    if (!RESUME_ID_RE.test(resume)) {
      const e = new Error('Invalid resume session id');
      e.statusCode = 400;
      throw e;
    }
    launch = `${config.launchCommand} --resume ${resume}`;
    // Fork = branch into a NEW session id that copies the prior history, leaving
    // the original untouched (vs. plain resume, which appends to the original).
    if (fork) launch += ' --fork-session';
  }

  await tmux(['new-session', '-d', '-s', name, '-c', abs, '-x', '220', '-y', '50']);
  await initServer(); // server is up now — make sure it won't exit when emptied
  await tmux(['set-option', '-t', name, '@ccdeck_title', cleanTitle || abs.split('/').pop() || name]);
  await tmux(['set-option', '-t', name, '@ccdeck_dir', abs]);
  // Tag the source id only for a plain resume (so we can dedup/Open it). A fork
  // is a new, independent session — matched by PID — so we don't tag it as a
  // resume of the original (that would hijack the original's Open/Resume logic).
  if (resume && !fork) await tmux(['set-option', '-t', name, '@ccdeck_resume', resume]);
  await setMouse(name, true);
  await styleSession(name);
  // Launch the CLI inside the login shell so the session survives if claude exits.
  // Prefix COLORTERM=truecolor so Claude emits 24-bit color (diffs, highlights).
  launch += await sessionMcpFlags(); // handoff-aware: read-only cc-deck MCP + nudge
  if (browser) launch += await browserMcpFlag(); // opt-in: drive a logged-in Chrome
  await tmux(['send-keys', '-t', name, `COLORTERM=truecolor ${launch}`, 'Enter']);
  // Once Claude has booted: name a fresh titled session (so the name shows in
  // Claude and `claude --resume`) and/or type a seed prompt. Background.
  const doRename = !resume && cleanTitle;
  if (doRename || seed) scheduleBoot(name, { rename: doRename ? cleanTitle : null, seed }).catch(() => {});
  return name;
}

// Toggle tmux mouse mode + ensure a large scrollback. With mouse ON the browser
// wheel scrolls the pane's history via tmux copy-mode (native, full history);
// with mouse OFF the "fast" scroll path handles scrolling client-side instead.
// Idempotent; safe to call on attach.
export async function setMouse(name, on) {
  if (!isManagedName(name)) return;
  await tmux(['set-option', '-t', name, 'mouse', on ? 'on' : 'off']).catch(() => {});
  await tmux(['set-option', '-t', name, 'history-limit', '50000']).catch(() => {});
  // window-size manual: tmux never auto-sizes the window from attached clients.
  // cc-deck drives the size explicitly (resizeWindow) to match whichever device
  // last interacted — so background preloads on another device can't reshape it.
  await tmux(['set-option', '-w', '-t', name, 'window-size', 'manual']).catch(() => {});
}

// Set the window to a specific size — called when a device the user is actively
// using interacts with the session, so it fits that device dynamically.
export async function resizeWindow(name, cols, rows) {
  if (!isManagedName(name)) return;
  const c = Math.max(20, Math.min(500, Math.round(Number(cols) || 0)));
  const r = Math.max(5, Math.min(300, Math.round(Number(rows) || 0)));
  if (!c || !r) return;
  await tmux(['resize-window', '-t', name, '-x', String(c), '-y', String(r)]).catch(() => {});
}

export async function killSession(name) {
  assertManaged(name);
  await tmux(['kill-session', '-t', name]);
}

export async function renameSession(name, title) {
  assertManaged(name);
  const cleanTitle = (title || '').toString().slice(0, 120).replace(/[\r\n\t]/g, ' ').trim();
  // cc-deck's own display label.
  await tmux(['set-option', '-t', name, '@ccdeck_title', cleanTitle]);
  // Also rename the underlying Claude session via its `/rename` slash command,
  // so the new name shows in Claude itself and in `claude --resume`. Only do this
  // when Claude is actually running in the pane (else it'd type into the shell).
  if (cleanTitle) {
    const cmd = (await tmux(['display-message', '-p', '-t', name, '#{pane_current_command}']).catch(() => '')).trim();
    if (/claude|node/i.test(cmd)) {
      // -l sends the text literally (so titles with key-like words aren't parsed),
      // then a separate Enter submits the slash command.
      await tmux(['send-keys', '-l', '-t', name, `/rename ${cleanTitle}`]).catch(() => {});
      await tmux(['send-keys', '-t', name, 'Enter']).catch(() => {});
    }
  }
}

// The validated working directory of a managed session (for file uploads). Reads
// the @ccdeck_dir option and confirms it still lives under an allowed root.
export async function sessionDir(name) {
  assertManaged(name);
  const dir = (await tmux(['show-options', '-t', name, '-v', '@ccdeck_dir']).catch(() => '')).trim();
  if (!dir) { const e = new Error('Session directory unknown'); e.statusCode = 400; throw e; }
  return resolveAllowedDir(dir);
}

export async function sessionExists(name) {
  if (!isManagedName(name)) return false;
  const out = await tmux(['has-session', '-t', name]).then(() => true).catch(() => false);
  return out;
}

// Last N lines of the active pane, for a card preview.
export async function capturePane(name, lines = 24) {
  assertManaged(name);
  const out = await tmux(['capture-pane', '-p', '-t', name, '-S', `-${lines}`]);
  return out;
}

// Create a new subdirectory `name` under `parent` (for the new-session picker).
// `parent` must already exist under an allowed root; `name` must be a single,
// safe path segment. Returns the absolute path of the (new or existing) folder.
export async function createDir(parent, name) {
  const absParent = await resolveAllowedDir(parent);
  const clean = (name || '').toString().trim();
  if (!clean || clean.length > 80 || clean.startsWith('.') || /[/\\\0]/.test(clean) || clean === '..') {
    const e = new Error('Invalid folder name (no slashes, leading dots, or empty)');
    e.statusCode = 400;
    throw e;
  }
  const abs = join(absParent, clean);
  // Defensive: the result must still resolve under an allowed root.
  const ok = config.roots.some((root) => abs === root || abs.startsWith(root + '/'));
  if (!ok) {
    const e = new Error('Folder must be under an allowed root');
    e.statusCode = 400;
    throw e;
  }
  try {
    await mkdir(abs); // throws EEXIST if it already exists — that's fine to surface
  } catch (err) {
    if (err.code !== 'EEXIST') {
      const e = new Error(`Could not create folder: ${err.message}`);
      e.statusCode = 400;
      throw e;
    }
  }
  return abs;
}

// List immediate subdirectories of a path (for the new-session directory picker).
export async function listDirs(dir) {
  const abs = await resolveAllowedDir(dir);
  const entries = await readdir(abs, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: abs, dirs };
}
