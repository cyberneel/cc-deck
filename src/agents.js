import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { readFileSync, openSync, readSync, fstatSync, closeSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { swr } from './swr.js';
import { getProvider } from './providers/index.js';

const exec = promisify(execFile);

// Direct child PIDs of a process (the pane shell's child is the claude process).
function childPids(pid) {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
// A PARKED interactive session (its conversation handed to a background job) is left
// out of `claude agents`; its registry file names the job it parked into (parkedJobId)
// and keeps sessionId = the full-context main conversation the pane came from.
function registry(pid) {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
}
// Pane title minus Claude's leading status glyph ("✳ Friday (ctx)" → "Friday (ctx)").
export function shownName(title) {
  return (title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}
// The CLI reports "busy" while a background subagent/workflow runs, even after the turn that
// started it ended (and posted, say, a status update). The transcript knows: its last turn
// entry is system/turn_duration once the turn is over. Other system notes and non-turn lines
// (attachments, queue ops) are skipped; a user/assistant line means the turn is still live.
export function turnEnded(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.type === 'user' || d.type === 'assistant') return false;
    if (d.type === 'system' && d.subtype === 'turn_duration') return true;
  }
  return false;
}
// ponytail: reads the last 32KB per busy session per poll; cache on mtime if that ever shows up.
function busyInBackground(a) {
  if (a?.status !== 'busy' || !a.cwd || !a.sessionId) return false;
  const t = tail(join(homedir(), '.claude', 'projects', a.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${a.sessionId}.jsonl`));
  return !!t && turnEnded(t.lines);
}
// A file's last 32KB as lines; `whole` when that is all of it.
function tail(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, len = Math.min(size, 32 * 1024), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return { lines: buf.toString('utf8').split('\n'), whole: len === size };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
const descendants = (pid) => childPids(pid).flatMap((c) => [c, ...descendants(c)]);
// Codex/agy aren't in `claude agents`; their own transcript stands in. The provider spots it among
// the files the pane's processes hold open (exact even with several sessions in one dir); newest
// wins if they hold more than one. Its end says busy or idle, and its id is what resume takes.
export function cliTranscript(s) {
  const p = getProvider(s.kind);
  let best = null;
  for (const pid of p.transcriptOf && s.panePid ? descendants(s.panePid) : []) {
    let fds;
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let hit;
      try { hit = p.transcriptOf(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (hit) hit.mtime = statSync(hit.file).mtimeMs; } catch { continue; }
      if (hit && (!best || hit.mtime > best.mtime)) best = hit;
    }
  }
  return best;
}
// ponytail: no waiting_input for codex/agy (an approval prompt reads as running, so nothing relays
// early); add it from their menu screens if Friday needs to answer them.
function assignCli(s) {
  const t = cliTranscript(s);
  const tl = t && tail(t.file);
  const ended = tl ? getProvider(s.kind).turnEnded(tl.lines) : null;
  // No turn marker in the last 32KB: a long turn's output, unless that is the whole file (no turn yet).
  const busy = ended === null ? !!tl && !tl.whole : !ended;
  Object.assign(s, { liveSessionId: t?.id || null, claudeStatus: t ? (busy ? 'busy' : 'idle') : null, waitingFor: null, background: false, transcript: t?.file || null });
}
// The deck status Friday sees (list_sessions, reach-emit).
export function deckStatus(s) {
  const claudeAlive = s.paneCommand === 'claude' || !!s.liveSessionId;
  return !claudeAlive ? 'done'
    : s.claudeStatus === 'busy' && !s.background ? 'running'
    : s.waitingFor ? 'waiting_input'
    : 'idle';
}

// claude lives alongside node (nvm bin); ensure it's found under a minimal PATH.
const PATH = `${dirname(process.execPath)}:${process.env.PATH || ''}`;

// Live interactive Claude sessions with their status, via `claude agents --json`.
// Each: { pid, cwd, kind, startedAt, sessionId, status, waitingFor? }.
// The exec takes ~0.7s, longer than the dashboard/terminal polls are apart, so it
// runs behind swr: polls get the last result instantly (≤10s old), one exec at a time.
export const getAgents = swr(async () => {
  try {
    const { stdout } = await exec('claude', ['agents', '--json'], {
      timeout: 12_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH },
    });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed; // background jobs kept: a parked pane maps to its job
  } catch { /* claude unavailable / older version — degrade gracefully */ }
  return [];
}, 2500, 10_000);

// Attach each Polymux session's live Claude status by matching it to an agent.
// Two passes so a directory-shared guess never overrides a confident match:
//   1. by claude PID (the pane's child), the resumed id, or the job a parked pane
//      handed off to — unambiguous.
//   2. cwd fallback, but ONLY when exactly one unused agent is in that directory.
// Guessing among several sessions that share a cwd mislabels them — e.g. a big/idle
// session that `claude agents` doesn't report would otherwise steal a sibling's
// agent (and its title). When we can't match confidently, we leave the session
// unmatched and its Polymux label (@ccdeck_title) stands.
export function matchAgents(sessions, all) {
  const agents = all.filter((a) => a.kind === 'interactive' || !a.kind);
  const jobsById = new Map(all.filter((a) => a.kind === 'background' && a.id).map((a) => [a.id, a]));
  const used = new Set();
  const take = (pred) => { const a = agents.find((x) => !used.has(x) && pred(x)); if (a) used.add(a); return a; };
  // `background`: busy only with delegated work (see busyInBackground). claudeStatus stays
  // "busy" so slots never close it.
  const assign = (s, a) => { s.liveSessionId = a?.sessionId || null; s.claudeStatus = a?.status || null; s.waitingFor = a?.waitingFor || null; s.background = busyInBackground(a); };
  const pending = [];
  for (const s of sessions) {
    if (s.kind && s.kind !== 'claude') { assignCli(s); continue; } // never borrows a Claude agent by cwd
    const kids = s.panePid ? childPids(s.panePid) : [];
    let a = take((x) => kids.includes(x.pid)) || (s.resumedFrom && take((x) => x.sessionId === s.resumedFrom));
    const reg = !a && kids.map(registry).find((r) => r?.parkedJobId);
    // parkedJobId is set once at park time; the pane can later attach to another job,
    // so prefer the job its title names (names are unique across live jobs).
    if (reg) {
      const shown = shownName(s.paneTitle);
      a = [...jobsById.values()].find((j) => j.name && j.name === shown) || jobsById.get(reg.parkedJobId);
      // The pane is showing a background job (summary-seeded context), not the main
      // conversation → the UI offers "back to main" (POST /api/sessions/:name/main).
      if (reg.sessionId && reg.sessionId !== a?.sessionId) {
        s.parked = { main: reg.sessionId, job: a?.id || reg.parkedJobId, jobName: a?.name || null };
      }
    }
    if (a) assign(s, a); else pending.push(s);
  }
  for (const s of pending) {
    const cands = agents.filter((x) => !used.has(x) && x.cwd === s.dir);
    if (cands.length === 1) { used.add(cands[0]); assign(s, cands[0]); }
    else assign(s, null); // ambiguous or none → don't guess; keep the Polymux label
  }
  return sessions;
}
