// In-app Help page + first-run walkthrough. Static content (no user data), so the
// HTML is written directly. openHelp() shows the full reference; maybeShowIntro()
// shows a short welcome once (localStorage-gated).

const INTRO_KEY = 'ccdeck.introSeen.v1';

const SECTIONS = [
  ['What are Deep Sessions', `
    <p>Polymux is a dashboard for your <b>coding-CLI Deep Sessions</b> (Claude Code, Codex and agy). Each Deep Session is
    the real CLI running inside a <b>tmux</b> session on the server, shown through a fast in-browser terminal rather
    than a wrapper. Closing the tab only <i>detaches</i>, and the Deep Session keeps running. Reach it from any device
    on your tailnet (or behind Cloudflare Access).</p>`],

  ['Start a Deep Session', `
    <p>Click <b>New Deep Session</b> and fill in the form:</p>
    <ul>
      <li><b>Directory</b> is where the CLI runs. Browse to it or create a folder inline; it must be under an
        allowed root.</li>
      <li><b>CLI</b> picks Claude, Codex or agy. Only the installed ones are offered.</li>
      <li><b>Title</b> is an optional label.</li>
      <li><b>Browser access</b> lets the Deep Session drive a shared logged-in Chrome.</li>
      <li><b>Context from prior Deep Sessions</b> seeds the new Deep Session with a handoff summary or
        transcript from one or more past Deep Sessions.</li>
    </ul>
    <p>Launch it, then click its card (or use the sidebar in the terminal) to open it.</p>`],

  ['Tabs', `
    <ul>
      <li><b>Active</b> shows your running Deep Sessions as cards with live previews, as a compact list, or
        grouped by directory.</li>
      <li><b>History</b> lists past Deep Sessions from your CLI's store. <b>Resume</b> reopens one as a
        fresh live Deep Session in its original directory (Claude; Codex resumes through its own picker).</li>
      <li><b>Usage</b> shows token spend and plan value (see Usage and limits).</li>
      <li><b>Files</b> lets you browse, download, delete or drag files into a Deep Session's directory.</li>
    </ul>`],

  ['Find and organize', `
    <p>The status tiles up top double as tab switches. <b>Search</b> matches title, directory and
    git branch instantly. Switch between <b>Grid</b>, <b>List</b> and <b>Group</b>; Group collapses by
    directory so you can scan many at once.</p>`],

  ['The terminal', `
    <ul>
      <li><b>Attach and detach.</b> Closing the browser detaches, and the Deep Session keeps running.
        Use <b>Kill</b> to actually end it.</li>
      <li><b>Scroll mode</b> switches between <i>tmux</i> (native copy mode, full history) and <i>Fast</i>
        (the wheel scrolls the local buffer instantly).</li>
      <li><b>Warm Deep Sessions.</b> The current one and the 2 most recent stay attached in the background, so
        switching between them is instant.</li>
      <li><b>Parked panes.</b> If a Deep Session is showing a background job instead of its main
        conversation, its card and the terminal bar say <b>Back to main</b>; click it to swap back.</li>
      <li><b>On a phone</b> there is an on-screen key bar (Esc, Tab, Shift+Tab, Ctrl, arrows) plus <b>Dictate</b>
        to dictate or type a message and send it. iOS dictation is clean there, unlike straight into the terminal.</li>
      <li><b>Copy</b> copies the on-screen text and <b>Paste</b> pastes into the Deep Session.</li>
    </ul>`],

  ['Switch Deep Sessions', `
    <p>The terminal sidebar lists every Deep Session (grouped <b>Native</b> and <b>Remote</b>), with
    live, idle and needs-attention dots. Click to switch, or:</p>
    <ul>
      <li><b>Alt+\`</b> and <b>Alt+Shift+\`</b> open a grid of recent Deep Sessions; hold Alt and use the arrows,
        Enter or a click to pick.</li>
      <li><b>Alt+1–9</b> jumps to a Deep Session by its number.</li>
    </ul>
    <p><b>Resume a Deep Session</b> at the top of the sidebar opens a searchable list of past Deep
    Sessions. Pick one to resume it and switch straight in.</p>`],

  ['Resume and fork', `
    <p>From <b>History</b>, <b>Resume</b> continues a past Deep Session; <b>Fork</b> branches a copy and
    leaves the original untouched. Resuming injects any external handoff notes left for that Deep Session.
    Codex Deep Sessions resume through Codex's own picker (<code>codex resume</code>) rather than a list.</p>`],

  ['Multiple CLIs (Claude, Codex and agy)', `
    <p>Pick the CLI per Deep Session in the New Deep Session dialog; Deep Sessions are badged by CLI. All get the
    core surface (terminal, attach, kill, rename, snapshot, remote) <b>and</b> cross-Deep-Session notes.
    With <code>POLYMUX_SESSION_MCP=on</code>, every Deep Session (Claude, Codex, agy) is wired with the
    read-only Polymux MCP, so any of them can search siblings and leave a note on another Deep Session
    (any CLI) that surfaces when it next opens. Still Claude-only for now: live status dots,
    History-tab resume, usage and plan value, and the shared-browser auto-wire (the other CLIs don't expose the
    needed APIs yet).</p>`],

  ['Remote Deep Sessions', `
    <p>Polymux can list and attach tmux sessions running a CLI on <b>other hosts</b> (a laptop, another
    box) over SSH. They show in the sidebar's <b>Remote</b> group, tagged by host, and are attach-only for now.
    This needs key-based SSH to the host and the Deep Session running inside tmux. Configure it with
    <code>POLYMUX_REMOTE_HOSTS</code>.</p>`],

  ['Usage and limits', `
    <p>The <b>Usage</b> tab shows token spend and the API-equivalent dollar value of your usage against your
    subscription (are you breaking even?), a daily chart, and a per-model breakdown. It covers all local
    Claude Code CLI usage, not claude.ai web or mobile. If <b>ccburn</b> is installed, the top-bar pill
    shows live session (5h) and weekly plan-limit use (and model-scoped limits like Fable), with
    pace indicators; tap it for detail.</p>`],

  ['Notes and handoff', `
    <p>Deep Sessions can hand context to each other. A <b>context handoff</b> seeds a new (or running)
    Deep Session with an AI summary or transcript of prior Deep Sessions. <b>External notes</b> (left through the
    MCP <code>save_session_summary</code> tool) show on a Deep Session's card and are injected when
    you next open or resume it, so a Deep Session picks up what happened elsewhere. Open a note to apply it
    to a running Deep Session now, edit it, or delete it.</p>`],

  ['Reliability', `
    <p><b>Snapshot and restore.</b> Your active Deep Sessions are snapshotted periodically, on a graceful stop and
    when you press Snapshot, then relaunched (<code>--resume</code>) after a host reboot. Polymux is an installable
    <b>PWA</b> (add it to your home screen) with an offline app shell. The <b>Storage</b> hub lists and
    prunes old artifacts and transcripts, and never touches running Deep Sessions.</p>`],

  ['Remote control (MCP)', `
    <p>Polymux exposes an <b>MCP endpoint</b> (<code>/mcp</code>) so Claude.ai, Claude Code or your own
    agent can search your past Deep Sessions, read a Deep Session's context, leave handoff notes and, with the
    right token, create, resume and drive Deep Sessions and read the files they produce. New Deep Sessions can be
    auto-wired "handoff-aware" so they discover related work and hand off instead of duplicating.</p>`],

  ['Shared browser', `
    <p>Deep Sessions can share one already-logged-in Chrome (over CDP), coordinated by a <b>lock registry</b>
    (<code>browser_tabs</code>, <code>browser_claim</code>, <code>browser_release</code>): each agent
    works in its own tab so they don't collide. Turn it on per Deep Session (Browser access in the New Deep Session
    dialog) or for all Deep Sessions (<code>POLYMUX_SESSION_BROWSER</code>).</p>`],

  ['Keyboard shortcuts', `
    <table class="help-kbd">
      <tr><td><kbd>Alt</kbd>+<kbd>\`</kbd></td><td>cycle recent Deep Sessions</td></tr>
      <tr><td><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>\`</kbd></td><td>cycle backwards</td></tr>
      <tr><td><kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd></td><td>jump to Deep Session N</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Tab</kbd></td><td>cycle (where the browser allows)</td></tr>
    </table>`],

  ['Setup and config', `
    <p>Run it natively (<code>./setup.sh</code>) or with <b>Docker</b> (<code>docker compose up -d</code>), which
    works on Windows, macOS and Linux and bundles the Claude Code, Codex and agy CLIs. Log the CLIs in once. All
    settings are environment variables (password, roots, permission mode, remote hosts, MCP tokens, shared browser
    and more). See the project <b>README</b> for the full list and for serving over Tailscale or Cloudflare.</p>`],
];

function helpHtml() {
  const nav = SECTIONS.map((s, i) => `<a href="#hs${i}">${s[0]}</a>`).join('');
  const body = SECTIONS.map((s, i) => `<section id="hs${i}"><h3>${s[0]}</h3>${s[1]}</section>`).join('');
  return `<div class="modal help-modal">
    <div class="help-head"><h2>Polymux help</h2><button id="help-close" class="icon">Close</button></div>
    <nav class="help-nav" aria-label="Help topics">${nav}</nav>
    <div class="help-body" tabindex="0" role="region" aria-label="Help">${body}</div>
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
}

// First visit: a short welcome, with a link to the full help. Shown once.
export function maybeShowIntro() {
  let seen = false;
  try { seen = localStorage.getItem(INTRO_KEY) === '1'; } catch { /* private mode */ }
  if (seen) return;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal intro-modal">
    <h2>Welcome to Polymux</h2>
    <p>Manage your <b>Claude Code, Codex and agy</b> Deep Sessions from the browser. They are the real CLIs,
    running in tmux on the server, shown through a fast in-browser terminal.</p>
    <ol class="intro-steps">
      <li>Click <b>New Deep Session</b>, pick a directory and CLI, and launch.</li>
      <li>Click the card (or the sidebar) to open a full terminal. Closing the tab
        <i>detaches</i>, and the Deep Session keeps running.</li>
      <li>Use <b>History</b> to resume past work, <b>Usage</b> for spend and limits, and <b>Files</b>
        to move files in.</li>
      <li>Switch fast with <kbd>Alt</kbd>+<kbd>\`</kbd> or <kbd>Alt</kbd>+<kbd>1–9</kbd>.</li>
    </ol>
    <div class="modal-actions">
      <button id="intro-help">Open full help</button>
      <button class="primary" id="intro-go" data-esc>Get started</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const done = () => { try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* */ } bg.remove(); };
  bg.querySelector('#intro-go').addEventListener('click', done);
  bg.querySelector('#intro-help').addEventListener('click', () => { done(); openHelp(); });
}
