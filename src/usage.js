import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// API list prices in USD per *million* tokens, by model family. These are list
// rates used only to estimate the dollar value of usage for the ROI view; edit
// here if Anthropic's pricing changes.
const PRICING = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

function family(model) {
  if (!model) return null;
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return null;
}

function costOf(fam, u) {
  const p = PRICING[fam];
  if (!p) return 0;
  return (
    ((u.input || 0) * p.input +
      (u.output || 0) * p.output +
      (u.cacheWrite || 0) * p.cacheWrite +
      (u.cacheRead || 0) * p.cacheRead) /
    1_000_000
  );
}

let cache = { at: 0, data: null };
const TTL_MS = 60_000;

// Walk every transcript once, pulling (timestamp, model, usage) from assistant
// messages, and build a flat list of events. Cached for a minute.
async function collectEvents() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const events = [];
  let projectDirs = [];
  try {
    projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    cache = { at: Date.now(), data: events };
    return events;
  }

  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    let names = [];
    try { names = await readdir(join(PROJECTS_DIR, d.name)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      await readFileEvents(join(PROJECTS_DIR, d.name, name), events);
    }
  }
  cache = { at: Date.now(), data: events };
  return events;
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
      const fam = family(o.message?.model);
      if (!u || !fam || !o.timestamp) return;
      events.push({
        t: Date.parse(o.timestamp),
        fam,
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
function addInto(agg, e) {
  agg.input += e.input;
  agg.output += e.output;
  agg.cacheWrite += e.cacheWrite;
  agg.cacheRead += e.cacheRead;
  agg.cost += costOf(e.fam, e);
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
  const events = await collectEvents();
  const now = Date.now();
  const DAY = 86_400_000;

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
  const byModelCycle = { opus: emptyAgg(), sonnet: emptyAgg(), haiku: emptyAgg() };

  // Daily cost for the last 30 days.
  const daily = new Map(); // 'YYYY-MM-DD' -> cost
  for (let i = 29; i >= 0; i--) {
    daily.set(new Date(now - i * DAY).toISOString().slice(0, 10), 0);
  }

  for (const e of events) {
    for (const w of Object.values(windows)) if (e.t >= w.since) addInto(w.agg, e);
    if (e.t >= cycleStart) addInto(byModelCycle[e.fam], e);
    if (e.t >= now - 30 * DAY) {
      const key = new Date(e.t).toISOString().slice(0, 10);
      if (daily.has(key)) daily.set(key, daily.get(key) + costOf(e.fam, e));
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
    byModel: Object.entries(byModelCycle)
      .map(([model, agg]) => ({ model, ...agg, totalTokens: totalTokens(agg) }))
      .filter((m) => m.messages > 0)
      .sort((a, b) => b.cost - a.cost),
    daily: [...daily.entries()].map(([date, cost]) => ({ date, cost })),
    pricing: PRICING,
  };
}
