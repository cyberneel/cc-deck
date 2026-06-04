import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Live Anthropic token pricing, pulled from the community-maintained LiteLLM
// dataset (structured JSON with per-model input/output/cache rates). Cached to
// disk with a TTL; falls back to built-in defaults if the fetch ever fails.
const PRICING_URL =
  process.env.CCDECK_PRICING_URL ||
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const TTL_MS = (Number(process.env.CCDECK_PRICING_TTL_HOURS) || 168) * 3600_000; // default 7 days
const CACHE_DIR = process.env.CCDECK_CACHE_DIR || join(homedir(), '.cache', 'cc-deck');
const CACHE_FILE = join(CACHE_DIR, 'pricing.json');

// Per-million-token USD fallback (current Anthropic list prices, Opus 4.5+ tier).
// Only used if the live fetch fails AND there is no cached copy on disk.
export const DEFAULT_PRICING = {
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

function familyOf(model) {
  if (!model) return null;
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return null;
}

// LiteLLM stores per-token costs; convert to per-million and fill cache rates.
function toRate(e) {
  const inPerM = (e.input_cost_per_token || 0) * 1e6;
  return {
    input: inPerM,
    output: (e.output_cost_per_token || 0) * 1e6,
    cacheWrite: e.cache_creation_input_token_cost != null ? e.cache_creation_input_token_cost * 1e6 : inPerM * 1.25,
    cacheRead: e.cache_read_input_token_cost != null ? e.cache_read_input_token_cost * 1e6 : inPerM * 0.1,
  };
}

function buildTable(raw) {
  const models = {};
  for (const [id, e] of Object.entries(raw)) {
    if (e?.litellm_provider !== 'anthropic') continue;
    if (typeof e.input_cost_per_token !== 'number') continue;
    models[id] = toRate(e);
  }
  // Family representative rates (prefer current "-4" generation), used as a
  // fallback for any future model id not present in the dataset yet.
  const families = {};
  for (const fam of ['opus', 'sonnet', 'haiku']) {
    const ids = Object.keys(models).filter((id) => id.includes(fam));
    const pick = ids.find((id) => id.includes(`${fam}-4`)) || ids[0];
    families[fam] = pick ? models[pick] : DEFAULT_PRICING[fam];
  }
  return { models, families };
}

let mem = null; // { fetchedAt, table, source, stale, error? }

async function loadCache() {
  try { return JSON.parse(await readFile(CACHE_FILE, 'utf8')); } catch { return null; }
}
async function saveCache(obj) {
  try { await mkdir(CACHE_DIR, { recursive: true }); await writeFile(CACHE_FILE, JSON.stringify(obj)); } catch { /* */ }
}

async function fetchTable() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(PRICING_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return buildTable(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

// Returns { fetchedAt, table:{models,families}, source, stale } with graceful fallback.
export async function getPricing() {
  const now = Date.now();
  if (mem && now - mem.fetchedAt < TTL_MS) return mem;

  if (!mem) {
    const disk = await loadCache();
    if (disk?.table) mem = { ...disk, stale: now - disk.fetchedAt >= TTL_MS };
    if (mem && !mem.stale) return mem;
  }

  try {
    const table = await fetchTable();
    mem = { fetchedAt: now, table, source: PRICING_URL, stale: false };
    await saveCache({ fetchedAt: now, table, source: PRICING_URL });
  } catch (err) {
    if (mem?.table) { mem.stale = true; mem.error = err.message; return mem; }
    mem = {
      fetchedAt: 0,
      table: { models: {}, families: DEFAULT_PRICING },
      source: 'built-in defaults',
      stale: true,
      error: err.message,
    };
  }
  return mem;
}

// Resolve a per-million rate for a model id: exact match → family rep → default.
export function rateForModel(pricing, model) {
  const t = pricing.table;
  if (t.models[model]) return t.models[model];
  const fam = familyOf(model);
  if (fam) return t.families[fam] || DEFAULT_PRICING[fam];
  return null;
}
