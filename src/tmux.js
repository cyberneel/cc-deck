import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const exec = promisify(execFile);

// Run tmux with an argv array (never a shell string — no injection surface).
async function tmux(args) {
  try {
    const { stdout } = await exec('tmux', args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    // tmux exits non-zero with "no server running" when there are no sessions.
    const msg = (err.stderr || err.message || '').toString();
    // No tmux server yet (no sessions) surfaces in several phrasings.
    if (/no server running|no sessions|can.?t find|error connecting|no such file/i.test(msg)) return '';
    throw err;
  }
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
].join('\t');

export async function listSessions() {
  const out = await tmux(['list-sessions', '-F', FIELDS]);
  const sessions = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, attached, activity, created, title, dir, paneCmd] = line.split('\t');
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
    });
  }
  sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  return sessions;
}

const RESUME_ID_RE = /^[0-9a-fA-F-]{36}$/;

export async function createSession({ dir, title, resume }) {
  const abs = await resolveAllowedDir(dir);
  const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const name = `${config.prefix}${id}`;
  const cleanTitle = (title || '').toString().slice(0, 120).replace(/[\r\n\t]/g, ' ').trim();

  // Build the launch command; optionally resume a prior Claude session by id.
  let launch = config.launchCommand;
  if (resume) {
    if (!RESUME_ID_RE.test(resume)) {
      const e = new Error('Invalid resume session id');
      e.statusCode = 400;
      throw e;
    }
    launch = `${config.launchCommand} --resume ${resume}`;
  }

  await tmux(['new-session', '-d', '-s', name, '-c', abs, '-x', '220', '-y', '50']);
  await tmux(['set-option', '-t', name, '@ccdeck_title', cleanTitle || abs.split('/').pop() || name]);
  await tmux(['set-option', '-t', name, '@ccdeck_dir', abs]);
  await enableMouse(name);
  if (resume) await tmux(['set-option', '-t', name, '@ccdeck_resume', resume]);
  // Launch the CLI inside the login shell so the session survives if claude exits.
  await tmux(['send-keys', '-t', name, launch, 'Enter']);
  return name;
}

// Enable tmux mouse mode + larger scrollback so the browser wheel scrolls the
// pane's history (native tmux copy-mode) instead of xterm.js translating the
// wheel into arrow keys on the alt-screen. Idempotent; safe to call on attach.
export async function enableMouse(name) {
  if (!isManagedName(name)) return;
  await tmux(['set-option', '-t', name, 'mouse', 'on']).catch(() => {});
  await tmux(['set-option', '-t', name, 'history-limit', '50000']).catch(() => {});
}

export async function killSession(name) {
  assertManaged(name);
  await tmux(['kill-session', '-t', name]);
}

export async function renameSession(name, title) {
  assertManaged(name);
  const cleanTitle = (title || '').toString().slice(0, 120).replace(/[\r\n\t]/g, ' ').trim();
  await tmux(['set-option', '-t', name, '@ccdeck_title', cleanTitle]);
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
