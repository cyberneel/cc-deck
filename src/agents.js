import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';

const exec = promisify(execFile);

// Direct child PIDs of a process (the pane shell's child is the claude process).
function childPids(pid) {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
// claude lives alongside node (nvm bin); ensure it's found under a minimal PATH.
const PATH = `${dirname(process.execPath)}:${process.env.PATH || ''}`;

let cache = { at: 0, data: [] };
const TTL_MS = 2500;

// Live interactive Claude sessions with their status, via `claude agents --json`.
// Each: { pid, cwd, kind, startedAt, sessionId, status, waitingFor? }.
export async function getAgents() {
  if (Date.now() - cache.at < TTL_MS) return cache.data;
  let data = [];
  try {
    const { stdout } = await exec('claude', ['agents', '--json'], {
      timeout: 12_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH },
    });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) data = parsed.filter((a) => a.kind === 'interactive' || !a.kind);
  } catch {
    data = []; // claude unavailable / older version — degrade gracefully
  }
  cache = { at: Date.now(), data };
  return data;
}

// Attach each cc-deck session's live Claude status by matching it to an agent.
// Match by the claude PID (the pane shell's child) first — unambiguous even when
// several sessions share a directory — then by resumed id, then by cwd.
export function matchAgents(sessions, agents) {
  const used = new Set();
  const take = (pred) => { const a = agents.find((x) => !used.has(x) && pred(x)); if (a) used.add(a); return a; };
  for (const s of sessions) {
    const kids = s.panePid ? childPids(s.panePid) : [];
    const a =
      take((x) => kids.includes(x.pid)) ||
      (s.resumedFrom && take((x) => x.sessionId === s.resumedFrom)) ||
      take((x) => x.cwd === s.dir);
    s.liveSessionId = a?.sessionId || null;
    s.claudeStatus = a?.status || null; // 'busy' | 'idle' | ...
    s.waitingFor = a?.waitingFor || null;
  }
  return sessions;
}
