import pkg from 'node-pty';
import { isRequestAuthed } from './auth.js';
import { isManagedName, setMouse, resizeWindow, TMUX_ARGS } from './tmux.js';

const { spawn } = pkg;

// Last window size we applied per session, to skip redundant resize-window calls.
const appliedSize = new Map();

// Alternate-screen enable/disable sequences. In "fast" scroll mode we strip
// these so tmux renders on xterm's main buffer, which keeps a local scrollback
// the wheel can scroll instantly client-side (no per-notch round-trip).
const ALT_SCREEN_RE = /\x1b\[\?(?:1049|1047|47)[hl]/g;

// Handle a websocket that bridges the browser terminal to `tmux attach`.
export function attachHandler(socket, req) {
  const cookieHeader = req.headers.cookie;
  if (!isRequestAuthed(cookieHeader)) {
    socket.close(4401, 'unauthorized');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const session = url.searchParams.get('session');
  if (!isManagedName(session)) {
    socket.close(4400, 'invalid session');
    return;
  }

  let curCols = clampInt(url.searchParams.get('cols'), 80, 20, 500);
  let curRows = clampInt(url.searchParams.get('rows'), 24, 5, 300);
  const cols = curCols, rows = curRows;
  const fast = url.searchParams.get('scroll') === 'fast';

  // Size the tmux window to THIS client (the device interacting), deduped.
  const sizeWindowToClient = () => {
    const key = `${curCols}x${curRows}`;
    if (appliedSize.get(session) === key) return;
    appliedSize.set(session, key);
    resizeWindow(session, curCols, curRows).catch(() => {});
  };

  // Disable Nagle's algorithm: terminal redraws are small and latency-sensitive,
  // so send them immediately instead of coalescing (smoother scroll + typing).
  try { socket._socket?.setNoDelay?.(true); } catch { /* */ }

  // tmux scroll: mouse ON (wheel → copy-mode). fast scroll: mouse OFF (wheel
  // scrolls xterm's local buffer instead). Applies to existing sessions too.
  setMouse(session, !fast).catch(() => {});

  let pty;
  try {
    pty = spawn('tmux', [...TMUX_ARGS, 'attach', '-t', session], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
  } catch (err) {
    socket.send(`\r\n[cc-deck] failed to attach: ${err.message}\r\n`);
    socket.close(1011, 'attach failed');
    return;
  }

  // In fast mode, strip alt-screen sequences (holding back a trailing partial
  // escape across chunk boundaries so we never split a sequence mid-strip).
  let carry = '';
  const send = (data) => {
    if (socket.readyState !== socket.OPEN) return;
    if (!fast) { socket.send(data); return; }
    let s = carry + data;
    carry = '';
    const partial = s.match(/\x1b(?:\[[0-9?;]*)?$/);
    if (partial) { carry = partial[0]; s = s.slice(0, s.length - carry.length); }
    socket.send(s.replace(ALT_SCREEN_RE, ''));
  };

  pty.onData(send);

  pty.onExit(() => {
    if (socket.readyState === socket.OPEN) socket.close(1000, 'pty exited');
  });

  socket.on('message', (raw) => {
    const msg = raw.toString();
    // Control messages are JSON; everything else is raw keystrokes.
    if (msg.length && msg[0] === '{') {
      try {
        const obj = JSON.parse(msg);
        if (obj.type === 'resize') {
          curCols = clampInt(obj.cols, curCols, 20, 500);
          curRows = clampInt(obj.rows, curRows, 5, 300);
          pty.resize(curCols, curRows); // size THIS client's terminal (render correctly)
          // Only the active/foreground pane flags `active` -> drive the window size
          // to this device. Background warm panes resize their own client only.
          if (obj.active) sizeWindowToClient();
          return;
        }
        if (obj.type === 'input' && typeof obj.data === 'string') {
          sizeWindowToClient(); // typing = this device is the active one
          pty.write(obj.data);
          return;
        }
      } catch {
        // Not JSON — fall through and treat as input.
      }
    }
    sizeWindowToClient(); // raw keystrokes/scroll = active interaction on this device
    pty.write(msg);
  });

  const cleanup = () => {
    try {
      pty.kill(); // Detaches the tmux client; the session keeps running.
    } catch {
      /* already gone */
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
