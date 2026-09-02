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
// Two passes so a directory-shared guess never overrides a confident match:
//   1. by claude PID (the pane's child) or the resumed id — unambiguous.
//   2. cwd fallback, but ONLY when exactly one unused agent is in that directory.
// Guessing among several sessions that share a cwd mislabels them — e.g. a big/idle
// session that `claude agents` doesn't report would otherwise steal a sibling's
// agent (and its title). When we can't match confidently, we leave the session
// unmatched and its cc-deck label (@ccdeck_title) stands.
export function matchAgents(sessions, agents) {
  const used = new Set();
  const take = (pred) => { const a = agents.find((x) => !used.has(x) && pred(x)); if (a) used.add(a); return a; };
  const assign = (s, a) => { s.liveSessionId = a?.sessionId || null; s.claudeStatus = a?.status || null; s.waitingFor = a?.waitingFor || null; };
  const pending = [];
  for (const s of sessions) {
    const kids = s.panePid ? childPids(s.panePid) : [];
    const a = take((x) => kids.includes(x.pid)) || (s.resumedFrom && take((x) => x.sessionId === s.resumedFrom));
    if (a) assign(s, a); else pending.push(s);
  }
  for (const s of pending) {
    const cands = agents.filter((x) => !used.has(x) && x.cwd === s.dir);
    if (cands.length === 1) { used.add(cands[0]); assign(s, cands[0]); }
    else assign(s, null); // ambiguous or none → don't guess; keep the cc-deck label
  }
  return sessions;
}
