import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import css from './styles.css';

const styleEl = document.createElement('style');
styleEl.textContent = css;
document.head.appendChild(styleEl);

const params = new URLSearchParams(location.search);
const session = params.get('session');

document.body.innerHTML = `
  <div class="term-bar">
    <a href="/" title="Back to dashboard">←</a>
    <span class="title" id="title">${session || 'session'}</span>
    <div class="spacer" style="flex:1"></div>
    <span class="status" id="status">connecting…</span>
  </div>
  <div id="terminal"></div>`;

const statusEl = document.getElementById('status');

const term = new Terminal({
  fontFamily: "'JetBrains Mono','SF Mono','Fira Code',ui-monospace,monospace",
  fontSize: 13,
  lineHeight: 1.0,
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: true,
  theme: {
    background: '#0a0d12',
    foreground: '#e6edf3',
    cursor: '#d97757',
    selectionBackground: '#2a3344',
    black: '#0a0d12', brightBlack: '#5c6877',
    red: '#ff8d85', brightRed: '#ff8d85',
    green: '#5cb87a', brightGreen: '#5cb87a',
    yellow: '#e0c060', brightYellow: '#e0c060',
    blue: '#6ea8fe', brightBlue: '#6ea8fe',
    magenta: '#c099ff', brightMagenta: '#c099ff',
    cyan: '#5fd3d3', brightCyan: '#5fd3d3',
    white: '#e6edf3', brightWhite: '#ffffff',
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
// Prefer the GPU (WebGL) renderer; fall back to canvas (still much faster than
// the default DOM renderer) if WebGL is unavailable or its context is lost.
function useCanvas() {
  try { term.loadAddon(new CanvasAddon()); } catch { /* DOM renderer */ }
}
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => { webgl.dispose(); useCanvas(); });
  term.loadAddon(webgl);
} catch {
  useCanvas();
}
fit.fit();

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls || ''}`;
}

let ws;
let reconnectTimer;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/attach?session=${encodeURIComponent(session)}&cols=${term.cols}&rows=${term.rows}`;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('connected', 'connected');
    sendResize();
    term.focus();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') term.write(ev.data);
    else term.write(new Uint8Array(ev.data));
  };
  ws.onclose = (ev) => {
    if (ev.code === 4401) {
      location.href = '/login.html';
      return;
    }
    setStatus('disconnected — reconnecting…', 'closed');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => setStatus('connection error', 'closed');
}

function sendResize() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

term.onData((data) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
});

let resizeTimer;
const onResize = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fit.fit();
    sendResize();
  }, 100);
};
window.addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(document.getElementById('terminal'));

if (!session) {
  setStatus('no session specified', 'closed');
} else {
  connect();
}
