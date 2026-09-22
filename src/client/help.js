// In-app Help page + first-run walkthrough. Static content (no user data), so the
// HTML is written directly. openHelp() shows the full reference; maybeShowIntro()
// shows a short welcome once (localStorage-gated).

const INTRO_KEY = 'ccdeck.introSeen.v1';

const SECTIONS = [
  ['What are Deep Sessions', `
    <p>A dashboard for your <b>coding-CLI Deep Sessions</b> (Claude Code, Codex, and agy). Each Deep Session is a
    real CLI running inside a <b>tmux</b> session on the server, shown through a fast in-browser
    terminal — the actual CLI, not a wrapper. Closing the tab only <i>detaches</i>; the Deep Session
    keeps running. Reach it from any device on your tailnet (or behind Cloudflare Access).</p>`],

  ['Start a Deep Session', `
    <p>Click <b>+ New Deep Session</b>:</p>
    <ul>
      <li><b>Directory</b> — where the CLI runs. Browse to it, or create a folder inline. Must be
        under an allowed root.</li>
      <li><b>CLI</b> — Claude or Codex (when both are available).</li>
      <li><b>Title</b> — optional label.</li>
      <li><b>Browser access</b> — optionally let the Deep Session drive a shared logged-in Chrome.</li>
      <li><b>Context from prior Deep Sessions</b> — seed the new Deep Session with a handoff summary or
        transcript from one or more past Deep Sessions.</li>
    </ul>
    <p>Launch, then click the card (or use the sidebar in the terminal) to open it.</p>`],

  ['Tabs', `
    <ul>
      <li><b>Active</b> — your running Deep Sessions, as cards (with live previews), a compact list, or
        grouped by directory.</li>
      <li><b>History</b> — past Deep Sessions from your CLI's store. <b>▶ Resume</b> reopens one as a
        fresh live Deep Session in its original directory (Claude; Codex resumes via its own picker).</li>
      <li><b>Usage</b> — token spend and plan ROI (see Usage &amp; limits).</li>
      <li><b>Files</b> — browse, download, delete, or drag-drop files into a Deep Session's directory.</li>
    </ul>`],

  ['Find &amp; organize', `
    <p>The status tiles up top double as filters. <b>Fuzzy search</b> matches title, directory, and
    git branch instantly. Toggle <b>Grid / List / Group</b> views; grouped view collapses by
    directory so you can scan many at once.</p>`],

  ['The terminal', `
    <ul>
      <li><b>Attach vs. detach</b> — closing the browser detaches; the Deep Session keeps running.
        Use ✕ (kill) to actually end it.</li>
      <li><b>Scroll mode</b> — toggle <i>tmux</i> (native copy-mode, full history) vs <i>fast</i>
        (wheel scrolls the local buffer instantly).</li>
      <li><b>Warm Deep Sessions</b> — the current + 2 most-recent stay attached in the background, so
        switching between them is instant.</li>
      <li><b>Mobile</b> — an on-screen key bar (Esc/Tab/Ctrl/arrows) plus <b>🎤</b> to dictate or
        type a message and send it (iOS dictation is clean there, unlike straight into the terminal).</li>
      <li><b>Copy / paste</b> — ⧉ copies the on-screen text; ⎘ pastes into the Deep Session.</li>
    </ul>`],

  ['Switch Deep Sessions', `
    <p>The terminal sidebar lists every Deep Session (grouped <b>Native</b> vs <b>Remote</b>), with
    live/idle and needs-attention dots. Click to switch, or:</p>
    <ul>
      <li><b>Alt+\` / Alt+Shift+\`</b> — cycle most-recently-used.</li>
      <li><b>Alt+1–9</b> — jump to a Deep Session by its number.</li>
    </ul>`],

  ['Resume &amp; fork', `
    <p>From <b>History</b>, <b>Resume</b> continues a past Deep Session; <b>fork</b> branches a copy and
    leaves the original untouched. Resuming injects any external handoff notes left for that Deep Session.
    Codex Deep Sessions resume through Codex's own picker (<code>codex resume</code>) rather than a list.</p>`],

  ['Multiple CLIs (Claude, Codex &amp; agy)', `
    <p>Pick the CLI per Deep Session in the New Deep Session dialog; Deep Sessions are badged by CLI. All get the
    core surface (terminal, attach, kill, rename, snapshot, remote) <b>and</b> cross-Deep-Session notes —
    with <code>CCDECK_SESSION_MCP=on</code>, every Deep Session (Claude, Codex, agy) is wired with the
    read-only cc-deck MCP, so any of them can search siblings and leave a note on another Deep Session
    (any CLI) that surfaces when it next opens. Still Claude-only for now: live status dots,
    History-tab resume, usage/ROI, and the shared-browser auto-wire (the other CLIs don't expose the
    needed APIs yet).</p>`],

  ['Remote Deep Sessions', `
    <p>Deep Sessions can list and attach tmux sessions running a CLI on <b>other hosts</b> (a laptop, another
    box) over SSH — shown in the sidebar's <b>Remote</b> group, tagged by host. Attach-only for now.
    Requires key-based SSH to the host and the Deep Session running inside tmux. Configured via
    <code>CCDECK_REMOTE_HOSTS</code>.</p>`],

  ['Usage &amp; limits', `
    <p>The <b>Usage</b> tab shows token spend and the API-equivalent dollar value of your usage vs your
    subscription (are you breaking even?), a daily chart, and a per-model breakdown — for all local
    Claude Code CLI usage (not claude.ai web/mobile). If <b>ccburn</b> is installed, the top-bar pill
    shows live session (5h) + weekly plan-limit utilization (and model-scoped limits like Fable), with
    pace indicators; tap it for detail.</p>`],

  ['Notes &amp; handoff', `
    <p>Deep Sessions can hand context to each other. A <b>context handoff</b> seeds a new (or running)
    Deep Session with an AI summary or transcript of prior Deep Sessions. <b>External notes</b> (left via the
    MCP <code>save_session_summary</code> tool) surface on a Deep Session's card (📝) and are injected when
    you next open/resume it — so a Deep Session picks up what happened elsewhere.</p>`],

  ['Reliability', `
    <p><b>Snapshot / restore</b>: your active Deep Sessions are snapshotted periodically, on graceful stop, and
    via 💾 — and relaunched (<code>--resume</code>) after a host reboot. It's an installable
    <b>PWA</b> (add to home screen) with offline app-shell. The <b>🗄 Storage</b> hub inventories and
    prunes old artifacts/transcripts (running Deep Sessions protected).</p>`],

  ['Remote control (MCP)', `
    <p>Deep Sessions exposes an <b>MCP endpoint</b> (<code>/mcp</code>) so Claude.ai, Claude Code, or your own
    agent can search your past Deep Sessions, read a Deep Session's context, leave handoff notes, and — with the
    right token — create and drive Deep Sessions. New Deep Sessions can be auto-wired "handoff-aware" so they
    discover related work and hand off instead of duplicating.</p>`],

  ['Shared browser', `
    <p>Deep Sessions can share one already-logged-in Chrome (over CDP), coordinated by a <b>lock registry</b>
    (<code>browser_tabs</code> / <code>browser_claim</code> / <code>browser_release</code>): each agent
    works in its own tab so they don't collide. Enable per Deep Session (New Deep Session → Browser access) or for
    all Deep Sessions (<code>CCDECK_SESSION_BROWSER</code>).</p>`],

  ['Keyboard shortcuts', `
    <table class="help-kbd">
      <tr><td><kbd>Alt</kbd>+<kbd>\`</kbd></td><td>cycle recent Deep Sessions</td></tr>
      <tr><td><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>\`</kbd></td><td>cycle backwards</td></tr>
      <tr><td><kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd></td><td>jump to Deep Session N</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Tab</kbd></td><td>cycle (where the browser allows)</td></tr>
    </table>`],

  ['Setup &amp; config', `
    <p>Run it natively (<code>./setup.sh</code>) or via <b>Docker</b> (<code>docker compose up -d</code> —
    works on Windows/macOS/Linux and bundles both CLIs). Log the CLIs in once. All settings are
    environment variables (password, roots, permission mode, remote hosts, MCP tokens, shared browser…).
    See the project <b>README</b> for the full list and for serving over Tailscale/Cloudflare.</p>`],
];

function helpHtml() {
  const nav = SECTIONS.map((s, i) => `<a href="#hs${i}">${s[0]}</a>`).join('');
  const body = SECTIONS.map((s, i) => `<section id="hs${i}"><h3>${s[0]}</h3>${s[1]}</section>`).join('');
  return `<div class="modal help-modal">
    <div class="help-head"><h2>Deep Sessions Help</h2><button id="help-close" class="icon" title="Close">✕</button></div>
    <nav class="help-nav">${nav}</nav>
    <div class="help-body">${body}</div>
  </div>`;
}

export function openHelp() {
  if (document.getElementById('help-modal-bg')) return;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'help-modal-bg';
  bg.innerHTML = helpHtml();
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#help-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  // In-page nav jumps within the scrollable body.
  bg.querySelectorAll('.help-nav a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    bg.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
}

// First visit: a short welcome, with a link to the full help. Shown once.
export function maybeShowIntro() {
  let seen = false;
  try { seen = localStorage.getItem(INTRO_KEY) === '1'; } catch { /* private mode */ }
  if (seen) return;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal intro-modal">
    <h2>Welcome to Deep Sessions 👋</h2>
    <p>Manage your <b>Claude Code and Codex</b> Deep Sessions from the browser — the real CLIs, running in
    tmux on the server, through a fast in-browser terminal.</p>
    <ol class="intro-steps">
      <li><b>+ New Deep Session</b> — pick a directory and CLI, and launch.</li>
      <li><b>Open it</b> — click the card (or the sidebar) for a full terminal. Closing the tab
        <i>detaches</i>; the Deep Session keeps running.</li>
      <li><b>Tabs</b> — <b>History</b> to resume past work, <b>Usage</b> for spend/limits, <b>Files</b>
        to move files in.</li>
      <li>Switch fast with <kbd>Alt</kbd>+<kbd>\`</kbd> or <kbd>Alt</kbd>+<kbd>1–9</kbd>.</li>
    </ol>
    <div class="modal-actions">
      <button id="intro-help">Open full help</button>
      <button class="primary" id="intro-go">Get started</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const done = () => { try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* */ } bg.remove(); };
  bg.querySelector('#intro-go').addEventListener('click', done);
  bg.querySelector('#intro-help').addEventListener('click', () => { done(); openHelp(); });
}
