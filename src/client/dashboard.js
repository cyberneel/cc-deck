import css from './styles.css';
import { registerServiceWorker, applyUpdate } from './swreg.js';
import { openGraph } from './graph.js';
import { openNewModal as openNewModalShared } from './newsession.js';

// Inject shared styles.
const styleEl = document.createElement('style');
styleEl.textContent = css;
document.head.appendChild(styleEl);

const app = document.getElementById('app');
let view = localStorage.getItem('ccdeck.view') || 'grid'; // grid | list | group
let tab = localStorage.getItem('ccdeck.tab') || 'active'; // active | history | usage
let query = '';
let sessions = [];
let history = [];
let historyTotal = 0;
let historyLoaded = false;
let cfg = { roots: [], launchCommand: 'claude' };

// Collapsed directory groups (collapsed by default in grouped view).
const expandedGroups = new Set();

// Usage / ROI state.
const PLANS = [
  { id: 'pro', label: 'Pro — $20/mo', price: 20 },
  { id: 'max5', label: 'Max 5× — $100/mo', price: 100 },
  { id: 'max20', label: 'Max 20× — $200/mo', price: 200 },
  { id: 'custom', label: 'Custom…', price: null },
];
let planId = localStorage.getItem('ccdeck.plan') || 'max5';
let customPrice = Number(localStorage.getItem('ccdeck.customPrice') || '100');
let billingDay = Math.min(31, Math.max(1, Number(localStorage.getItem('ccdeck.billingDay') || '1')));
function planPrice() {
  if (planId === 'custom') return customPrice || 1;
  return PLANS.find((p) => p.id === planId)?.price ?? 100;
}
let usageData = null;
let burnData = null;
let usageFetchedAt = 0;

// Offer a reload when a new build is deployed (the bundle's version changed).
let appVersion = null;
let pendingWorker = null;
async function checkVersion() {
  try {
    const { v } = await api('/api/version');
    if (appVersion === null) appVersion = v;
    else if (v && v !== appVersion) showUpdateToast();
  } catch { /* */ }
}
function showUpdateToast(worker) {
  if (worker) pendingWorker = worker;
  if (document.getElementById('update-toast')) return;
  const t = document.createElement('div');
  t.id = 'update-toast'; t.className = 'toast';
  t.innerHTML = 'New version available <button class="primary" style="margin-left:8px;padding:5px 12px">Reload</button>';
  t.querySelector('button').addEventListener('click', () => applyUpdate(pendingWorker));
  document.body.appendChild(t);
}
registerServiceWorker((w) => showUpdateToast(w));
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });

async function api(path, opts = {}) {
  // Only declare a JSON content-type when we actually send a body — otherwise
  // Fastify rejects bodyless requests (DELETE/logout) with 400 "body cannot be empty".
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { headers, ...opts });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- helpers ----
function fmtTime(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fmtAbsTime(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function isLive(s) {
  const cmd = s.paneCommand || '';
  return !!s.liveSessionId || /node|claude/i.test(cmd) || (s.lastActivity && Date.now() - s.lastActivity < 15000);
}
// Derive a friendly status from Claude's reported state (claude agents --json).
function statusOf(s) {
  if (s.waitingFor) return { text: /perm/i.test(s.waitingFor) ? 'needs permission' : 'needs you', cls: 'attn' };
  if (s.claudeStatus === 'busy') return { text: 'working', cls: 'live' };
  if (s.claudeStatus === 'idle') return { text: 'ready', cls: 'ready' };
  if (/node|claude/i.test(s.paneCommand || '')) return { text: 'running', cls: 'live' };
  return { text: 'stopped', cls: 'idle' };
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const MODE_LABEL = { auto: 'auto', plan: 'plan', acceptEdits: 'edits', default: 'normal', bypassPermissions: 'bypass' };
function modeChip(s) {
  if (!s.mode) return '';
  return `<span class="mode mode-${esc(s.mode)}" title="Permission mode">${esc(MODE_LABEL[s.mode] || s.mode)}</span>`;
}
function shortDir(d) {
  if (!d) return 'unknown';
  return cfg.home && d.startsWith(cfg.home) ? '~' + d.slice(cfg.home.length) : d;
}

// Subsequence fuzzy match. Returns a score (higher = better) or -1 if no match.
function fuzzyScore(q, text) {
  if (!q) return 0;
  q = q.toLowerCase();
  text = (text || '').toLowerCase();
  let qi = 0, score = 0, run = 0;
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti] === q[qi]) {
      qi++;
      run++;
      score += run; // reward consecutive runs
      if (ti === 0 || /[\s/_.\-]/.test(text[ti - 1])) score += 6; // word-boundary bonus
    } else {
      run = 0;
    }
  }
  return qi === q.length ? score : -1;
}

// Filter+rank a list by the search query over the given searchable-text fn.
function search(items, textOf) {
  if (!query.trim()) return items;
  return items
    .map((it) => ({ it, score: fuzzyScore(query.trim(), textOf(it)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it);
}

function groupByDir(items, dirOf) {
  const map = new Map();
  for (const it of items) {
    const d = dirOf(it) || 'unknown';
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(it);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// Collapsible directory group — collapsed unless the user has expanded it.
function groupHtml(dir, items, cardFn, gridClass) {
  const key = dir || 'unknown';
  const open = expandedGroups.has(key);
  return `<div class="group ${open ? 'open' : ''}">
    <div class="group-head" data-dir="${esc(key)}">
      <span class="chev">${open ? '▾' : '▸'}</span>
      <span class="group-dir">${esc(shortDir(dir))}</span>
      <span class="group-count">${items.length}</span>
    </div>
    ${open ? `<div class="${gridClass}">${items.map(cardFn).join('')}</div>` : ''}
  </div>`;
}
function wireGroupToggles(container) {
  container.querySelectorAll('.group-head').forEach((h) =>
    h.addEventListener('click', () => {
      const key = h.dataset.dir;
      if (expandedGroups.has(key)) expandedGroups.delete(key);
      else expandedGroups.add(key);
      renderBody();
    }),
  );
}

// ---- shell ----
function render() {
  app.innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="dot"></span> cc-deck</div>
      <div class="toggle tabs">
        <button data-tab="active" class="${tab === 'active' ? 'active' : ''}">Active</button>
        <button data-tab="history" class="${tab === 'history' ? 'active' : ''}">History</button>
        <button data-tab="usage" class="${tab === 'usage' ? 'active' : ''}">Usage</button>
      </div>
      <div class="spacer"></div>
      <button class="primary" id="new-btn" title="New session">${matchMedia('(max-width: 700px)').matches ? '+' : '+ New session'}</button>
      <button id="reload-btn" class="icon" title="Reload app">↻</button>
      <button id="logout-btn" title="Log out">⏻</button>
    </div>
    <div class="wrap">
      <div class="stats" id="stats" style="${tab === 'usage' ? 'display:none' : ''}"></div>
      <div class="subbar" style="${tab === 'usage' ? 'display:none' : ''}">
        <div class="search">
          <span class="search-ico">⌕</span>
          <input id="search" type="text" spellcheck="false" autocomplete="off"
            placeholder="Fuzzy search by title, directory, branch…" value="${esc(query)}" />
          <button class="search-clear" id="search-clear" title="Clear" style="${query ? '' : 'display:none'}">✕</button>
        </div>
        <div class="toggle" id="view-toggle">
          <button data-view="grid" class="${view === 'grid' ? 'active' : ''}">▦ Grid</button>
          <button data-view="list" class="${view === 'list' ? 'active' : ''}">☰ List</button>
          <button data-view="group" class="${view === 'group' ? 'active' : ''}">⊞ Group</button>
        </div>
      </div>
      <div id="cards"></div>
    </div>`;

  app.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      localStorage.setItem('ccdeck.tab', tab);
      render();
      if (tab === 'history' && !historyLoaded) refreshHistory();
      if (tab === 'usage') loadUsage();
    }),
  );
  app.querySelectorAll('#view-toggle button').forEach((b) =>
    b.addEventListener('click', () => {
      view = b.dataset.view;
      localStorage.setItem('ccdeck.view', view);
      render();
    }),
  );
  const searchEl = document.getElementById('search');
  searchEl.addEventListener('input', () => {
    query = searchEl.value;
    document.getElementById('search-clear').style.display = query ? '' : 'none';
    renderBody();
  });
  document.getElementById('search-clear').addEventListener('click', () => {
    query = '';
    searchEl.value = '';
    searchEl.focus();
    document.getElementById('search-clear').style.display = 'none';
    renderBody();
  });
  document.getElementById('new-btn').addEventListener('click', openNewModal);
  document.getElementById('reload-btn').addEventListener('click', () => applyUpdate(pendingWorker));
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  renderBody();
}

function renderStats() {
  const el = document.getElementById('stats');
  if (!el) return;
  const running = sessions.filter(isLive).length;
  const attached = sessions.filter((s) => s.attached).length;
  const dirs = new Set(sessions.map((s) => s.dir).filter(Boolean)).size;
  const tile = (label, value, opts = {}) =>
    `<div class="tile ${opts.accent ? 'accent' : ''} ${opts.tab ? 'clickable' : ''}" ${opts.tab ? `data-go="${opts.tab}"` : ''}>
      <div class="tile-val">${value}</div><div class="tile-label">${label}</div></div>`;
  el.innerHTML =
    tile('Active', sessions.length, { tab: 'active', accent: tab === 'active' }) +
    tile('Running', running) +
    tile('Attached', attached) +
    tile('Directories', dirs) +
    tile('Past sessions', historyLoaded ? historyTotal : '…', { tab: 'history', accent: tab === 'history' });
  el.querySelectorAll('.tile.clickable').forEach((t) =>
    t.addEventListener('click', () => {
      tab = t.dataset.go;
      localStorage.setItem('ccdeck.tab', tab);
      render();
      if (tab === 'history' && !historyLoaded) refreshHistory();
    }),
  );
}

// ---- body dispatch ----
function renderBody() {
  if (tab === 'usage') return renderUsage();
  renderStats();
  if (tab === 'history') renderHistory();
  else renderActive();
}

// ---- active sessions ----
function renderActive() {
  const container = document.getElementById('cards');
  if (!container) return;
  if (!sessions.length) {
    container.innerHTML = `<div class="empty">
      <p style="font-size:18px">No Claude sessions running.</p>
      <p class="muted">Launch one with <strong>+ New session</strong> — it starts <code>${esc(cfg.launchCommand)}</code> in the directory you choose.</p>
    </div>`;
    return;
  }
  const filtered = search(sessions, (s) => `${s.title} ${s.dir}`);
  if (!filtered.length) return emptySearch(container);

  if (view === 'group') {
    const groups = groupByDir(filtered, (s) => s.dir);
    container.innerHTML = groups.map(([dir, items]) => groupHtml(dir, items, cardHtml, 'grid')).join('');
    wireGroupToggles(container);
  } else {
    container.innerHTML = `<div class="grid ${view === 'list' ? 'list' : ''}">${filtered.map(cardHtml).join('')}</div>`;
  }
  wireActiveCards(container);
  loadPreviews(view === 'group' ? filtered.filter((s) => expandedGroups.has(s.dir || 'unknown')) : filtered);
}

function wireActiveCards(container) {
  container.querySelectorAll('.card').forEach((el) => {
    const name = el.dataset.name;
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      location.href = `/terminal.html?session=${encodeURIComponent(name)}`;
    });
    el.querySelector('.kill-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = sessions.find((x) => x.name === name);
      if (!confirm(`Kill session "${s.title}"? Claude and its tmux session will be terminated.`)) return;
      await api(`/api/sessions/${name}`, { method: 'DELETE' });
      await refresh();
    });
    el.querySelector('.graph-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.currentTarget;
      openGraph(b.dataset.graph, b.dataset.gtitle, b.dataset.cwd);
    });
    el.querySelector('.rename-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = sessions.find((x) => x.name === name);
      const title = prompt('Rename session', s.title);
      if (title == null) return;
      await api(`/api/sessions/${name}`, { method: 'PATCH', body: JSON.stringify({ title }) });
      await refresh();
    });
  });
}

function cardHtml(s) {
  const st = statusOf(s);
  return `<div class="card" data-name="${esc(s.name)}">
    <div class="card-head"><div class="card-title" title="${esc(s.title)}">${esc(s.title)}</div></div>
    <div class="card-dir" title="${esc(s.dir)}">${esc(shortDir(s.dir))}</div>
    <pre class="preview" data-preview="${esc(s.name)}">…</pre>
    <div class="card-foot">
      <span class="badge ${st.cls}"><span class="pulse"></span>${st.text}</span>
      ${modeChip(s)}
      <span class="faint">${s.attached ? 'attached · ' : ''}${fmtTime(s.lastActivity)}</span>
      <div class="spacer"></div>
      ${s.liveSessionId ? `<button class="icon graph-btn" title="Session graph" data-graph="${esc(s.liveSessionId)}" data-cwd="${esc(s.dir || '')}" data-gtitle="${esc(s.title)}">⎇</button>` : ''}
      <button class="icon rename-btn" title="Rename">✎</button>
      <button class="icon danger kill-btn" title="Kill session">✕</button>
    </div>
  </div>`;
}

function loadPreviews(list) {
  if (view === 'list') return;
  for (const s of list) {
    api(`/api/sessions/${s.name}/preview`)
      .then(({ text }) => {
        const el = document.querySelector(`[data-preview="${CSS.escape(s.name)}"]`);
        if (el) el.textContent = (text || '').replace(/\s+$/, '') || '(empty)';
      })
      .catch(() => {});
  }
}

async function refresh() {
  try {
    const { sessions: list } = await api('/api/sessions');
    sessions = list;
  } catch (e) {
    /* transient */
  }
  if (tab === 'active') renderBody();
  else if (tab === 'usage') {
    if (Date.now() - usageFetchedAt > 60_000) loadUsageData();
    loadBurn(); // server-cached ~15s
  } else renderStats();
}

// ---- history ----
async function refreshHistory() {
  try {
    const data = await api('/api/history');
    history = data.sessions;
    historyTotal = data.total ?? data.sessions.length;
    historyLoaded = true;
    renderStats();
    if (tab === 'history') renderHistory();
  } catch (e) {
    /* ignore */
  }
}

function renderHistory() {
  const container = document.getElementById('cards');
  if (!container) return;
  if (!historyLoaded) {
    container.innerHTML = `<div class="empty"><p class="muted">Loading past sessions…</p></div>`;
    return;
  }
  if (!history.length) {
    container.innerHTML = `<div class="empty"><p style="font-size:18px">No past sessions found.</p>
      <p class="muted">Claude transcripts live in <code>~/.claude/projects</code>.</p></div>`;
    return;
  }
  rebuildLiveMap(); // which past sessions are currently running (so we Open, not Resume)
  const filtered = search(history, (s) => `${s.title} ${s.cwd} ${s.gitBranch}`);
  if (!filtered.length) return emptySearch(container);

  if (view === 'group') {
    const groups = groupByDir(filtered, (s) => s.cwd);
    container.innerHTML = groups.map(([dir, items]) => groupHtml(dir, items, historyCardHtml, 'grid list')).join('');
    wireGroupToggles(container);
  } else {
    container.innerHTML = `<div class="grid ${view === 'grid' ? '' : 'list'}">${filtered.map(historyCardHtml).join('')}</div>`;
  }
  wireHistoryCards(container);
}

// Map each running session's Claude id -> the active cc-deck session showing it.
let liveClaudeMap = new Map();
function rebuildLiveMap() {
  liveClaudeMap = new Map();
  for (const s of sessions) {
    if (s.liveSessionId) liveClaudeMap.set(s.liveSessionId, s.name);
    if (s.resumedFrom) liveClaudeMap.set(s.resumedFrom, s.name);
  }
}

function wireHistoryCards(container) {
  container.querySelectorAll('.card').forEach((el) => {
    const id = el.dataset.id;
    const s = history.find((x) => x.sessionId === id);
    const openName = el.dataset.open || null; // already running -> open that session
    const go = async () => {
      if (openName) { location.href = `/terminal.html?session=${encodeURIComponent(openName)}`; return; }
      if (!s.cwd) return;
      const btn = el.querySelector('.resume-btn');
      btn.disabled = true; btn.textContent = 'Resuming…';
      try {
        const { name } = await api('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ dir: s.cwd, title: s.title, resume: s.sessionId }),
        });
        location.href = `/terminal.html?session=${encodeURIComponent(name)}`;
      } catch (e) {
        btn.disabled = false; btn.textContent = '▶ Resume';
        alert('Could not resume: ' + e.message);
      }
    };
    el.addEventListener('click', (e) => { if (!e.target.closest('button')) go(); });
    el.querySelector('.resume-btn, .open-btn')?.addEventListener('click', (e) => { e.stopPropagation(); go(); });
    el.querySelector('.graph-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.currentTarget;
      openGraph(b.dataset.graph, b.dataset.gtitle, b.dataset.cwd);
    });
    el.querySelector('.fork-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.currentTarget;
      forkFrom(b.dataset.fork, b.dataset.cwd, b.dataset.gtitle, b);
    });
  });
}

// git-branch glyph (inline SVG so it renders identically everywhere).
const FORK_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="5" r="1.5"/><path d="M4 4.5v7M4 8h4a2 2 0 0 0 2-2V6.5"/></svg>';

// Fork a session into a NEW one that copies its context (claude --fork-session),
// then jump into it. Used from history cards and the graph viewer.
async function forkFrom(resume, dir, title, btn) {
  if (!dir) { alert('No recorded directory for this session — can’t fork.'); return; }
  if (btn) btn.disabled = true;
  try {
    const { name } = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ dir, resume, fork: true, title: `${title || 'session'} (fork)` }),
    });
    location.href = `/terminal.html?session=${encodeURIComponent(name)}`;
  } catch (e) {
    if (btn) btn.disabled = false;
    alert('Fork failed: ' + e.message);
  }
}

function historyCardHtml(s) {
  const noCwd = !s.cwd;
  const runningName = liveClaudeMap.get(s.sessionId) || null;
  const graphBtn = `<button class="icon graph-btn" title="Session graph" data-graph="${esc(s.sessionId)}" data-cwd="${esc(s.cwd || '')}" data-gtitle="${esc(s.title)}">⎇</button>`;
  const forkBtn = noCwd ? '' : `<button class="icon fork-btn" title="Fork into a new session (copies this session's context)" data-fork="${esc(s.sessionId)}" data-cwd="${esc(s.cwd || '')}" data-gtitle="${esc(s.title)}">${FORK_ICON}</button>`;
  const foot = runningName
    ? `<span class="badge live"><span class="pulse"></span>running</span><div class="spacer"></div>
       ${graphBtn}${forkBtn}<button class="primary open-btn">▶ Open</button>`
    : `${modeChip(s)}<span class="faint">${fmtAbsTime(s.lastModified)} · ${s.sizeKb} KB</span><div class="spacer"></div>
       ${graphBtn}${forkBtn}<button class="primary resume-btn" ${noCwd ? 'disabled title="No recorded directory"' : ''}>▶ Resume</button>`;
  return `<div class="card hist ${runningName ? 'isrunning' : ''}" data-id="${esc(s.sessionId)}" ${runningName ? `data-open="${esc(runningName)}"` : ''}>
    <div class="card-head">
      <div style="flex:1;min-width:0">
        <div class="card-title" title="${esc(s.title)}">${esc(s.title)}</div>
        <div class="hist-dir">${esc(shortDir(s.cwd))}${s.gitBranch ? ` · ${esc(s.gitBranch)}` : ''}</div>
      </div>
    </div>
    <div class="card-foot">${foot}</div>
  </div>`;
}

function emptySearch(container) {
  container.innerHTML = `<div class="empty"><p class="muted">No matches for “${esc(query)}”.</p></div>`;
}

// ---- usage / ROI ----
function money(n) {
  if (!isFinite(n)) return '$0';
  if (n >= 1000) return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return '$' + n.toFixed(2);
}
function tokensFmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function paceEmoji(s) {
  return s === 'ahead_pace' ? '🚨' : s === 'on_pace' ? '🔥' : '🧊';
}

async function loadUsage() {
  await Promise.all([loadUsageData(), loadBurn()]);
}
async function loadUsageData() {
  try { usageData = await api(`/api/usage?billingDay=${billingDay}`); usageFetchedAt = Date.now(); } catch { /* */ }
  if (tab === 'usage') renderUsage();
}
async function loadBurn() {
  try { burnData = await api('/api/burn'); } catch { /* */ }
  if (tab === 'usage') renderUsage();
}

function renderUsage() {
  const c = document.getElementById('cards');
  if (!c) return;
  const u = usageData;
  const price = planPrice();
  const planOpts = PLANS.map((p) => `<option value="${p.id}" ${p.id === planId ? 'selected' : ''}>${p.label}</option>`).join('');

  let html = `<div class="usage">
    <div class="usage-head">
      <div class="plan-pick">
        <label class="faint">Plan</label>
        <select id="plan-select">${planOpts}</select>
        ${planId === 'custom' ? `<input id="custom-price" type="number" min="1" value="${customPrice}" /> <span class="faint">$/mo</span>` : ''}
        <label class="faint" style="margin-left:8px">Renews on day</label>
        <input id="billing-day" type="number" min="1" max="31" value="${billingDay}" title="Day of month your plan renews" />
      </div>
      <button id="usage-refresh" class="icon" title="Refresh">↻</button>
    </div>`;

  if (!u) {
    html += `<div class="empty"><p class="muted">Crunching your transcripts…</p></div></div>`;
    c.innerHTML = html;
    wireUsage();
    return;
  }

  const cyc = u.windows.cycle.cost;
  const multiple = cyc / price;
  const pct = Math.min(100, multiple * 100);
  const broke = multiple >= 1;
  const dfmt = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const cycStart = dfmt(u.cycle.start);
  const cycEnd = dfmt(u.cycle.end);

  html += `<div class="roi ${broke ? 'good' : ''}">
    <div class="roi-label">API-equivalent value used this billing cycle <span class="faint">(since ${cycStart})</span></div>
    <div class="roi-value">${money(cyc)} <span class="roi-of">/ ${money(price)} plan</span></div>
    <div class="roi-bar"><div class="roi-fill ${broke ? 'good' : ''}" style="width:${pct}%"></div></div>
    <div class="roi-verdict ${broke ? 'good' : ''}">${broke
      ? `✓ Broken even — you've returned <strong>${multiple.toFixed(1)}×</strong> the subscription this cycle`
      : `<strong>${pct.toFixed(0)}%</strong> to break-even — ${money(price - cyc)} more value needed`}</div>
    <div class="faint">On pace for ${money(u.cycle.projectedCost)} this cycle · day ${u.cycle.daysElapsed}/${u.cycle.daysInCycle}, renews ${cycEnd}</div>
  </div>`;

  html += `<div class="usage-tiles">
    ${usageTile('Last 24h', money(u.windows.last24h.cost))}
    ${usageTile('Last 7 days', money(u.windows.last7d.cost))}
    ${usageTile('Last 30 days', money(u.windows.last30d.cost))}
    ${usageTile('Messages this cycle', u.windows.cycle.messages.toLocaleString())}
  </div>`;

  html += renderBurnCards();
  html += renderDailyBars(u.daily);

  const tot = u.byModel.reduce((a, m) => {
    a.messages += m.messages; a.input += m.input; a.output += m.output;
    a.cache += m.cacheWrite + m.cacheRead; a.total += m.totalTokens; a.cost += m.cost;
    return a;
  }, { messages: 0, input: 0, output: 0, cache: 0, total: 0, cost: 0 });

  html += `<div class="panel"><h3>By model <span class="faint">(this billing cycle)</span></h3>
    <table class="mtable"><thead><tr><th>Model</th><th>Messages</th><th>Input</th><th>Output</th><th>Cache</th><th>Total</th><th>API value</th></tr></thead>
    <tbody>${u.byModel.map((m) =>
      `<tr><td>${esc(m.model)}</td><td>${m.messages.toLocaleString()}</td><td>${tokensFmt(m.input)}</td><td>${tokensFmt(m.output)}</td><td>${tokensFmt(m.cacheWrite + m.cacheRead)}</td><td>${tokensFmt(m.totalTokens)}</td><td>${money(m.cost)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td>${tot.messages.toLocaleString()}</td><td>${tokensFmt(tot.input)}</td><td>${tokensFmt(tot.output)}</td><td>${tokensFmt(tot.cache)}</td><td>${tokensFmt(tot.total)}</td><td>${money(tot.cost)}</td></tr></tfoot></table>
    <p class="faint">Estimated by applying Anthropic API list prices (including cache read/write rates) to your actual token usage. Your subscription isn't billed per token — this is what the same usage would cost on the pay-as-you-go API.<br>${pricingNote(u.pricing)}</p>
  </div></div>`;

  c.innerHTML = html;
  wireUsage();
}

function usageTile(label, val) {
  return `<div class="tile"><div class="tile-val">${val}</div><div class="tile-label">${label}</div></div>`;
}

function pricingNote(p) {
  if (!p) return '';
  const isLive = p.source && p.source.startsWith('http');
  const when = p.fetchedAt ? new Date(p.fetchedAt).toLocaleDateString() : 'n/a';
  if (!isLive) return `Prices: built-in fallback${p.error ? ` (live fetch failed: ${esc(p.error)})` : ''}.`;
  const host = (() => { try { return new URL(p.source).host; } catch { return p.source; } })();
  return `Prices: live from ${esc(host)}, updated ${when}${p.stale ? ' (stale — using cached)' : ''}.`;
}

function renderBurnCards() {
  const b = burnData;
  if (!b) return `<div class="panel"><h3>Plan limits — live</h3><p class="muted">Loading ccburn…</p></div>`;
  if (!b.available) {
    return `<div class="panel"><h3>Plan limits — live <span class="faint">(ccburn)</span></h3>
      <p class="muted">ccburn unavailable: ${esc(b.error || 'unknown')}</p></div>`;
  }
  const lim = b.limits || {};
  const card = (name, l) => {
    if (!l) return '';
    const pct = (l.utilization || 0) * 100;
    const resets = l.resets_in_minutes != null ? `${l.resets_in_minutes}m`
      : l.resets_in_hours != null ? `${l.resets_in_hours.toFixed(0)}h` : '—';
    return `<div class="limit">
      <div class="limit-top"><span>${name}</span><span>${paceEmoji(l.status)} ${pct.toFixed(0)}%</span></div>
      <div class="limit-bar"><div class="limit-fill" style="width:${Math.min(100, pct)}%"></div></div>
      <div class="faint">resets in ${resets} · budget pace ${((l.budget_pace || 0) * 100).toFixed(0)}%</div>
    </div>`;
  };
  return `<div class="panel"><h3>Plan limits — live <span class="faint">(ccburn)</span></h3>
    <div class="limits">${card('Session (5h)', lim.session)}${card('Weekly', lim.weekly)}${lim.monthly ? card('Monthly', lim.monthly) : ''}</div>
    ${b.recommendation ? `<p class="faint">recommendation: ${esc(b.recommendation)}</p>` : ''}</div>`;
}

function renderDailyBars(daily) {
  const max = Math.max(0.01, ...daily.map((d) => d.cost));
  const bars = daily.map((d) => {
    const h = Math.max(2, Math.round((d.cost / max) * 100));
    return `<div class="bar" title="${d.date}: ${money(d.cost)}"><div class="bar-fill" style="height:${h}%"></div></div>`;
  }).join('');
  return `<div class="panel"><h3>Daily API value <span class="faint">(last 30 days)</span></h3><div class="bars">${bars}</div></div>`;
}

function wireUsage() {
  const sel = document.getElementById('plan-select');
  sel?.addEventListener('change', () => {
    planId = sel.value;
    localStorage.setItem('ccdeck.plan', planId);
    renderUsage();
  });
  const cp = document.getElementById('custom-price');
  cp?.addEventListener('change', () => {
    customPrice = Number(cp.value) || 1;
    localStorage.setItem('ccdeck.customPrice', String(customPrice));
    renderUsage();
  });
  const bdEl = document.getElementById('billing-day');
  bdEl?.addEventListener('change', () => {
    billingDay = Math.min(31, Math.max(1, Number(bdEl.value) || 1));
    localStorage.setItem('ccdeck.billingDay', String(billingDay));
    loadUsageData(); // recompute the cycle window server-side
  });
  document.getElementById('usage-refresh')?.addEventListener('click', () => {
    usageData = null; burnData = null;
    renderUsage();
    loadUsageData();
    loadBurn();
  });
}

// ---- new session modal (shared with the terminal sidebar) ----
function openNewModal() {
  openNewModalShared({ api, cfg, onCreated: (name) => { location.href = `/terminal.html?session=${encodeURIComponent(name)}`; } });
}

// ---- boot ----
(async () => {
  try { cfg = await api('/api/config'); } catch { /* defaults */ }
  await refresh();
  render();
  refreshHistory(); // populate the "Past sessions" stat + history tab data
  if (tab === 'usage') loadUsage();
  checkVersion();
  setInterval(refresh, 4000);
  setInterval(checkVersion, 30000);
})();
