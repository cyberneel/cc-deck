import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { getPricing, rateForModel } from './pricing.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

function isBillableModel(model) {
  // Any real Claude model (opus/sonnet/haiku/fable/… and future families).
  // Excludes '<synthetic>' and empty ids. Priced per exact id via pricing.js.
  return !!model && model.startsWith('claude-');
}

// Dollar cost of one event given a per-million rate object (from pricing.js).
function eventCost(e, rate) {
  if (!rate) return 0;
  return (
    (e.input * rate.input + e.output * rate.output + e.cacheWrite * rate.cacheWrite + e.cacheRead * rate.cacheRead) /
    1_000_000
  );
}

let cache = { at: 0, data: null };
let refreshing = false;
const TTL_MS = 60_000; // scans are cheap now (only changed files re-read), so keep it fresh

// Parsed events per transcript, keyed by mtime+size — so a scan only re-reads the
// handful of files that actually changed, not all ~250MB every time.
const fileCache = new Map(); // path -> { key, events }

export async function scanEvents() {
  const events = [];
  let projectDirs = [];
  try { projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return events; }
  const seen = new Set();
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    let names = [];
    try { names = await readdir(join(PROJECTS_DIR, d.name)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(PROJECTS_DIR, d.name, name);
      let s; try { s = await stat(file); } catch { continue; }
      seen.add(file);
      const key = `${s.mtimeMs}:${s.size}`;
      let hit = fileCache.get(file);
      if (!hit || hit.key !== key) {
        const ev = [];
        await readFileEvents(file, ev); // only unchanged-miss re-reads
        hit = { key, events: ev };
        fileCache.set(file, hit);
      }
      for (const e of hit.events) events.push(e);
    }
  }
  for (const k of fileCache.keys()) if (!seen.has(k)) fileCache.delete(k); // forget deleted files
  return events;
}

// Stale-while-revalidate: serve the cached events instantly and refresh in the
// background, so a full re-scan never sits on the request path (which stalls the
// event loop and queues other endpoints like /api/burn). Only the first-ever
// load blocks. ponytail: SWR + coarse TTL; add per-file mtime skip only if the
// background re-scan still bites.
async function collectEvents() {
  const stale = !cache.data || Date.now() - cache.at >= TTL_MS;
  if (cache.data) {
    if (stale && !refreshing) {
      refreshing = true;
      scanEvents().then((ev) => { cache = { at: Date.now(), data: ev }; }).finally(() => { refreshing = false; });
    }
    return cache.data;
  }
  cache = { at: Date.now(), data: await scanEvents() };
  return cache.data;
}

function readFileEvents(file, events) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    rl.on('line', (line) => {
      // Cheap pre-filter: only assistant messages carry a usage block.
      if (!line || line.indexOf('"usage"') === -1) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      const u = o.message?.usage;
      const model = o.message?.model;
      if (!u || !isBillableModel(model) || !o.timestamp) return;
      events.push({
        t: Date.parse(o.timestamp),
        model,
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      });
    });
    rl.on('close', resolve);
    rl.on('error', resolve);
  });
}

function emptyAgg() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 0 };
}
function addInto(agg, e, cost) {
  agg.input += e.input;
  agg.output += e.output;
  agg.cacheWrite += e.cacheWrite;
  agg.cacheRead += e.cacheRead;
  agg.cost += cost;
  agg.messages += 1;
}
function totalTokens(a) {
  return a.input + a.output + a.cacheWrite + a.cacheRead;
}

// Bounds of the billing cycle containing `now`, for a monthly renewal on `billingDay`
// (1–31, clamped to each month's length). Returns epoch ms for start (inclusive) and
// end (exclusive = next renewal).
function cycleBounds(now, billingDay) {
  const d = new Date(now);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const today = d.getUTCDate();
  const dim = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  // If we haven't reached this month's renewal day yet, the cycle started last month.
  if (today < Math.min(billingDay, dim(y, m))) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  const start = Date.UTC(y, m, Math.min(billingDay, dim(y, m)));
  let ny = y, nm = m + 1;
  if (nm > 11) { nm = 0; ny += 1; }
  const end = Date.UTC(ny, nm, Math.min(billingDay, dim(ny, nm)));
  return { start, end };
}

export async function getUsage(billingDay = 1) {
  const [events, pricing] = await Promise.all([collectEvents(), getPricing()]);
  const now = Date.now();
  const DAY = 86_400_000;

  // Pre-resolve a per-million rate for each distinct model id once.
  const rateCache = new Map();
  const rateOf = (model) => {
    if (!rateCache.has(model)) rateCache.set(model, rateForModel(pricing, model));
    return rateCache.get(model);
  };

  const bd = Math.min(31, Math.max(1, Math.round(Number(billingDay) || 1)));
  const { start: cycleStart, end: cycleEnd } = cycleBounds(now, bd);
  const daysInCycle = Math.max(1, Math.round((cycleEnd - cycleStart) / DAY));
  const daysElapsed = Math.max(1, Math.min(daysInCycle, Math.ceil((now - cycleStart) / DAY)));

  const windows = {
    last24h: { since: now - DAY, agg: emptyAgg() },
    last7d: { since: now - 7 * DAY, agg: emptyAgg() },
    last30d: { since: now - 30 * DAY, agg: emptyAgg() },
    cycle: { since: cycleStart, agg: emptyAgg() },
  };
  const byModelCycle = new Map(); // model id -> agg

  // Daily cost for the last 30 days.
  const daily = new Map(); // 'YYYY-MM-DD' -> cost
  for (let i = 29; i >= 0; i--) {
    daily.set(new Date(now - i * DAY).toISOString().slice(0, 10), 0);
  }

  for (const e of events) {
    const cost = eventCost(e, rateOf(e.model));
    for (const w of Object.values(windows)) if (e.t >= w.since) addInto(w.agg, e, cost);
    if (e.t >= cycleStart) {
      if (!byModelCycle.has(e.model)) byModelCycle.set(e.model, emptyAgg());
      addInto(byModelCycle.get(e.model), e, cost);
    }
    if (e.t >= now - 30 * DAY) {
      const key = new Date(e.t).toISOString().slice(0, 10);
      if (daily.has(key)) daily.set(key, daily.get(key) + cost);
    }
  }

  const cycleCost = windows.cycle.agg.cost;
  const projectedCost = (cycleCost / daysElapsed) * daysInCycle;
  const fmtWindow = (w) => ({ ...w.agg, totalTokens: totalTokens(w.agg) });

  return {
    generatedAt: now,
    totalEvents: events.length,
    windows: {
      last24h: fmtWindow(windows.last24h),
      last7d: fmtWindow(windows.last7d),
      last30d: fmtWindow(windows.last30d),
      cycle: fmtWindow(windows.cycle),
    },
    cycle: {
      billingDay: bd,
      start: cycleStart,
      end: cycleEnd,
      daysElapsed,
      daysInCycle,
      projectedCost,
    },
    byModel: [...byModelCycle.entries()]
      .map(([model, agg]) => ({ model, ...agg, totalTokens: totalTokens(agg) }))
      .filter((m) => m.messages > 0)
      .sort((a, b) => b.cost - a.cost),
    daily: [...daily.entries()].map(([date, cost]) => ({ date, cost })),
    pricing: {
      source: pricing.source,
      fetchedAt: pricing.fetchedAt,
      stale: pricing.stale,
      error: pricing.error || null,
    },
  };
}
