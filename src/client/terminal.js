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
let metaArm = false; // sticky Meta/Alt for the on-screen key bar

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
      <button id="sb-new" class="sb-new">+ New session</button>
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
    // Sticky Ctrl/Meta (mobile key bar): fold the next typed char to a control
    // code and/or prefix ESC (how terminals encode Meta/Alt+key).
    if ((ctrlArm || metaArm) && d.length === 1) {
      if (ctrlArm) d = String.fromCharCode(d.charCodeAt(0) & 0x1f);
      if (metaArm) d = `\x1b${d}`;
      ctrlArm = metaArm = false; updateCtrlBtn(); updateMetaBtn();
    }
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
document.getElementById('sb-new').addEventListener('click', openNewModal);

// ---- new session modal (launch + switch to it) ----
let cfg = null;
async function openNewModal() {
  if (!cfg) { try { cfg = await api('/api/config'); } catch { cfg = { roots: [] }; } }
  let currentPath = (cfg.roots && cfg.roots[0]) || cfg.home || '/';
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <h2>New Claude session</h2>
      <div class="field">
        <label>Directory</label>
        <input id="dir-input" value="${esc(currentPath)}" spellcheck="false" />
        <div class="browser" id="browser"></div>
      </div>
      <div class="field">
        <label>Title <span class="faint">(optional)</span></label>
        <input id="title-input" placeholder="defaults to the folder name" spellcheck="false" />
      </div>
      <div class="error" id="modal-error"></div>
      <div class="modal-actions">
        <button id="cancel-btn">Cancel</button>
        <button class="primary" id="launch-btn">Launch claude</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  const dirInput = bg.querySelector('#dir-input');
  const browser = bg.querySelector('#browser');
  const errEl = bg.querySelector('#modal-error');
  async function browse(path) {
    try {
      const { path: abs, dirs } = await api(`/api/fs?path=${encodeURIComponent(path)}`);
      currentPath = abs; dirInput.value = abs;
      const parent = abs.split('/').slice(0, -1).join('/') || '/';
      browser.innerHTML = `<div class="row up" data-path="${esc(parent)}">⬆ ..</div>` +
        dirs.map((d) => `<div class="row" data-path="${esc(d.path)}">📁 ${esc(d.name)}</div>`).join('');
      browser.querySelectorAll('.row').forEach((r) => r.addEventListener('click', () => browse(r.dataset.path)));
    } catch (e) { errEl.textContent = e.message; }
  }
  browse(currentPath);
  dirInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') browse(dirInput.value); });
  const close = () => bg.remove();
  bg.querySelector('#cancel-btn').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('#launch-btn').addEventListener('click', async () => {
    errEl.textContent = '';
    try {
      const { name } = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ dir: dirInput.value, title: bg.querySelector('#title-input').value }),
      });
      close();
      await refreshSessions();
      switchTo(name);
    } catch (e) { errEl.textContent = e.message; }
  });
}

// Tapping the terminal focuses the active session (raises the iOS keyboard).
termHost.addEventListener('click', () => { panes.get(currentSession)?.term.focus(); });

// Touch scrolling in tmux mode: xterm only sends mouse *drag* on touch over the
// alt-screen, so tmux copy-mode never scrolls (desktop uses the wheel). Translate
// one-finger vertical swipes into tmux mouse-wheel events. (Fast mode scrolls the
// xterm buffer natively, so we leave touch alone there.)
let touchY = null, touchAccum = 0;
const TOUCH_STEP = 22; // px per wheel "tick"
const wheelSeq = (up) => `\x1b[<${up ? 64 : 65};1;1M`; // SGR mouse wheel up/down
termHost.addEventListener('touchstart', (e) => {
  if (scrollMode === 'tmux' && e.touches.length === 1) { touchY = e.touches[0].clientY; touchAccum = 0; }
  else touchY = null;
}, { capture: true, passive: true });
termHost.addEventListener('touchmove', (e) => {
  if (touchY === null || scrollMode !== 'tmux' || e.touches.length !== 1) return;
  const ws = activeWs();
  if (!ws) return;
  const y = e.touches[0].clientY;
  touchAccum += y - touchY; // finger down (dy>0) -> scroll up (older content)
  touchY = y;
  while (Math.abs(touchAccum) >= TOUCH_STEP) {
    const up = touchAccum > 0;
    ws.send(wheelSeq(up));
    touchAccum += up ? -TOUCH_STEP : TOUCH_STEP;
  }
  e.preventDefault();
  e.stopPropagation();
}, { capture: true, passive: false });
termHost.addEventListener('touchend', () => { touchY = null; }, { capture: true, passive: true });

// ---- on-screen key bar (mobile) ----
function activeWs() { const p = panes.get(currentSession); return p?.ws?.readyState === WebSocket.OPEN ? p.ws : null; }
function sendKey(seq) { activeWs()?.send(seq); panes.get(currentSession)?.term.focus(); }
function updateCtrlBtn() { document.getElementById('kb-ctrl')?.classList.toggle('armed', ctrlArm); }
function updateMetaBtn() { document.getElementById('kb-meta')?.classList.toggle('armed', metaArm); }
const KEYS = [
  { label: 'esc', seq: '\x1b' },
  { label: '⌫', seq: '\x7f', repeat: true, title: 'Backspace (hold to repeat)' },
  { label: 'tab', seq: '\t' },
  { label: '⇧⇥', seq: '\x1b[Z', title: 'Shift+Tab — cycle permission mode' },
  { label: 'ctrl', ctrl: true },
  { label: 'meta', meta: true },
  { label: '←', seq: '\x1b[D', repeat: true },
  { label: '↑', seq: '\x1b[A', repeat: true },
  { label: '↓', seq: '\x1b[B', repeat: true },
  { label: '→', seq: '\x1b[C', repeat: true },
  { label: '^C', seq: '\x03' },
];
const keybar = document.getElementById('keybar');
keybar.innerHTML = KEYS.map((k, i) =>
  `<button ${k.ctrl ? 'id="kb-ctrl"' : ''}${k.meta ? 'id="kb-meta"' : ''} data-i="${i}" title="${k.title || ''}">${k.label}</button>`).join('');
keybar.querySelectorAll('button').forEach((btn) => {
  const k = KEYS[Number(btn.dataset.i)];
  if (k.repeat) {
    // iOS soft keyboards don't auto-repeat on hold, so do it ourselves.
    let delay, iv;
    const stop = () => { clearTimeout(delay); clearInterval(iv); };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sendKey(k.seq);
      delay = setTimeout(() => { iv = setInterval(() => activeWs()?.send(k.seq), 55); }, 400);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
    return;
  }
  // Use pointerdown + preventDefault so tapping a key doesn't steal focus/raise-dismiss the keyboard.
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (k.ctrl) { ctrlArm = !ctrlArm; updateCtrlBtn(); }
    else if (k.meta) { metaArm = !metaArm; updateMetaBtn(); }
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
async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { headers, ...opts });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function isLive(s) { return !!s.liveSessionId || /node|claude/i.test(s.paneCommand || '') || (s.lastActivity && Date.now() - s.lastActivity < 15000); }
// Status dot color: accent=needs you, green=working, blue=ready/your turn, grey=idle.
function statusDot(s) {
  if (s.waitingFor) return 'attn';
  if (s.claudeStatus === 'busy') return 'live';
  if (s.claudeStatus === 'idle') return 'ready';
  return isLive(s) ? 'live' : 'idle';
}
function needsAttention(s) {
  if (s.name === currentSession) return false;
  if (s.waitingFor) return true; // blocked on you (e.g. permission)
  return s.lastActivity && s.lastActivity > (lastSeen[s.name] || 0);
}
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
      <span class="sb-dot ${statusDot(s)}"></span>
      <span class="sb-meta"><span class="sb-title">${esc(s.title)}${warm ? ' <span class="sb-warm" title="preloaded">•</span>' : ''}</span><span class="sb-dir">${esc(baseName(s.dir))}</span></span>
      ${att ? '<span class="sb-attn" title="Needs you / activity since last viewed">●</span>' : num}
      <button class="sb-rename" title="Rename session" data-rename="${esc(s.name)}">✎</button>
      <button class="sb-kill" title="Kill session" data-kill="${esc(s.name)}">✕</button>
    </div>`;
  }).join('') || '<div class="faint" style="padding:12px">No active sessions</div>';
  list.querySelectorAll('.sb-item').forEach((el) =>
    el.addEventListener('click', (e) => { if (!e.target.closest('.sb-kill, .sb-rename')) switchTo(el.dataset.name); }));
  list.querySelectorAll('.sb-rename').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); renameSessionFromSidebar(b.dataset.rename); }));
  list.querySelectorAll('.sb-kill').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); killSessionFromSidebar(b.dataset.kill); }));
  const attnCount = sessions.filter(needsAttention).length;
  const badge = document.getElementById('sb-badge');
  badge.style.display = attnCount ? '' : 'none';
  badge.textContent = attnCount;
}

async function renameSessionFromSidebar(name) {
  const s = sessions.find((x) => x.name === name);
  const title = prompt('Rename session', s?.title || '');
  if (title == null) return;
  try { await api(`/api/sessions/${name}`, { method: 'PATCH', body: JSON.stringify({ title }) }); }
  catch (e) { alert('Rename failed: ' + e.message); return; }
  await refreshSessions();
}

async function killSessionFromSidebar(name) {
  const s = sessions.find((x) => x.name === name);
  if (!confirm(`Kill session "${s?.title || name}"? Claude and its tmux session will be terminated.`)) return;
  try { await api(`/api/sessions/${name}`, { method: 'DELETE' }); }
  catch (e) { alert('Kill failed: ' + e.message); return; }
  if (panes.has(name)) disposePane(name);
  await refreshSessions();
  if (name === currentSession) {
    const next = orderedSessions()[0]; // killed one is gone from the list now
    if (next) switchTo(next.name); // currentSession is still the (dead) name, so this proceeds
    else location.href = '/'; // nothing left to show
  }
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
      <span class="sb-dot ${statusDot(s)}"></span>${esc(titleOf(name))}${needsAttention(s) ? ' <span class="sb-attn">●</span>' : ''}${panes.has(name) ? ' <span class="sb-warm">•</span>' : ''}
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
