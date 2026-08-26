import { config } from './config.js';

// Shared-browser coordination. cc-deck is the single always-on hub every session's
// MCP hits, so it holds ONE in-memory registry of which browser tab is claimed by
// whom. The lock is advisory + visible (agents cooperate by each working in their
// own tab), not a hard mutex — that's enough because CDP is multi-tab: collisions
// only happen when two drivers act on the SAME tab.
const registry = new Map(); // targetId -> { note, since }

const cdp = () => config.browserCdp;

async function cdpJson(path) {
  const r = await fetch(`${cdp()}${path}`, { method: path.startsWith('/json/new') || path.startsWith('/json/close') ? 'PUT' : 'GET' });
  if (!r.ok) throw new Error(`CDP ${r.status}`);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

function decorate(p) {
  const r = registry.get(p.id);
  return { target_id: p.id, title: p.title || '', url: p.url || '', claimed_by: r?.note || null, claimed_since: r?.since || null };
}

// Every browser tab, annotated with who (if anyone) has claimed it. Also prunes
// registry entries for tabs that have since closed.
export async function listTabs() {
  const list = await cdpJson('/json/list');
  const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page');
  const live = new Set(pages.map((p) => p.id));
  for (const id of registry.keys()) if (!live.has(id)) registry.delete(id);
  return pages.map(decorate);
}

function findTab(tabs, { target_id, url }) {
  if (target_id) return tabs.find((t) => t.target_id === target_id);
  if (url) return tabs.find((t) => t.url === url) || tabs.find((t) => t.url.startsWith(url));
  return null;
}

// Claim a tab you're driving so others see it's in use. Identify it by target_id
// (from browser_tabs / new_page) or by its url (navigate it there first so the
// match is unambiguous).
export async function claimTab({ target_id, url, note }) {
  const tabs = await listTabs();
  const t = findTab(tabs, { target_id, url });
  if (!t) throw new Error('tab not found — open it (new_page) and navigate it first, then claim by its target_id or url');
  if (t.claimed_by && t.claimed_by !== note) throw new Error(`tab already claimed by: ${t.claimed_by} — open your own tab instead`);
  registry.set(t.target_id, { note: note || 'in use', since: new Date().toISOString() });
  return { ...decorate({ id: t.target_id, title: t.title, url: t.url }) };
}

export async function releaseTab({ target_id, url }) {
  let id = target_id;
  if (!id && url) { const t = findTab(await listTabs().catch(() => []), { url }); id = t?.target_id; }
  return { released: !!(id && registry.delete(id)) };
}
