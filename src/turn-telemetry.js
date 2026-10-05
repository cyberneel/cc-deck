// Per-turn guest RAM/CPU → systems fleet telemetry, for hosted tier sizing — the ccdeck twin of
// Friday's `turn` meta.res. Each CLI's own hooks (wired by providers/claude|codex|agy.js) POST
// each turn's start/end to /api/turn-hook: exact boundaries at zero
// idle cost (polling `claude agents --json` would burn ~0.8 CPU-s per call and skew the very
// numbers we're measuring). Opt-in: inert unless config.telemetry url+token are set (hosted).
// Counts only — the hook body (which carries the prompt) never leaves this module.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { config } from './config.js';

export const enabled = () => !!(config.telemetry.url && config.telemetry.token && config.tenantId);
// The hook's shared key: derived from the app secret so it survives a Polymux restart
// (KillMode=process keeps sessions — and the key baked into their hook settings — alive).
export const hookKey = () => createHmac('sha256', config.secret).update('turn-hook').digest('hex').slice(0, 32);
// The hook command, shared by all three CLIs. Quote-free on purpose: it's spliced into a
// single-quoted `-c` TOML override (codex) and JSON (agy). Engine/event ride in headers because
// agy's hook payload names neither.
export const hookCurl = (engine, event) => `curl -s -m 2 -o /dev/null -H Content-Type:application/json -H X-Turn-Key:${hookKey()} -H X-Turn-Engine:${engine}${event ? ` -H X-Turn-Event:${event}` : ''} --data-binary @- http://127.0.0.1:${config.port}/api/turn-hook || true`;

const turns = new Map(); // session/conversation id -> { engine, t0, mem0, cpu0, peak }
const queue = [];
let sampler = null;

// RAM in use, MiB: MemTotal − MemAvailable (page cache excluded — it's reclaimable).
export function memUsedMib() {
  try {
    const s = readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(s.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]);
    const v = Math.floor((kb('MemTotal') - kb('MemAvailable')) / 1024);
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}
// Busy ticks (USER_HZ=100) over all CPUs: /proc/stat's `cpu` line minus idle + iowait.
export function cpuBusyTicks() {
  try {
    const v = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
    return v.reduce((a, b) => a + b, 0) - v[3] - v[4];
  } catch { return 0; }
}

// 1s peak sampler, alive only while a turn is in flight.
function sample() {
  const m = memUsedMib(), now = Date.now();
  for (const [id, t] of turns) {
    if (now - t.t0 > 30 * 60_000) turns.delete(id); // interrupted (Esc) / killed mid-turn: no Stop comes
    else if (m > t.peak) t.peak = m;
  }
  if (!turns.size) { clearInterval(sampler); sampler = null; }
}

const ENGINES = new Set(['claude', 'codex', 'agy']);

// Start: UserPromptSubmit (claude/codex) or agy's first PreInvocation (it fires per model call,
// so only an untracked conversation starts a turn). End: Stop, all three.
export function onHook(ev, { engine, event } = {}) {
  const id = ev?.session_id ?? ev?.conversationId;
  if (!enabled() || typeof id !== 'string') return;
  event = ev.hook_event_name ?? event;
  if (event === 'UserPromptSubmit' || (event === 'PreInvocation' && !turns.has(id))) {
    const m = memUsedMib();
    turns.set(id, { engine: ENGINES.has(engine) ? engine : 'claude', t0: Date.now(), mem0: m, cpu0: cpuBusyTicks(), peak: m });
    sampler ??= setInterval(sample, 1000);
  } else if (event === 'Stop') {
    const t = turns.get(id);
    if (!t) return;
    turns.delete(id);
    const mem1 = memUsedMib();
    queue.push({
      ts: Date.now(), event_type: 'ccdeck_turn', surface: 'ccdeck', engine: t.engine,
      latency_ms: Date.now() - t.t0, ok: true,
      meta: {
        res: { mem0_mib: t.mem0, mem1_mib: mem1, mem_peak_mib: Math.max(t.peak, mem1), cpu_s: (cpuBusyTicks() - t.cpu0) / 100 },
        inflight: turns.size, // other turns still running — shared RAM/CPU, for attribution
      },
    });
    if (queue.length > 500) queue.shift(); // ponytail: in-memory; a restart drops ≤60s of events
  }
}

async function flush() {
  if (!queue.length) return;
  const events = queue.splice(0);
  try {
    const r = await fetch(config.telemetry.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.telemetry.token}` },
      body: JSON.stringify({ tenant: config.tenantId, source: 'ccdeck', events }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 429 || r.status >= 500) queue.unshift(...events); // transient → retry next tick
  } catch { queue.unshift(...events); }
}

export function startTurnTelemetry() {
  if (!enabled()) return;
  console.log('[polymux] turn telemetry →', config.telemetry.url);
  setInterval(() => { flush().catch(() => {}); }, 60_000);
}
