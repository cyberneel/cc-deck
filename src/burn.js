import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const exec = promisify(execFile);
const CCBURN_DB = join(homedir(), '.ccburn', 'history.db');

// Derive ccburn-style pace/status + reset countdown for a scoped weekly limit
// from its raw fields (util 0-1, ISO reset time, window hours).
function paceStatus(util, resetsAt, windowHours) {
  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return { budget_pace: null, status: 'on_pace', resets_in_minutes: null, resets_in_hours: null };
  const winMs = windowHours * 3600_000;
  const now = Date.now();
  const pace = Math.max(0, Math.min(1, (now - (end - winMs)) / winMs)); // elapsed fraction of the window
  // Match ccburn's own thresholds (observed: 0.82× pace = behind, 1.28× = still on-pace).
  const ratio = pace > 0 ? util / pace : 1;
  const status = ratio >= 1.5 ? 'ahead_of_pace' : ratio <= 0.85 ? 'behind_pace' : 'on_pace';
  const mins = Math.max(0, Math.round((end - now) / 60_000));
  return { budget_pace: pace, status, resets_in_minutes: mins < 60 ? mins : null, resets_in_hours: mins >= 60 ? mins / 60 : null };
}

// ccburn's --json surfaces only session + overall weekly, but it stores Anthropic's
// full rate-limit payload — including model-scoped weekly limits (e.g. "Fable",
// whose cap is half the overall weekly) — in its SQLite history. Read the newest
// raw response and pull those scoped weeklies so the pill can show them too.
// Best-effort and fully guarded: no node:sqlite (node < 22.5), no DB, or a schema
// change all just yield []. Generic over model name, so new scoped models show up
// automatically.
async function readScopedWeekly() {
  try {
    const { DatabaseSync } = await import('node:sqlite'); // built-in, node >= 22.5
    const db = new DatabaseSync(CCBURN_DB, { readOnly: true });
    let row;
    try { row = db.prepare("SELECT raw_response FROM usage_snapshots WHERE raw_response IS NOT NULL AND raw_response != '' ORDER BY id DESC LIMIT 1").get(); }
    finally { db.close(); }
    const limits = row?.raw_response && JSON.parse(row.raw_response).limits;
    if (!Array.isArray(limits)) return [];
    return limits
      .filter((l) => l.group === 'weekly' && l.scope?.model?.display_name)
      .map((l) => {
        const util = (l.percent || 0) / 100;
        return { model: l.scope.model.display_name, utilization: util, window_hours: 168, resets_at: l.resets_at, ...paceStatus(util, l.resets_at, 168) };
      });
  } catch { return []; }
}

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
    data = { available: true, ...parsed, scopedWeekly: await readScopedWeekly() };
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
