// Self-host update check: is this git checkout behind its upstream branch? Feeds the
// dashboard's "update" pill; applying it is ./update.sh. Off for hosted tenants
// (config.updateCheck) and silent on non-git installs (Docker has no .git).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const exec = promisify(execFile);
export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
// A background service can't answer prompts: fail fast instead of hanging on ssh/https auth.
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
const git = async (...args) => (await exec('git', args, { cwd: ROOT, env, timeout: 30_000 })).stdout.trim();

let behind = null; // upstream commits not in HEAD; null = unknown/off → no pill

export async function checkUpdate() {
  try {
    await git('fetch', '--quiet');
    behind = Number(await git('rev-list', '--count', 'HEAD..@{u}'));
  } catch {
    behind = null; // offline, no upstream branch, or not a git checkout
  }
  return behind;
}
export const updateBehind = () => behind;

export function startUpdateChecks() {
  if (!config.updateCheck) return;
  setTimeout(checkUpdate, 60_000).unref();
  setInterval(checkUpdate, 6 * 3600_000).unref();
}
