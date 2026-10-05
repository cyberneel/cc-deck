// Session cap + slot queue (POLYMUX_MAX_SESSIONS; unset = no cap, nothing here runs).
// A small tenant VM fits only a few CLIs. At the cap, a session Friday started that has sat
// idle is closed to make room: its conversation stays in History and resumes in full. If
// none can go, Friday's start waits in a queue under a reserved name and launches when a
// slot opens. A person starting one from the dashboard gets the "deck is full" error instead.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { config } from './config.js';
import { listSessions, killSession, createSession, newSessionName } from './tmux.js';
import { getAgents, matchAgents } from './agents.js';

const FILE = process.env.POLYMUX_QUEUE_FILE || join(homedir(), '.claude', 'cc-deck', 'queue.json');
const MAX_QUEUE = 10;
const idleSince = new Map(); // session name -> when we first saw it idle
let queue = []; // [{ name, at, args }], oldest first
let draining = false;

// Idle = the CLI exited (the pane is back at its shell) or Claude sits at its prompt.
// Live status is only known for Claude, so a Codex/agy session never looks idle.
const isIdle = (s) => /^-?(ba|z|da|fi)?sh$/.test(s.paneCommand) || (s.claudeStatus === 'idle' && !s.waitingFor);

// The session to close for a slot: one Friday started, nobody attached, idle for idleMs
// (Friday polls a session every 60s to relay its reply, so it gets to read it first).
// Longest idle first. A session a person started is never closed for them.
export function pickEvictable(sessions, idle, now, idleMs = config.slotIdleMs) {
  return sessions
    .filter((s) => s.origin === 'proactive' && !s.attached && idle.has(s.name) && now - idle.get(s.name) >= idleMs)
    .sort((a, b) => idle.get(a.name) - idle.get(b.name))[0] || null;
}

async function observe() {
  const sessions = await listSessions();
  try { matchAgents(sessions, await getAgents()); } catch { /* status unknown → nothing looks idle */ }
  const now = Date.now();
  for (const s of sessions) {
    if (!isIdle(s)) idleSince.delete(s.name);
    else if (!idleSince.has(s.name)) idleSince.set(s.name, now);
  }
  for (const n of [...idleSince.keys()]) if (!sessions.some((s) => s.name === n)) idleSince.delete(n);
  return sessions;
}

// createSession calls this before it launches anything.
// ponytail: no lock, so two starts in the same instant can both pass and overshoot the cap
// by one. Serialise createSession if that ever matters.
export async function ensureSlot() {
  const max = config.maxSessions;
  if (!max) return;
  const sessions = await observe();
  while (sessions.length >= max) {
    const s = pickEvictable(sessions, idleSince, Date.now());
    if (!s) {
      const e = new Error(`This deck runs up to ${max} Deep Session${max === 1 ? '' : 's'} at once and ${max === 1 ? 'it is' : `all ${max} are`} in use. Close one to start another.`);
      e.statusCode = 429; e.code = 'DECK_FULL'; throw e;
    }
    await killSession(s.name);
    console.log(`[polymux] slots: closed idle "${s.title}" (${s.name}) to make room; it stays in History`);
    sessions.splice(sessions.indexOf(s), 1);
    idleSince.delete(s.name);
  }
}

const save = async () => {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(queue), { mode: 0o600 }); // holds Friday's briefs
};

// Start now, or queue when the deck is full → { name, queued } (queued = place in line).
// The name is reserved up front so Friday can link its thread before the session exists.
export async function startOrQueue(args) {
  if (!queue.length) {
    try { return { name: await createSession(args) }; } catch (e) { if (e.code !== 'DECK_FULL') throw e; }
  }
  if (queue.length >= MAX_QUEUE) throw new Error(`this deck is full and ${MAX_QUEUE} Deep Sessions are already waiting for a slot`);
  const name = newSessionName();
  queue.push({ name, at: Date.now(), args });
  await save();
  return { name, queued: queue.length };
}

export const queued = () => queue.map((q) => ({ name: q.name, at: q.at, dir: q.args.dir, title: q.args.title || '', resume: q.args.resume || null }));

// Drop a start that is still waiting (the dashboard's cancel). False if it isn't in line.
export async function cancelQueued(name) {
  if (!queue.some((q) => q.name === name)) return false;
  queue = queue.filter((q) => q.name !== name);
  await save();
  return true;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    await observe(); // keeps the idle clocks running while nothing is queued
    while (queue.length) {
      const q = queue[0];
      try { await createSession({ ...q.args, name: q.name }); } catch (e) {
        if (e.code === 'DECK_FULL') break;
        console.warn(`[polymux] slots: dropped queued ${q.name}: ${e.message}`); // its folder went away
      }
      queue = queue.filter((x) => x !== q); // not shift(): a cancel may have moved the line meanwhile
      await save();
    }
  } finally { draining = false; }
}

// Before the server listens: a start that queues during restore-on-boot must join the saved
// line, not overwrite it, and Friday reads a queued start that isn't listed as cancelled.
export async function loadQueue() {
  if (!config.maxSessions) return;
  try { queue = JSON.parse(await readFile(FILE, 'utf8')); } catch { queue = []; }
  if (!Array.isArray(queue)) queue = [];
}

// After restore-on-boot, so restored sessions take their slots before the queue does.
export function startSlots() {
  if (!config.maxSessions) return;
  console.log(`[polymux] slots: up to ${config.maxSessions} Deep Session(s) at once, ${queue.length} queued`);
  setInterval(() => drain().catch(() => {}), 15_000);
}
