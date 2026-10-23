import './dialogs.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import css from './styles.css';
import { registerServiceWorker, applyUpdate } from './swreg.js';
import { openShare } from './graph.js';
import { openNotes } from './notes.js';
import { openNewModal as openNewModalShared } from './newsession.js';
import { pickFiles, sendFiles, toast } from './upload.js';
import { fetchBurn, renderBurnPill, openBurnPopover } from './burnpill.js';

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
let remoteCache = []; // tmux sessions on other tailnet hosts (attach-only), polled separately
// Sessions that need your attention (blocked on you, or just finished). Cleared
// when you view them or they start working again.
const attention = new Set();
const prevStatus = {};

document.body.innerHTML = `
  <div id="app-term" class="${sidebarOpen ? '' : 'collapsed'}">
    <aside id="sidebar">
      <div class="sb-head"><span>Deep Sessions</span><button id="sb-collapse" class="icon" title="Hide the sidebar">Hide</button></div>
      <button id="sb-new" class="sb-new">New Deep Session</button>
      <button id="sb-resume" class="sb-new sb-resume">Resume a Deep Session</button>
      <div id="sb-list" tabindex="0" role="region" aria-label="Deep Sessions"></div>
      <div class="sb-foot faint">Alt+\` to cycle, Alt+1–9 to jump</div>
    </aside>
    <div id="sb-backdrop"></div>
    <main id="main">
      <div class="term-bar">
        <button id="sb-toggle" class="icon" title="Show or hide the Deep Sessions sidebar">Sessions<span id="sb-badge" class="sb-badge" style="display:none"></span></button>
        <a href="/">Dashboard</a>
        <h1 class="title" id="title">${esc(currentSession || 'session')}</h1>
        <button id="main-btn" class="burn-pill" style="display:none">Back to main</button>
        <div class="spacer" style="flex:1"></div>
        <button id="notes-btn" class="icon" title="Updates from outside chats" style="display:none"></button>
        <button id="burn-btn" class="burn-pill" title="Usage limits (ccburn)" style="display:none"></button>
        <button id="upload-btn" class="icon" title="Send files or a folder to this Deep Session">Upload</button>
        <button id="tb-theme" class="icon" title="Switch light or dark mode" aria-label="Switch light or dark mode"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/></svg></button>
        <button id="reload-btn" class="icon" title="Reload app">Reload</button>
        <button id="scroll-toggle" class="icon" title="Scroll mode. tmux keeps full history; Fast scrolls locally and smoothly."></button>
        <span class="status" id="status" role="status"></span>
      </div>
      <div id="terminal"></div>
      <div class="keybar" id="keybar"></div>
    </main>
  </div>
  <div id="switcher" class="switcher" style="display:none"><div class="sw-box" id="sw-box"></div></div>`;

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
// Shown when this pane is on a background job (summary-seeded) instead of its full-context
// main conversation; one click swaps the pane for main.
const mainBtn = document.getElementById('main-btn');
function renderParked() {
  const p = sessions.find((s) => s.name === currentSession)?.parked;
  mainBtn.style.display = p ? '' : 'none';
  if (p) mainBtn.title = `On background job${p.jobName ? ` “${p.jobName}”` : ''} (summary-only context). Go back to your full-context main conversation.`;
}
mainBtn.addEventListener('click', async () => {
  const old = currentSession;
  try {
    const { name } = await api(`/api/sessions/${encodeURIComponent(old)}/main`, { method: 'POST' });
    switchTo(name);
    disposePane(old);
    await refreshSessions();
  } catch (err) { toast(err.message, { kind: 'error' }); }
});
const appEl = document.getElementById('app-term');
const termHost = document.getElementById('terminal');

let lastStatus = '';
function setStatus(text, cls, html) {
  const key = `${cls}|${html || text}`;
  if (key === lastStatus) return; // the 1s ticker repaints only on change (keeps Retry focusable)
  lastStatus = key;
  statusEl.className = `status ${cls || ''}`;
  if (html) statusEl.innerHTML = html; else statusEl.textContent = text;
}

// Connection status for the current pane. While it can't connect the words
// escalate — "Connecting…", elapsed after 3s, "Still connecting…" at 10s, and at
// 30s "Can't reach Polymux. Retry". Background retries keep going regardless;
// Retry probes now and restarts the clock.
function renderConn() {
  const p = panes.get(currentSession);
  if (!p) return;
  if (p.ended) return setStatus('', 'closed', 'This Deep Session has ended');
  if (p.ws?.readyState === WebSocket.OPEN) return setStatus(scrollMode === 'fast' ? 'connected, fast' : 'connected', 'connected');
  const s = Math.floor((Date.now() - (p.since ||= Date.now())) / 1000);
  if (s >= 30) return setStatus('', 'closed', `Can't reach Polymux<button data-retry>Retry</button>`);
  const word = s >= 10 ? 'Still connecting…' : p.lost ? 'Reconnecting…' : 'Connecting…';
  setStatus('', 'connecting', `<span class="cdot"></span>${word}${s >= 3 ? ` ${s}s` : ''}`);
}
statusEl.addEventListener('click', (e) => {
  if (!e.target.closest('[data-retry]')) return;
  const p = panes.get(currentSession);
  if (!p) return;
  p.since = Date.now();
  clearTimeout(p.rc);
  reconnectWhenUp(p);
  renderConn();
});
setInterval(renderConn, 1000);
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const TERM_OPTS = {
  fontFamily: "'JetBrains Mono','SF Mono','Fira Code',ui-monospace,monospace",
  fontSize: isMobile ? 12 : 13, lineHeight: 1.0, cursorBlink: true, scrollback: 10000, allowProposedApi: true,
  theme: {
    // FridayOS dark palette; the terminal stays black in light mode too.
    background: '#000000', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#333333',
    black: '#000000', brightBlack: '#6a6a6a', red: '#e5243b', brightRed: '#e5243b',
    green: '#4cc276', brightGreen: '#4cc276', yellow: '#e0a32e', brightYellow: '#e0a32e',
    blue: '#6ea8fe', brightBlue: '#6ea8fe', magenta: '#c099ff', brightMagenta: '#c099ff',
    cyan: '#5fd3d3', brightCyan: '#5fd3d3', white: '#e6edf3', brightWhite: '#ffffff',
  },
};

function shortcutGuard(e) {
  if (e.type !== 'keydown') return true;
  if (e.ctrlKey && e.key === 'Tab') return false;
  if (e.altKey && e.code === 'Backquote') return false;
  if (e.altKey && /^Digit[1-9]$/.test(e.code)) return false; // e.code: on a Mac Alt+1 types ¡
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
  // Clipboard sync: tmux copy-mode yanks arrive as an OSC 52 sequence — turn that
  // into a system-clipboard write so terminal selections reach the device clipboard.
  try {
    term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(';') + 1);
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        navigator.clipboard?.writeText(new TextDecoder().decode(bytes)).catch(() => {});
      } catch { /* not base64 */ }
      return true;
    });
  } catch { /* older xterm */ }
  // Copy-on-select for fast scroll mode (where xterm owns the selection).
  wrap.addEventListener('mouseup', () => {
    const s = term.getSelection();
    if (s) navigator.clipboard?.writeText(s).catch(() => {});
  });
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
  pane.since ||= Date.now();
  ws.onopen = () => { pane.since = 0; pane.lost = false; sendPaneResize(pane); if (pane.name === currentSession) renderConn(); };
  ws.onmessage = (ev) => { pane.term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data)); };
  ws.onclose = (ev) => {
    if (ev.code === 4401) { location.href = '/login.html'; return; }
    if (ev.code === 4404 || ev.code === 4400) { pane.ended = true; if (pane.name === currentSession) renderConn(); return; }
    if (pane.dispose) return;
    if (pane.manual) { pane.manual = false; return; }
    pane.since ||= Date.now();
    pane.lost = true;
    if (pane.name === currentSession) renderConn();
    clearTimeout(pane.rc);
    pane.rc = setTimeout(() => reconnectWhenUp(pane), 1500);
  };
}

// Firefox (Zen) delays every websocket to a host after each failed handshake. The delay
// grows x1.5 up to a minute and survives reloads. Blind retries during an outage (restart,
// sleep, network change) left panes on "connecting…" long after the server came back. A
// fetch doesn't count toward that delay, so probe with one and open the socket only once
// the server answers.
function reconnectWhenUp(pane) {
  if (pane.ended) return;
  fetch('/api/version', { cache: 'no-store' })
    .then((r) => {
      if (r.status >= 500) throw r;
      // Another path (tab refocus, scroll toggle) may have reconnected meanwhile.
      if (!pane.dispose && pane.ws?.readyState === WebSocket.CLOSED) connectPaneWs(pane);
    })
    .catch(() => { if (!pane.dispose) pane.rc = setTimeout(() => reconnectWhenUp(pane), 1500); });
}

function sendPaneResize(pane) {
  if (pane.ws?.readyState !== WebSocket.OPEN) return;
  // active:true only for the focused pane -> the server sizes the tmux window to
  // this device. Background warm panes resize just their own client terminal.
  pane.ws.send(JSON.stringify({ type: 'resize', cols: gCols, rows: gRows, active: pane.name === currentSession }));
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
  renderConn();
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
function refreshScrollBtn() { scrollBtn.textContent = scrollMode === 'fast' ? 'Fast' : 'tmux'; }
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
document.getElementById('sb-resume').addEventListener('click', openResumeModal);
document.getElementById('reload-btn').addEventListener('click', () => applyUpdate(pendingWorker));
// Same flip as the dashboard's; the terminal itself stays black either way.
document.getElementById('tb-theme').addEventListener('click', () => {
  const el = document.documentElement;
  const dark = el.dataset.theme ? el.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  el.dataset.theme = dark ? 'light' : 'dark';
  localStorage.setItem('ccdeck.theme', el.dataset.theme);
});

// Resume a past session: filterable list of on-disk sessions (History) → resume.
async function openResumeModal() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="max-width:520px">
    <h2>Resume a Deep Session</h2>
    <input id="rs-filter" aria-label="Filter Deep Sessions" placeholder="filter by title / directory…" spellcheck="false" autocomplete="off" style="margin-bottom:6px" />
    <div id="rs-list" class="seed-list"><div class="faint" style="padding:8px">Loading…</div></div>
    <div class="modal-actions"><button id="rs-cancel">Cancel</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#rs-cancel').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  const list = bg.querySelector('#rs-list');
  let items = [];
  try { items = (await api('/api/history')).sessions.filter((s) => s.cwd); }
  catch (e) { list.innerHTML = `<div class="faint" style="padding:8px">${esc(e.message)}</div>`; return; }
  list.innerHTML = items.map((s) =>
    `<div class="seed-item" data-id="${esc(s.sessionId)}" data-dir="${esc(s.cwd)}" data-title="${esc(s.title)}">
      <span class="seed-item-main"><span class="seed-item-title">${esc(s.title)}</span><span class="seed-item-meta faint">${esc(s.cwd)}${s.gitBranch ? ', ' + esc(s.gitBranch) : ''}</span></span>
    </div>`).join('') || '<div class="faint" style="padding:8px">No past Deep Sessions.</div>';
  bg.querySelector('#rs-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    list.querySelectorAll('.seed-item').forEach((el) => { el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
  list.querySelectorAll('.seed-item').forEach((el) => el.addEventListener('click', async () => {
    el.style.opacity = '.5';
    try {
      const { name } = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ dir: el.dataset.dir, title: el.dataset.title, resume: el.dataset.id }) });
      close();
      await refreshSessions();
      switchTo(name);
    } catch (e) { el.style.opacity = ''; toast('Resume failed: ' + e.message, { kind: 'error' }); }
  }));
}

// ---- new session modal (shared with the dashboard) ----
let cfg = null;
async function openNewModal() {
  if (!cfg) { try { cfg = await api('/api/config'); } catch { cfg = { roots: [] }; } }
  openNewModalShared({ api, cfg, onCreated: async (name) => { await refreshSessions(); switchTo(name); } });
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
  { label: '⌫', aria: 'Backspace', seq: '\x7f', repeat: true, title: 'Backspace (hold to repeat)' },
  { label: 'tab', seq: '\t' },
  { label: '⇧⇥', aria: 'Shift+Tab', seq: '\x1b[Z', title: 'Shift+Tab (cycles the permission mode)' },
  { label: 'ctrl', ctrl: true },
  { label: 'meta', meta: true },
  { label: '←', aria: 'Left', seq: '\x1b[D', repeat: true },
  { label: '↑', aria: 'Up', seq: '\x1b[A', repeat: true },
  { label: '↓', aria: 'Down', seq: '\x1b[B', repeat: true },
  { label: '→', aria: 'Right', seq: '\x1b[C', repeat: true },
  { label: '^C', aria: 'Ctrl+C', seq: '\x03' },
  { label: 'Dictate', dictate: true, title: 'Dictate or type a message, then send' },
  { label: 'Copy', copy: true, title: 'Copy on-screen text' },
  { label: 'Paste', paste: true, title: 'Paste from clipboard' },
];

// Copy the terminal's on-screen text out — xterm is a canvas so there's no native
// selection on touch; show it in a real (selectable) field to Copy-all or
// long-press-select. Uses xterm's buffer (the visible screen incl. scrollback).
function openCopyBox() {
  const term = panes.get(currentSession)?.term;
  if (!term) return;
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
  const textVal = out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="max-width:480px">
    <h2>Copy</h2>
    <p class="faint">Long-press to select text and use the OS <b>Copy</b>, or tap “Copy all”.</p>
    <textarea id="cp-ta" aria-label="On-screen text" readonly rows="9" style="width:100%;resize:vertical;font-family:var(--mono);font-size:12px"></textarea>
    <div class="modal-actions"><button id="cp-close">Close</button><button class="primary" id="cp-all">Copy all</button></div>
  </div>`;
  document.body.appendChild(bg);
  const ta = bg.querySelector('#cp-ta');
  ta.value = textVal || '(empty)';
  const close = () => { bg.remove(); panes.get(currentSession)?.term.focus(); };
  bg.querySelector('#cp-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('#cp-all').addEventListener('click', async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(textVal); ok = true; } catch { /* */ }
    if (!ok) { try { ta.removeAttribute('readonly'); ta.focus(); ta.setSelectionRange(0, ta.value.length); ok = document.execCommand('copy'); ta.setAttribute('readonly', ''); } catch { /* */ } }
    toast(ok ? 'Copied to clipboard' : 'Select the text and use the OS Copy', { kind: ok ? 'ok' : undefined });
    if (ok) close();
  });
}

// Paste into the active session as a bracketed paste (multi-line stays intact).
// iOS PWAs frequently block navigator.clipboard.readText() (esp. content copied
// from another app), so the reliable path is a real focused field the OS can
// paste into; the async clipboard API is just a fast auto-fill when it works.
function pasteClipboard() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="max-width:440px">
    <h2>Paste</h2>
    <p class="faint">Long-press the box, choose <b>Paste</b>, then Send. (On desktop, just press ⌘/Ctrl+V into the terminal.)</p>
    <textarea id="pb-ta" aria-label="Text to paste" rows="4" style="width:100%;resize:vertical" placeholder="paste here…"></textarea>
    <div class="modal-actions"><button id="pb-cancel">Cancel</button><button class="primary" id="pb-send">Send</button></div>
  </div>`;
  document.body.appendChild(bg);
  const ta = bg.querySelector('#pb-ta');
  ta.focus(); // synchronous, inside the tap gesture, so iOS raises the keyboard
  let sent = false;
  const close = () => { bg.remove(); panes.get(currentSession)?.term.focus(); };
  const send = () => {
    if (sent) return; sent = true;
    const v = ta.value;
    if (v) activeWs()?.send(`\x1b[200~${v}\x1b[201~`);
    close();
  };
  bg.querySelector('#pb-cancel').addEventListener('click', close);
  bg.querySelector('#pb-send').addEventListener('click', send);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  ta.addEventListener('paste', () => setTimeout(send, 30)); // auto-send after a native paste
  // Fast path: if the clipboard API is allowed, auto-fill + send instantly.
  navigator.clipboard?.readText?.().then((t) => { if (t && !sent) { ta.value = t; send(); } }).catch(() => {});
}
// Dictate/type a message in a normal textarea, then send it to the terminal.
// iOS keyboard dictation garbles input typed straight into xterm (each word
// doubles), but works correctly in a plain <textarea> — so compose here (tap the
// keyboard's mic to dictate), review, then send it to the session as one paste.
function composeAndSend() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="max-width:440px">
    <h2>Speak or type</h2>
    <p class="faint">Tap the microphone on your keyboard to dictate (or just type), then <b>Send</b>. Dictation doubles words when typed straight into the terminal, but is clean here.</p>
    <textarea id="cs-ta" aria-label="Message" rows="4" style="width:100%;resize:vertical" placeholder="Speak or type your message…"></textarea>
    <div class="modal-actions">
      <label class="faint" style="margin-right:auto;display:flex;align-items:center;gap:6px"><input type="checkbox" id="cs-submit" checked> Press Enter after</label>
      <button id="cs-cancel">Cancel</button><button class="primary" id="cs-send">Send</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const ta = bg.querySelector('#cs-ta');
  ta.focus(); // synchronous, inside the tap gesture, so iOS raises the keyboard
  let sent = false;
  const close = () => { bg.remove(); panes.get(currentSession)?.term.focus(); };
  const send = () => {
    if (sent) return; sent = true;
    const v = ta.value;
    if (v) {
      activeWs()?.send(`\x1b[200~${v}\x1b[201~`); // bracketed paste keeps multi-line intact
      if (bg.querySelector('#cs-submit').checked) activeWs()?.send('\r'); // submit to Claude
    }
    close();
  };
  bg.querySelector('#cs-cancel').addEventListener('click', close);
  bg.querySelector('#cs-send').addEventListener('click', send);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
}

const keybar = document.getElementById('keybar');
keybar.innerHTML = KEYS.map((k, i) =>
  `<button ${k.ctrl ? 'id="kb-ctrl"' : ''}${k.meta ? 'id="kb-meta"' : ''} data-i="${i}" title="${k.title || ''}"${k.aria ? ` aria-label="${k.aria}"` : ''}>${k.label}</button>`).join('');
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
    else if (k.dictate) { composeAndSend(); }
    else if (k.paste) { pasteClipboard(); }
    else if (k.copy) { openCopyBox(); }
    else sendKey(k.seq);
  });
});

// ---- ccburn quick-view (plan limits) in the top bar ----
let burn = null;
const burnBtn = document.getElementById('burn-btn');
async function loadBurn() { burn = await fetchBurn(); renderBurnPill(burnBtn, burn); return burn; }
burnBtn.addEventListener('click', (e) => { e.stopPropagation(); openBurnPopover(burnBtn, burn, loadBurn); });
loadBurn();
setInterval(loadBurn, 60_000);

// ---- send files / folder to the session ----
function pickAndUpload(folder) {
  pickFiles(folder, (files, withPaths) => openUploadModal(files, withPaths));
}

// Show the selected files and let the user choose/browse the destination folder
// (defaulting to the current session's cwd) before sending.
function openUploadModal(files, withPaths) {
  const cur = sessions.find((s) => s.name === currentSession);
  let currentPath = (cur && cur.dir) || '/';
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <h2>Send ${files.length} item${files.length === 1 ? '' : 's'}</h2>
      <div class="field">
        <label for="up-dir">Destination folder</label>
        <input id="up-dir" value="${esc(currentPath)}" spellcheck="false" />
        <div class="browser" id="up-browser"></div>
        <div class="mkdir-row">
          <input id="up-mk" aria-label="New folder name" placeholder="new-folder-name" spellcheck="false" autocapitalize="off" autocomplete="off" />
          <button type="button" id="up-mk-btn">Create folder here</button>
        </div>
      </div>
      <div class="field">
        <label>Sending</label>
        <div class="up-files" tabindex="0" role="region" aria-label="Files to send">${files.map((f) => `<div class="up-f">${esc((withPaths && f.webkitRelativePath) || f.name)}</div>`).join('')}</div>
      </div>
      <div class="error" id="up-err"></div>
      <div class="modal-actions">
        <button id="up-cancel">Cancel</button>
        <button class="primary" id="up-go">Upload here</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  const dirInput = bg.querySelector('#up-dir');
  const browser = bg.querySelector('#up-browser');
  const errEl = bg.querySelector('#up-err');
  async function browse(path) {
    try {
      const { path: abs, dirs } = await api(`/api/fs?path=${encodeURIComponent(path)}`);
      currentPath = abs; dirInput.value = abs;
      const parent = abs.split('/').slice(0, -1).join('/') || '/';
      browser.innerHTML = `<div class="row up" data-path="${esc(parent)}">..</div>` +
        dirs.map((d) => `<div class="row" data-path="${esc(d.path)}">${esc(d.name)}/</div>`).join('');
      browser.querySelectorAll('.row').forEach((r) => r.addEventListener('click', () => browse(r.dataset.path)));
    } catch (e) { errEl.textContent = e.message; }
  }
  browse(currentPath);
  dirInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') browse(dirInput.value); });
  const mk = bg.querySelector('#up-mk');
  async function mkdirHere() {
    const name = mk.value.trim();
    if (!name) { mk.focus(); return; }
    errEl.textContent = '';
    try { const { created } = await api('/api/fs', { method: 'POST', body: JSON.stringify({ parent: currentPath, name }) }); mk.value = ''; await browse(created); }
    catch (e) { errEl.textContent = e.message; }
  }
  bg.querySelector('#up-mk-btn').addEventListener('click', mkdirHere);
  mk.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); mkdirHere(); } });
  const close = () => bg.remove();
  bg.querySelector('#up-cancel').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('#up-go').addEventListener('click', () => {
    const dir = dirInput.value.trim();
    close();
    sendFiles(files, withPaths, dir);
  });
}

document.getElementById('upload-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = document.getElementById('upload-menu');
  if (open) { open.remove(); return; }
  const m = document.createElement('div');
  m.id = 'upload-menu';
  m.className = 'upload-menu';
  const desktop = !matchMedia('(max-width: 700px)').matches; // iOS can't pick folders
  m.innerHTML = `<button data-folder="0">Files…</button>${desktop ? '<button data-folder="1">Folder…</button>' : ''}`;
  const r = e.currentTarget.getBoundingClientRect();
  m.style.top = `${r.bottom + 4}px`;
  m.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  document.body.appendChild(m);
  m.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { m.remove(); pickAndUpload(b.dataset.folder === '1'); }));
  setTimeout(() => document.addEventListener('click', function h() { m.remove(); document.removeEventListener('click', h); }, { once: true }), 0);
});

// Keep the layout (and key bar) above the iOS on-screen keyboard — but ONLY while
// the keyboard is actually up. Pinning to the visual-viewport height when it's
// down leaves a gap at the bottom in standalone mode, so otherwise fall back to
// the CSS 100dvh (clear the inline height).
if (isMobile && window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => {
    const keyboardUp = window.innerHeight - vv.height > 120;
    appEl.style.height = keyboardUp ? `${vv.height}px` : '';
    fitActive();
  };
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
  if (s.remote) return s.attached ? 'live' : 'ready'; // no claude status over SSH — show reachability
  if (s.waitingFor) return 'attn';
  if (s.claudeStatus === 'busy') return 'live';
  if (s.claudeStatus === 'idle') return 'ready';
  return isLive(s) ? 'live' : 'idle';
}
function needsAttention(s) {
  return attention.has(s.name);
}
function titleOf(name) { return sessions.find((s) => s.name === name)?.title || name; }
function baseName(p) { if (!p) return ''; return p.replace(/\/$/, '').split('/').slice(-2).join('/'); }
// Most recently active first, so the session you just typed in rises to the top.
function orderedSessions() { return [...sessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)); }
// Sidebar/jump order: native sessions first, then remote — each activity-sorted.
// The single source of truth for both the rendered grouping and Alt+1–9 numbering.
function groupedSessions() { const a = orderedSessions(); return [...a.filter((s) => !s.remote), ...a.filter((s) => s.remote)]; }
function mruOrderedExisting() {
  const names = new Set(sessions.map((s) => s.name));
  const inMru = mru.filter((n) => names.has(n));
  return [...inMru, ...sessions.map((s) => s.name).filter((n) => !inMru.includes(n))];
}

async function refreshSessions() {
  try {
    const { sessions: list } = await api('/api/sessions');
    sessions = list.concat(remoteCache); // remote sessions ride along (inert in the status logic below)
    // Flag a session for attention when it's blocked on you (waitingFor) or it
    // just finished (busy -> idle). Clear when it resumes working. Current session
    // is never flagged (you're looking at it). Background output alone doesn't flag.
    for (const s of sessions) {
      if (s.name !== currentSession) {
        if (s.waitingFor || (prevStatus[s.name] === 'busy' && s.claudeStatus === 'idle')) attention.add(s.name);
        else if (s.claudeStatus === 'busy') attention.delete(s.name);
      }
      prevStatus[s.name] = s.claudeStatus;
    }
    attention.delete(currentSession);
    titleEl.textContent = document.title = titleOf(currentSession);
    renderParked();
    renderSidebar();
  } catch { /* */ }
}

// Poll remote tmux sessions (over SSH, server-side) on their own cadence so a
// slow/unreachable host never stalls the local session refresh. Attach-only.
async function refreshRemote() {
  let next;
  // name := the remote id ("remote:<host>:<tmux>"), so every s.name code path
  // (sidebar, switchTo, panes, the /ws/attach URL) works unchanged.
  try { const r = await api('/api/remote/sessions'); next = (r.sessions || []).filter((s) => !s.error && s.id).map((s) => ({ ...s, name: s.id })); }
  catch { return; } // keep the last good list on a hiccup
  remoteCache = next;
  sessions = sessions.filter((s) => !s.remote).concat(remoteCache);
  renderSidebar();
}

// share/branch glyph (inline SVG → renders identically everywhere)
const SHARE_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h5v5M14 2 7 9M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5"/></svg>';

// Top-bar note badge for the CURRENT session (kept out of the hover-actions
// overlay). Driven from the sessions list on every refresh + switch.
function updateNotesBtn() {
  const btn = document.getElementById('notes-btn');
  const s = sessions.find((x) => x.name === currentSession);
  const n = s?.noteCount || 0;
  if (!n) { btn.style.display = 'none'; return; }
  btn.textContent = `${n} note${n === 1 ? '' : 's'}`;
  btn.title = `${n} update(s) from outside chats. View or apply them.`;
  btn.style.display = '';
}
document.getElementById('notes-btn').addEventListener('click', () => {
  const s = sessions.find((x) => x.name === currentSession);
  if (s) openNotes(s.liveSessionId || s.resumedFrom, s.name, refreshSessions);
});

function sidebarItemHtml(s, i) {
  const cur = s.name === currentSession;
  const att = needsAttention(s);
  const num = i < 9 ? `<span class="sb-num">${i + 1}</span>` : '';
  const dirLine = s.remote ? `${esc(s.host)}: ${esc(baseName(s.dir))}` : esc(baseName(s.dir));
  // Badge non-Claude CLIs (e.g. codex) so it's clear which tool a session runs.
  const cliTag = (s.kind && s.kind !== 'claude') ? `<span class="sb-cli" title="${esc(s.kind)} CLI">${esc(s.kind)}</span>` : '';
  // Remote sessions (over SSH) are attach-only for now — no rename/kill/share.
  const actions = s.remote
    ? `<span class="sb-remote-tag" title="Remote tmux session on ${esc(s.host)}, attach only">${esc(s.paneCommand || 'remote')}</span>`
    : `${s.liveSessionId ? `<button class="sb-share" title="Share this Deep Session's context" data-share="${esc(s.name)}">${SHARE_ICON}</button>` : ''}
        <button class="sb-rename" title="Rename Deep Session" aria-label="Rename Deep Session" data-rename="${esc(s.name)}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 2.5 13.5 5 5.5 13H3v-2.5z"/></svg></button>
        <button class="sb-kill" title="Kill Deep Session" aria-label="Kill Deep Session" data-kill="${esc(s.name)}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
  return `<div class="sb-item ${cur ? 'current' : ''} ${att ? 'attn' : ''} ${s.remote ? 'remote' : ''}" data-name="${esc(s.name)}">
      <span class="sb-dot ${statusDot(s)}"></span>
      <span class="sb-meta"><span class="sb-title">${cliTag}${esc(s.title)}</span><span class="sb-dir">${dirLine}</span></span>
      ${att ? '<span class="sb-attn" role="img" title="Needs your attention" aria-label="Needs your attention"></span>' : num}
      <div class="sb-actions">${actions}</div>
    </div>`;
}

function renderSidebar() {
  const list = document.getElementById('sb-list');
  const ordered = orderedSessions();
  const local = ordered.filter((s) => !s.remote);
  const remote = ordered.filter((s) => s.remote);
  const group = (label) => `<div class="sb-group">${esc(label)}</div>`;
  // Numbering is continuous across the grouped order (native then remote) so it
  // matches groupedSessions() / Alt+1–9. Headers only appear once remotes exist.
  let idx = 0;
  let html = '';
  if (remote.length && local.length) html += group('Native');
  html += local.map((s) => sidebarItemHtml(s, idx++)).join('');
  if (remote.length) { html += group('Remote'); html += remote.map((s) => sidebarItemHtml(s, idx++)).join(''); }
  list.innerHTML = html || '<div class="faint" style="padding:12px">No active Deep Sessions</div>';
  list.querySelectorAll('.sb-item').forEach((el) =>
    el.addEventListener('click', (e) => { if (!e.target.closest('.sb-kill, .sb-rename, .sb-share')) switchTo(el.dataset.name); }));
  updateNotesBtn();
  list.querySelectorAll('.sb-rename').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); renameSessionFromSidebar(b.dataset.rename); }));
  list.querySelectorAll('.sb-kill').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); killSessionFromSidebar(b.dataset.kill); }));
  list.querySelectorAll('.sb-share').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = sessions.find((x) => x.name === b.dataset.share);
      if (s && s.liveSessionId) openShare(s.liveSessionId, { cwd: s.dir, title: s.title });
    }));
  const attnCount = sessions.filter(needsAttention).length;
  const badge = document.getElementById('sb-badge');
  badge.style.display = attnCount ? '' : 'none';
  badge.textContent = attnCount;
}

async function renameSessionFromSidebar(name) {
  const s = sessions.find((x) => x.name === name);
  const title = prompt('Rename Deep Session', s?.title || '');
  if (title == null) return;
  const rename = async () => {
    try { await api(`/api/sessions/${name}`, { method: 'PATCH', body: JSON.stringify({ title }) }); }
    catch (e) { toast('Rename failed: ' + e.message, { kind: 'error', action: 'Retry', onAction: rename }); return; }
    await refreshSessions();
  };
  await rename();
}

async function killSessionFromSidebar(name) {
  const s = sessions.find((x) => x.name === name);
  if (!confirm(`Kill Deep Session "${s?.title || name}"? Its CLI and tmux session will be stopped.`)) return;
  await killSession(name);
}
async function killSession(name) {
  try { await api(`/api/sessions/${name}`, { method: 'DELETE' }); }
  catch (e) { toast('Kill failed: ' + e.message, { kind: 'error', action: 'Retry', onAction: () => killSession(name) }); return; }
  if (panes.has(name)) disposePane(name);
  await refreshSessions();
  if (name === currentSession) {
    const next = groupedSessions()[0]; // killed one is gone from the list now (prefers a native session)
    if (next) switchTo(next.name); // currentSession is still the (dead) name, so this proceeds
    else location.href = '/'; // nothing left to show
  }
}

// ---- switching (instant when the target is already warm) ----
function switchTo(name) {
  if (!name || name === currentSession) return;
  if (!panes.has(name)) makePane(name);
  currentSession = name;
  bumpMru(name);
  attention.delete(name); // you're now viewing it
  history.replaceState({}, '', `?session=${encodeURIComponent(name)}`);
  titleEl.textContent = document.title = titleOf(name);
  renderParked();
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
// A grid, so a long MRU list fits on screen. Columns fill the width (max 6);
// arrows move by cell/row, Enter or a click picks.
const swCols = () => Math.max(1, Math.min(swList.length, 6, Math.floor((innerWidth * 0.9 - 20) / 226)));
function renderSwitcher() {
  swBox.style.setProperty('--cols', swCols());
  swBox.innerHTML = swList.map((name, i) => {
    const s = sessions.find((x) => x.name === name) || {};
    return `<div class="sw-item ${i === swIdx ? 'sel' : ''}" data-i="${i}">
      <span class="sb-dot ${statusDot(s)}"></span><span class="sw-t">${esc(titleOf(name))}${needsAttention(s) ? ' <span class="sb-attn" role="img" aria-label="Needs your attention"></span>' : ''}</span>
      <span class="sw-d">${esc(baseName(s.dir))}</span>
    </div>`;
  }).join('');
  swBox.children[swIdx]?.scrollIntoView({ block: 'nearest' });
}
sw.addEventListener('click', (e) => {
  const it = e.target.closest('.sw-item');
  if (it) { swIdx = Number(it.dataset.i); commitSwitcher(); } else if (e.target === sw) { sw.style.display = 'none'; switching = false; switchMod = null; }
});
function commitSwitcher() {
  sw.style.display = 'none';
  if (switching && swList[swIdx]) switchTo(swList[swIdx]);
  switching = false; switchMod = null;
}

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'Backquote') { e.preventDefault(); cycle('Alt', e.shiftKey); return; }
  if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycle('Control', e.shiftKey); return; }
  if (switching && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
    e.preventDefault(); e.stopPropagation(); // not to the terminal, not browser back/forward
    const c = swCols();
    stepSwitcher({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -c, ArrowDown: c }[e.key]);
    return;
  }
  if (switching && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitSwitcher(); return; }
  if (switching && e.key === 'Escape') { sw.style.display = 'none'; switching = false; switchMod = null; e.preventDefault(); return; }
  if (e.altKey && /^Digit[1-9]$/.test(e.code)) { const t = groupedSessions()[Number(e.code.slice(5)) - 1]; if (t) { e.preventDefault(); switchTo(t.name); } }
}, true);
window.addEventListener('keyup', (e) => {
  if (!switching || !switchMod) return;
  const released = (switchMod === 'Alt' && (e.key === 'Alt' || !e.altKey)) || (switchMod === 'Control' && (e.key === 'Control' || !e.ctrlKey));
  if (released) { e.preventDefault(); commitSwitcher(); }
}, true);

window.addEventListener('beforeunload', () => { for (const p of panes.values()) { p.dispose = true; try { p.ws?.close(); } catch { /* */ } } });

// Offer a reload when a new build is deployed.
let appVersion = null;
let pendingWorker = null;
function showUpdateToast(worker) {
  if (worker) pendingWorker = worker;
  if (document.getElementById('update-toast')) return;
  const t = document.createElement('div');
  t.id = 'update-toast'; t.className = 'toast';
  t.innerHTML = 'New version available <button class="primary" style="margin-left:8px;padding:5px 12px">Reload</button>';
  t.querySelector('button').addEventListener('click', () => applyUpdate(pendingWorker));
  document.body.appendChild(t);
}
async function checkVersion() {
  try {
    const { v } = await api('/api/version');
    if (appVersion === null) appVersion = v;
    else if (v && v !== appVersion) showUpdateToast();
  } catch { /* */ }
}
registerServiceWorker((w) => showUpdateToast(w));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  checkVersion();
  // A pane that dropped while the tab was hidden waits on a reconnect timer the browser
  // throttled. Reconnect it now so coming back never shows "connecting…".
  for (const p of panes.values()) if (p.ws?.readyState === WebSocket.CLOSED) { clearTimeout(p.rc); reconnectWhenUp(p); }
});

// ---- boot ----
if (!currentSession) {
  location.replace('/'); // nothing to attach to: back to the dashboard
} else {
  makePane(currentSession);
  showPane(currentSession);
  applySidebar();
  refreshSessions().then(reconcileWarm); // preload the recent sessions
  setInterval(refreshSessions, 3000);
  refreshRemote(); // remote tmux sessions (if any hosts configured) — slower cadence
  setInterval(refreshRemote, 10000);
  checkVersion();
  setInterval(checkVersion, 30000);
}
