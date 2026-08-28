// Push cc-deck session-state transitions to Friday's Reach Manager (POST /api/reach) the
// INSTANT they happen — so Friday reacts immediately instead of polling cc-deck every 60s.
// Opt-in: only runs when CCDECK_FRIDAY_REACH_URL is set; standalone cc-deck is unaffected.
// Best-effort: if Friday is unreachable we drop the event (Friday's poll is the backstop).

import { config } from './config.js';
import { listSessions } from './tmux.js';
import { getAgents, matchAgents } from './agents.js';

const last = new Map(); // session name -> last status
let primed = false; // first pass only records the baseline (no startup burst)

// Same mapping the list_sessions MCP tool uses.
function statusOf(s) {
  const claudeAlive = s.paneCommand === 'claude' || !!s.liveSessionId;
  return !claudeAlive ? 'done'
    : s.claudeStatus === 'busy' ? 'running'
    : s.waitingFor ? 'waiting_input'
    : 'idle';
}

// What a transition (from -> to) should tell Friday, or null to stay quiet.
// Push ONLY "needs your input" — the time-sensitive case where instant beats Friday's 60s
// poll. Session finished/idle stays with Friday's poll: it adds detail a generic push
// can't (names the output file of a delegated build), and 60s latency is fine there. The
// key matches Friday's scan_sessions scheme (`ccdeck:<name>:waiting`) so the push and the
// poll coalesce in the Reach Manager instead of double-notifying.
function eventFor(s, from, to) {
  if (to === 'waiting_input' && from !== 'waiting_input') {
    const t = s.title || s.name;
    return {
      key: `ccdeck:${s.name}:waiting`,
      urgency: 'high',
      title: 'cc-deck',
      body: `“${t}” needs your input.`,
      // Make it answerable in Friday: the session to relay the user's reply to + the prompt.
      sessionId: s.liveSessionId || s.resumedFrom || undefined,
      detail: s.waitingFor || undefined,
    };
  }
  return null;
}

async function post(ev) {
  try {
    await fetch(config.fridayReach.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Password': config.fridayReach.password },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* Friday down/unreachable → drop; the 60s poll is the backstop */ }
}

async function tick() {
  let sessions;
  try {
    sessions = await listSessions();
    try { matchAgents(sessions, await getAgents()); } catch { /* status degrades, still usable */ }
  } catch {
    return; // couldn't read sessions this round; try again next tick
  }
  const seen = new Set();
  for (const s of sessions) {
    seen.add(s.name);
    const to = statusOf(s);
    const from = last.get(s.name);
    last.set(s.name, to);
    // Skip the first observation of a session (from===undefined) and no-change ticks;
    // only push real transitions once primed.
    if (!primed || from === undefined || from === to) continue;
    const ev = eventFor(s, from, to);
    if (ev) post(ev);
  }
  // Forget sessions that vanished so a reused name re-primes cleanly.
  for (const name of [...last.keys()]) if (!seen.has(name)) last.delete(name);
  primed = true;
}

// Start the transition monitor (no-op unless a Friday reach url is configured).
export function startReachMonitor() {
  if (!config.fridayReach.url) return;
  console.log('[cc-deck] Friday reach: pushing session transitions to', config.fridayReach.url);
  setInterval(() => { tick().catch(() => {}); }, 7000);
}
