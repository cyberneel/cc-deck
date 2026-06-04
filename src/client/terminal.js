import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import css from './styles.css';

const styleEl = document.createElement('style');
styleEl.textContent = css;
document.head.appendChild(styleEl);

const params = new URLSearchParams(location.search);
let currentSession = params.get('session');

const isMobile = matchMedia('(max-width: 700px)').matches;
let scrollMode = localStorage.getItem('ccdeck.scroll') || 'tmux';
// On phones the sidebar is an overlay drawer — start it closed so the terminal is full-width.
let sidebarOpen = isMobile ? false : localStorage.getItem('ccdeck.sidebar') !== 'closed';
let ctrlArm = false; // sticky Ctrl for the on-screen key bar

// How many sessions to keep warm (current + most-recent others).
const WARM = 3;

let mru = [];
try { mru = JSON.parse(localStorage.getItem('ccdeck.mru') || '[]'); } catch { mru = []; }
function bumpMru(name) {
  mru = [name, ...mru.filter((n) => n !== name)];
  localStorage.setItem('ccdeck.mru', JSON.stringify(mru.slice(0, 50)));
}
if (currentSession) bumpMru(currentSession);

let sessions = [];
const lastSeen = {};
let baselined = false;

document.body.innerHTML = `
  <div id="app-term" class="${sidebarOpen ? '' : 'collapsed'}">
    <aside id="sidebar">
      <div class="sb-head"><span>Sessions</span><button id="sb-collapse" class="icon" title="Collapse">«</button></div>
      <div id="sb-list"></div>
      <div class="sb-foot faint">Alt+\` to cycle · Alt+1–9 to jump</div>
    </aside>
    <div id="sb-backdrop"></div>
    <div id="main">
      <div class="term-bar">
        <button id="sb-toggle" class="icon" title="Toggle sidebar (sessions)">☰<span id="sb-badge" class="sb-badge" style="display:none"></span></button>
        <a href="/" title="Back to dashboard">←</a>
        <span class="title" id="title">${currentSession || 'session'}</span>
        <div class="spacer" style="flex:1"></div>
        <button id="scroll-toggle" class="icon" title="Scroll mode — tmux: full history; fast: smooth local scroll"></button>
        <span class="status" id="status">connecting…</span>
      </div>
      <div id="terminal"></div>
      <div class="keybar" id="keybar"></div>
    </div>
  </div>
  <div id="switcher" class="switcher" style="display:none"><div class="sw-box" id="sw-box"></div></div>`;

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const appEl = document.getElementById('app-term');
const termHost = document.getElementById('terminal');

function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = `status ${cls || ''}`; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const TERM_OPTS = {
  fontFamily: "'JetBrains Mono','SF Mono','Fira Code',ui-monospace,monospace",
  fontSize: isMobile ? 12 : 13, lineHeight: 1.0, cursorBlink: true, scrollback: 10000, allowProposedApi: true,
  theme: {
    background: '#0a0d12', foreground: '#e6edf3', cursor: '#d97757', selectionBackground: '#2a3344',
    black: '#0a0d12', brightBlack: '#5c6877', red: '#ff8d85', brightRed: '#ff8d85',
    green: '#5cb87a', brightGreen: '#5cb87a', yellow: '#e0c060', brightYellow: '#e0c060',
    blue: '#6ea8fe', brightBlue: '#6ea8fe', magenta: '#c099ff', brightMagenta: '#c099ff',
    cyan: '#5fd3d3', brightCyan: '#5fd3d3', white: '#e6edf3', brightWhite: '#ffffff',
  },
};

function shortcutGuard(e) {
  if (e.type !== 'keydown') return true;
  if (e.ctrlKey && e.key === 'Tab') return false;
  if (e.altKey && e.code === 'Backquote') return false;
  if (e.altKey && /^[1-9]$/.test(e.key)) return false;
  return true;
}

// ---- pane pool: one warm xterm + ws per kept-alive session ----
const panes = new Map(); // name -> pane
let gCols = 80;
let gRows = 24;

function makePane(name) {
  const wrap = document.createElement('div');
  wrap.className = 'pane';
  wrap.style.cssText = 'position:absolute;inset:0;display:none;';
  termHost.appendChild(wrap);

  const term = new Terminal(TERM_OPTS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => { webgl.dispose(); try { term.loadAddon(new CanvasAddon()); } catch { /* */ } });
    term.loadAddon(webgl);
  } catch { try { term.loadAddon(new CanvasAddon()); } catch { /* */ } }
  term.attachCustomKeyEventHandler(shortcutGuard);
  term.resize(gCols, gRows);

  const pane = { name, wrap, term, fit, ws: null, dispose: false, manual: false, rc: null };
  term.onData((d) => {
    // Sticky Ctrl (from the mobile key bar): fold the next typed char to a control code.
    if (ctrlArm && d.length === 1) { d = String.fromCharCode(d.charCodeAt(0) & 0x1f); ctrlArm = false; updateCtrlBtn(); }
    if (pane.ws?.readyState === WebSocket.OPEN) pane.ws.send(d);
  });
  panes.set(name, pane);
  connectPaneWs(pane);
  return pane;
}

function connectPaneWs(pane) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/attach?session=${encodeURIComponent(pane.name)}&cols=${gCols}&rows=${gRows}&scroll=${scrollMode}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  pane.ws = ws;
  ws.onopen = () => { sendPaneResize(pane); if (pane.name === currentSession) setStatus(scrollMode === 'fast' ? 'connected · fast' : 'connected', 'connected'); };
  ws.onmessage = (ev) => { pane.term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data)); };
  ws.onclose = (ev) => {
    if (ev.code === 4401) { location.href = '/login.html'; return; }
    if (pane.dispose) return;
    if (pane.manual) { pane.manual = false; return; }
    if (pane.name === currentSession) setStatus('disconnected — reconnecting…', 'closed');
    clearTimeout(pane.rc);
    pane.rc = setTimeout(() => connectPaneWs(pane), 1500);
  };
  ws.onerror = () => { if (pane.name === currentSession) setStatus('connection error', 'closed'); };
}

function sendPaneResize(pane) {
  if (pane.ws?.readyState === WebSocket.OPEN) pane.ws.send(JSON.stringify({ type: 'resize', cols: gCols, rows: gRows }));
}

function disposePane(name) {
  const p = panes.get(name);
  if (!p) return;
  p.dispose = true;
  clearTimeout(p.rc);
  try { p.ws?.close(); } catch { /* */ }
  try { p.term.dispose(); } catch { /* */ }
  p.wrap.remove();
  panes.delete(name);
}

// Lock every warm pane to one size so tmux (sizes a multi-client window to the
// latest client) never shrinks the visible pane to a hidden one.
function setSize(cols, rows) {
  if (!cols || !rows || (cols === gCols && rows === gRows)) return;
  gCols = cols; gRows = rows;
  for (const p of panes.values()) { try { p.term.resize(cols, rows); } catch { /* */ } sendPaneResize(p); }
}

function fitActive() {
  const p = panes.get(currentSession);
  if (!p) return;
  p.fit.fit();
  setSize(p.term.cols, p.term.rows);
}

function showPane(name) {
  for (const [n, p] of panes) p.wrap.style.display = n === name ? 'block' : 'none';
  const p = panes.get(name);
  if (!p) return;
  // After the element is visible, fit and force a repaint — a renderer that was
  // hidden (display:none) hasn't painted its buffer to the canvas yet.
  requestAnimationFrame(() => {
    p.fit.fit();
    setSize(p.term.cols, p.term.rows);
    try { p.term.refresh(0, p.term.rows - 1); } catch { /* */ }
    p.term.focus();
  });
  setStatus(
    p.ws?.readyState === WebSocket.OPEN ? (scrollMode === 'fast' ? 'connected · fast' : 'connected') : 'connecting…',
    p.ws?.readyState === WebSocket.OPEN ? 'connected' : '',
  );
}

// Keep the current + (WARM-1) most-recent sessions attached; drop the rest.
function reconcileWarm() {
  const order = mruOrderedExisting();
  const warm = new Set(order.slice(0, WARM));
  warm.add(currentSession);
  for (const name of warm) if (name && !panes.has(name)) makePane(name);
  for (const n of [...panes.keys()]) if (!warm.has(n)) disposePane(n);
}

function applySidebar() {
  appEl.classList.toggle('collapsed', !sidebarOpen);
  setTimeout(fitActive, 60);
}

// ---- scroll mode toggle: re-attach every pane with the new mode ----
const scrollBtn = document.getElementById('scroll-toggle');
function refreshScrollBtn() { scrollBtn.textContent = scrollMode === 'fast' ? '⚡ fast' : '↕ tmux'; }
refreshScrollBtn();
scrollBtn.addEventListener('click', () => {
  scrollMode = scrollMode === 'fast' ? 'tmux' : 'fast';
  localStorage.setItem('ccdeck.scroll', scrollMode);
  refreshScrollBtn();
  for (const p of panes.values()) { p.manual = true; clearTimeout(p.rc); try { p.ws?.close(); } catch { /* */ } p.term.reset(); connectPaneWs(p); }
});

document.getElementById('sb-toggle').addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  localStorage.setItem('ccdeck.sidebar', sidebarOpen ? 'open' : 'closed');
  applySidebar();
});
document.getElementById('sb-collapse').addEventListener('click', () => {
  sidebarOpen = false; localStorage.setItem('ccdeck.sidebar', 'closed'); applySidebar();
});
document.getElementById('sb-backdrop').addEventListener('click', () => {
  sidebarOpen = false; localStorage.setItem('ccdeck.sidebar', 'closed'); applySidebar();
});

// Tapping the terminal focuses the active session (raises the iOS keyboard).
termHost.addEventListener('click', () => { panes.get(currentSession)?.term.focus(); });

// ---- on-screen key bar (mobile) ----
function activeWs() { const p = panes.get(currentSession); return p?.ws?.readyState === WebSocket.OPEN ? p.ws : null; }
function sendKey(seq) { activeWs()?.send(seq); panes.get(currentSession)?.term.focus(); }
function updateCtrlBtn() { document.getElementById('kb-ctrl')?.classList.toggle('armed', ctrlArm); }
const KEYS = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\t' },
  { label: 'ctrl', ctrl: true },
  { label: '←', seq: '\x1b[D' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
  { label: '^C', seq: '\x03' },
];
const keybar = document.getElementById('keybar');
keybar.innerHTML = KEYS.map((k, i) => `<button ${k.ctrl ? 'id="kb-ctrl"' : ''} data-i="${i}">${k.label}</button>`).join('');
keybar.querySelectorAll('button').forEach((btn) => {
  // Use pointerdown + preventDefault so tapping a key doesn't steal focus/raise-dismiss the keyboard.
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const k = KEYS[Number(btn.dataset.i)];
    if (k.ctrl) { ctrlArm = !ctrlArm; updateCtrlBtn(); }
    else sendKey(k.seq);
  });
});

// Keep the layout (and key bar) above the iOS on-screen keyboard.
if (isMobile && window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => { appEl.style.height = `${vv.height}px`; fitActive(); };
  vv.addEventListener('resize', onVV);
  vv.addEventListener('scroll', onVV);
}

// ---- session list + sidebar ----
async function api(path) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' } });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  return res.json();
}
function isLive(s) { return /node|claude/i.test(s.paneCommand || '') || (s.lastActivity && Date.now() - s.lastActivity < 15000); }
function needsAttention(s) { return s.name !== currentSession && s.lastActivity && s.lastActivity > (lastSeen[s.name] || 0); }
function titleOf(name) { return sessions.find((s) => s.name === name)?.title || name; }
function baseName(p) { if (!p) return ''; return p.replace(/\/$/, '').split('/').slice(-2).join('/'); }
function orderedSessions() { return [...sessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)); }
function mruOrderedExisting() {
  const names = new Set(sessions.map((s) => s.name));
  const inMru = mru.filter((n) => names.has(n));
  return [...inMru, ...sessions.map((s) => s.name).filter((n) => !inMru.includes(n))];
}

async function refreshSessions() {
  try {
    const { sessions: list } = await api('/api/sessions');
    sessions = list;
    if (!baselined) { for (const s of sessions) lastSeen[s.name] = Date.now(); baselined = true; }
    lastSeen[currentSession] = Date.now();
    titleEl.textContent = titleOf(currentSession);
    renderSidebar();
  } catch { /* */ }
}

function renderSidebar() {
  const list = document.getElementById('sb-list');
  const ordered = orderedSessions();
  list.innerHTML = ordered.map((s, i) => {
    const cur = s.name === currentSession;
    const att = needsAttention(s);
    const warm = panes.has(s.name) && !cur;
    const num = i < 9 ? `<span class="sb-num">${i + 1}</span>` : '';
    return `<div class="sb-item ${cur ? 'current' : ''} ${att ? 'attn' : ''}" data-name="${esc(s.name)}" title="${warm ? 'preloaded' : ''}">
      <span class="sb-dot ${isLive(s) ? 'live' : 'idle'}"></span>
      <span class="sb-meta"><span class="sb-title">${esc(s.title)}${warm ? ' <span class="sb-warm" title="preloaded">•</span>' : ''}</span><span class="sb-dir">${esc(baseName(s.dir))}</span></span>
      ${att ? '<span class="sb-attn" title="Activity since you last viewed">●</span>' : num}
    </div>`;
  }).join('') || '<div class="faint" style="padding:12px">No active sessions</div>';
  list.querySelectorAll('.sb-item').forEach((el) => el.addEventListener('click', () => switchTo(el.dataset.name)));
  const attnCount = sessions.filter(needsAttention).length;
  const badge = document.getElementById('sb-badge');
  badge.style.display = attnCount ? '' : 'none';
  badge.textContent = attnCount;
}

// ---- switching (instant when the target is already warm) ----
function switchTo(name) {
  if (!name || name === currentSession) return;
  lastSeen[currentSession] = Date.now();
  if (!panes.has(name)) makePane(name);
  currentSession = name;
  bumpMru(name);
  lastSeen[name] = Date.now();
  history.replaceState({}, '', `?session=${encodeURIComponent(name)}`);
  titleEl.textContent = titleOf(name);
  if (isMobile && sidebarOpen) { sidebarOpen = false; applySidebar(); } // close the drawer
  showPane(name);
  renderSidebar();
  reconcileWarm();
}

let resizeTimer;
const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitActive, 100); };
window.addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(termHost);

// ---- Ctrl+Tab / Alt+` MRU quick-switch ----
const sw = document.getElementById('switcher');
const swBox = document.getElementById('sw-box');
let switching = false;
let switchMod = null;
let swList = [];
let swIdx = 0;

function openSwitcher(dir, mod) {
  swList = mruOrderedExisting();
  if (swList.length < 2) return;
  switching = true; switchMod = mod;
  swIdx = dir < 0 ? swList.length - 1 : dir;
  renderSwitcher();
  sw.style.display = 'flex';
}
function stepSwitcher(dir) { swIdx = (swIdx + dir + swList.length) % swList.length; renderSwitcher(); }
function cycle(mod, reverse) { if (!switching) openSwitcher(reverse ? -1 : 1, mod); else stepSwitcher(reverse ? -1 : 1); }
function renderSwitcher() {
  swBox.innerHTML = swList.map((name, i) => {
    const s = sessions.find((x) => x.name === name) || {};
    return `<div class="sw-item ${i === swIdx ? 'sel' : ''}">
      <span class="sb-dot ${isLive(s) ? 'live' : 'idle'}"></span>${esc(titleOf(name))}${needsAttention(s) ? ' <span class="sb-attn">●</span>' : ''}${panes.has(name) ? ' <span class="sb-warm">•</span>' : ''}
    </div>`;
  }).join('');
}
function commitSwitcher() {
  sw.style.display = 'none';
  if (switching && swList[swIdx]) switchTo(swList[swIdx]);
  switching = false; switchMod = null;
}

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'Backquote') { e.preventDefault(); cycle('Alt', e.shiftKey); return; }
  if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycle('Control', e.shiftKey); return; }
  if (switching && e.key === 'Escape') { sw.style.display = 'none'; switching = false; switchMod = null; e.preventDefault(); return; }
  if (e.altKey && /^[1-9]$/.test(e.key)) { const t = orderedSessions()[Number(e.key) - 1]; if (t) { e.preventDefault(); switchTo(t.name); } }
}, true);
window.addEventListener('keyup', (e) => {
  if (!switching || !switchMod) return;
  const released = (switchMod === 'Alt' && (e.key === 'Alt' || !e.altKey)) || (switchMod === 'Control' && (e.key === 'Control' || !e.ctrlKey));
  if (released) { e.preventDefault(); commitSwitcher(); }
}, true);

window.addEventListener('beforeunload', () => { for (const p of panes.values()) { p.dispose = true; try { p.ws?.close(); } catch { /* */ } } });

// ---- boot ----
if (!currentSession) {
  setStatus('no session specified', 'closed');
} else {
  makePane(currentSession);
  showPane(currentSession);
  applySidebar();
  refreshSessions().then(reconcileWarm); // preload the recent sessions
  setInterval(refreshSessions, 3000);
}
