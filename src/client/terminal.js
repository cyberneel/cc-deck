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

let scrollMode = localStorage.getItem('ccdeck.scroll') || 'tmux';
let sidebarOpen = localStorage.getItem('ccdeck.sidebar') !== 'closed';

// MRU order (most-recently-viewed first), persisted across reloads.
let mru = [];
try { mru = JSON.parse(localStorage.getItem('ccdeck.mru') || '[]'); } catch { mru = []; }
function bumpMru(name) {
  mru = [name, ...mru.filter((n) => n !== name)];
  localStorage.setItem('ccdeck.mru', JSON.stringify(mru.slice(0, 50)));
}
if (currentSession) bumpMru(currentSession);

let sessions = []; // latest /api/sessions
const lastSeen = {}; // name -> ts we last viewed it (attention baseline)
let baselined = false;

document.body.innerHTML = `
  <div id="app-term" class="${sidebarOpen ? '' : 'collapsed'}">
    <aside id="sidebar">
      <div class="sb-head"><span>Sessions</span><button id="sb-collapse" class="icon" title="Collapse">«</button></div>
      <div id="sb-list"></div>
      <div class="sb-foot faint">Ctrl+Tab to cycle · Alt+1–9 to jump</div>
    </aside>
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
    </div>
  </div>
  <div id="switcher" class="switcher" style="display:none"><div class="sw-box" id="sw-box"></div></div>`;

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const appEl = document.getElementById('app-term');

// ---- scroll mode toggle ----
const scrollBtn = document.getElementById('scroll-toggle');
function refreshScrollBtn() { scrollBtn.textContent = scrollMode === 'fast' ? '⚡ fast' : '↕ tmux'; }
refreshScrollBtn();
scrollBtn.addEventListener('click', () => {
  scrollMode = scrollMode === 'fast' ? 'tmux' : 'fast';
  localStorage.setItem('ccdeck.scroll', scrollMode);
  refreshScrollBtn();
  reconnect();
});

// ---- sidebar collapse ----
function applySidebar() {
  appEl.classList.toggle('collapsed', !sidebarOpen);
  setTimeout(() => { fit.fit(); sendResize(); }, 60);
}
document.getElementById('sb-toggle').addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  localStorage.setItem('ccdeck.sidebar', sidebarOpen ? 'open' : 'closed');
  applySidebar();
});
document.getElementById('sb-collapse').addEventListener('click', () => {
  sidebarOpen = false;
  localStorage.setItem('ccdeck.sidebar', 'closed');
  applySidebar();
});

// ---- terminal ----
const term = new Terminal({
  fontFamily: "'JetBrains Mono','SF Mono','Fira Code',ui-monospace,monospace",
  fontSize: 13,
  lineHeight: 1.0,
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: true,
  theme: {
    background: '#0a0d12', foreground: '#e6edf3', cursor: '#d97757', selectionBackground: '#2a3344',
    black: '#0a0d12', brightBlack: '#5c6877', red: '#ff8d85', brightRed: '#ff8d85',
    green: '#5cb87a', brightGreen: '#5cb87a', yellow: '#e0c060', brightYellow: '#e0c060',
    blue: '#6ea8fe', brightBlue: '#6ea8fe', magenta: '#c099ff', brightMagenta: '#c099ff',
    cyan: '#5fd3d3', brightCyan: '#5fd3d3', white: '#e6edf3', brightWhite: '#ffffff',
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
function useCanvas() { try { term.loadAddon(new CanvasAddon()); } catch { /* DOM renderer */ } }
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => { webgl.dispose(); useCanvas(); });
  term.loadAddon(webgl);
} catch { useCanvas(); }
fit.fit();
applySidebar();

// Don't let our shortcut keys reach the pty.
term.attachCustomKeyEventHandler((e) => {
  if (e.type === 'keydown' && e.ctrlKey && e.key === 'Tab') return false;
  if (e.type === 'keydown' && e.altKey && /^[1-9]$/.test(e.key)) return false;
  return true;
});

function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = `status ${cls || ''}`; }

// ---- session list + sidebar ----
async function api(path) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' } });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  return res.json();
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function isLive(s) { return /node|claude/i.test(s.paneCommand || '') || (s.lastActivity && Date.now() - s.lastActivity < 15000); }
function needsAttention(s) {
  return s.name !== currentSession && s.lastActivity && s.lastActivity > (lastSeen[s.name] || 0);
}
function titleOf(name) { return sessions.find((s) => s.name === name)?.title || name; }

async function refreshSessions() {
  try {
    const { sessions: list } = await api('/api/sessions');
    sessions = list;
    if (!baselined) { // baseline attention so only NEW activity flags
      for (const s of sessions) lastSeen[s.name] = Date.now();
      baselined = true;
    }
    lastSeen[currentSession] = Date.now();
    titleEl.textContent = titleOf(currentSession);
    renderSidebar();
  } catch { /* */ }
}

function orderedSessions() {
  return [...sessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

function renderSidebar() {
  const list = document.getElementById('sb-list');
  const ordered = orderedSessions();
  list.innerHTML = ordered.map((s, i) => {
    const cur = s.name === currentSession;
    const att = needsAttention(s);
    const num = i < 9 ? `<span class="sb-num">${i + 1}</span>` : '';
    return `<div class="sb-item ${cur ? 'current' : ''} ${att ? 'attn' : ''}" data-name="${esc(s.name)}">
      <span class="sb-dot ${isLive(s) ? 'live' : 'idle'}"></span>
      <span class="sb-meta"><span class="sb-title">${esc(s.title)}</span><span class="sb-dir">${esc(baseName(s.dir))}</span></span>
      ${att ? '<span class="sb-attn" title="Activity since you last viewed">●</span>' : num}
    </div>`;
  }).join('') || '<div class="faint" style="padding:12px">No active sessions</div>';

  list.querySelectorAll('.sb-item').forEach((el) =>
    el.addEventListener('click', () => switchTo(el.dataset.name)));

  // attention badge on the collapsed toggle
  const attnCount = sessions.filter(needsAttention).length;
  const badge = document.getElementById('sb-badge');
  badge.style.display = attnCount ? '' : 'none';
  badge.textContent = attnCount;
}
function baseName(p) { if (!p) return ''; const parts = p.replace(/\/$/, '').split('/'); return parts.slice(-2).join('/'); }

// ---- switching ----
function switchTo(name) {
  if (!name || name === currentSession) return;
  lastSeen[currentSession] = Date.now();
  currentSession = name;
  bumpMru(name);
  lastSeen[name] = Date.now();
  history.replaceState({}, '', `?session=${encodeURIComponent(name)}`);
  titleEl.textContent = titleOf(name);
  renderSidebar();
  reconnect();
  term.focus();
}

// ---- websocket ----
let ws;
let reconnectTimer;
let suppressReconnect = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/attach?session=${encodeURIComponent(currentSession)}&cols=${term.cols}&rows=${term.rows}&scroll=${scrollMode}`;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { setStatus(scrollMode === 'fast' ? 'connected · fast' : 'connected', 'connected'); sendResize(); term.focus(); };
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') term.write(ev.data); else term.write(new Uint8Array(ev.data)); };
  ws.onclose = (ev) => {
    if (ev.code === 4401) { location.href = '/login.html'; return; }
    if (suppressReconnect) { suppressReconnect = false; return; }
    setStatus('disconnected — reconnecting…', 'closed');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => setStatus('connection error', 'closed');
}
function reconnect() {
  clearTimeout(reconnectTimer);
  suppressReconnect = true;
  try { ws?.close(); } catch { /* */ }
  term.reset();
  connect();
}
function sendResize() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}
term.onData((data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); });

let resizeTimer;
const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { fit.fit(); sendResize(); }, 100); };
window.addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(document.getElementById('terminal'));

// ---- Ctrl+Tab MRU quick-switch (Zen-style) ----
const sw = document.getElementById('switcher');
const swBox = document.getElementById('sw-box');
let switching = false;
let swList = [];
let swIdx = 0;

function mruOrderedExisting() {
  const names = new Set(sessions.map((s) => s.name));
  const inMru = mru.filter((n) => names.has(n));
  const rest = sessions.map((s) => s.name).filter((n) => !inMru.includes(n));
  return [...inMru, ...rest];
}
function openSwitcher(dir) {
  swList = mruOrderedExisting();
  if (swList.length < 2) return;
  switching = true;
  swIdx = dir; // first press moves to previous/next session
  if (swIdx < 0) swIdx = swList.length - 1;
  renderSwitcher();
  sw.style.display = 'flex';
}
function stepSwitcher(dir) {
  swIdx = (swIdx + dir + swList.length) % swList.length;
  renderSwitcher();
}
function renderSwitcher() {
  swBox.innerHTML = swList.map((name, i) =>
    `<div class="sw-item ${i === swIdx ? 'sel' : ''}">
      <span class="sb-dot ${isLive(sessions.find((s) => s.name === name) || {}) ? 'live' : 'idle'}"></span>
      ${esc(titleOf(name))}${needsAttention(sessions.find((s) => s.name === name) || {}) ? ' <span class="sb-attn">●</span>' : ''}
    </div>`).join('');
}
function commitSwitcher() {
  sw.style.display = 'none';
  if (switching && swList[swIdx]) switchTo(swList[swIdx]);
  switching = false;
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    if (!switching) openSwitcher(e.shiftKey ? -1 : 1);
    else stepSwitcher(e.shiftKey ? -1 : 1);
    return;
  }
  if (switching && e.key === 'Escape') { sw.style.display = 'none'; switching = false; e.preventDefault(); return; }
  // Alt+1–9: jump directly to the Nth sidebar session (reliable fallback).
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const ordered = orderedSessions();
    const target = ordered[Number(e.key) - 1];
    if (target) { e.preventDefault(); switchTo(target.name); }
  }
}, true);
window.addEventListener('keyup', (e) => {
  if (switching && (e.key === 'Control' || !e.ctrlKey)) commitSwitcher();
}, true);

// ---- boot ----
if (!currentSession) {
  setStatus('no session specified', 'closed');
} else {
  connect();
  refreshSessions();
  setInterval(refreshSessions, 3000);
}
