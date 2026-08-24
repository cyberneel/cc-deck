import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const exec = promisify(execFile);

// Non-interactive SSH: fail fast instead of hanging on a password/host-key prompt.
export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new'];
// A printable multi-char delimiter — a literal tab in the -F format gets mangled
// on the SSH → remote-shell → tmux round-trip; this survives it and won't collide
// with tmux field values.
const DELIM = '~|~';
const FMT = ['#{session_name}', '#{session_attached}', '#{session_activity}', '#{pane_current_command}', '#{pane_current_path}'].join(DELIM);

export function resolveRemote(label) {
  return config.remoteHosts.find((h) => h.label === label);
}

// A remote tmux session name is embedded in an SSH shell command, so keep it to
// safe characters (tmux's own names are; this also blocks command injection).
export const isRemoteSessionName = (n) => typeof n === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(n);

let cache = { at: 0, data: [] };
const TTL_MS = 5000;

// Only surface remote tmux sessions actually running a CLI/claude, so a session
// that drops back to a bare shell when you quit claude disappears (instead of
// lingering as a "normal shell without claude"). claude reports its pane command
// as `claude` or `node` (it's a node CLI), same heuristic cc-deck uses locally.
const isCliCommand = (c) => /^(claude|node)$/i.test((c || '').trim());

async function listHost(h) {
  try {
    // `tmux list-sessions` on a host with no server exits non-zero — treat as "no sessions".
    const { stdout } = await exec('ssh', [...SSH_OPTS, h.sshTarget, `tmux list-sessions -F '${FMT}'`], { timeout: 9000, maxBuffer: 1 << 20 });
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [name, attached, activity, cmd, cwd] = line.split(DELIM);
      return {
        remote: true, host: h.label, id: `remote:${h.label}:${name}`, tmuxName: name,
        title: name, dir: cwd || '', paneCommand: cmd || '',
        attached: Number(attached) > 0, lastActivity: Number(activity) * 1000 || null,
      };
    }).filter((s) => isCliCommand(s.paneCommand));
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    if (/no server running|no sessions/i.test(msg)) return []; // reachable, just idle
    return [{ remote: true, host: h.label, error: msg.slice(0, 140).trim() || 'unreachable' }];
  }
}

// List tmux sessions across all configured remote hosts (cached briefly — each is
// an SSH round-trip). Entries are either sessions or a per-host {error} marker.
export async function listRemoteSessions() {
  if (!config.remoteHosts.length) return [];
  if (Date.now() - cache.at < TTL_MS) return cache.data;
  const data = (await Promise.all(config.remoteHosts.map(listHost))).flat();
  cache = { at: Date.now(), data };
  return data;
}
