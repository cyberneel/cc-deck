import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';

const exec = promisify(execFile);

// ccburn is installed alongside node (e.g. nvm's global bin). Ensure that dir is
// on PATH so we find it even when launched from a systemd unit with a minimal PATH.
const NODE_BIN_DIR = dirname(process.execPath);
const PATH = `${NODE_BIN_DIR}:${process.env.PATH || ''}`;

let cache = { at: 0, data: null };
const TTL_MS = 15_000;

// Shell out to `ccburn --json --once` for live plan-limit utilization.
// Returns { available, ...ccburnJson } or { available:false, error }.
export async function getBurn() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  let data;
  try {
    const { stdout } = await exec('ccburn', ['--json', '--once'], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PATH },
    });
    const parsed = JSON.parse(stdout);
    data = { available: true, ...parsed };
  } catch (err) {
    data = {
      available: false,
      error: /ENOENT/.test(err.message)
        ? 'ccburn is not installed (npm i -g ccburn)'
        : (err.stderr || err.message || 'ccburn failed').toString().slice(0, 300),
    };
  }
  cache = { at: Date.now(), data };
  return data;
}
