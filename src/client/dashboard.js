import css from './styles.css';

// Inject shared styles.
const styleEl = document.createElement('style');
styleEl.textContent = css;
document.head.appendChild(styleEl);

const app = document.getElementById('app');
let view = localStorage.getItem('ccdeck.view') || 'grid'; // grid | list | group
let tab = localStorage.getItem('ccdeck.tab') || 'active'; // active | history
let query = '';
let sessions = [];
let history = [];
let historyTotal = 0;
let historyLoaded = false;
let cfg = { roots: [], launchCommand: 'claude' };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
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
  return /node|claude/i.test(cmd) || (s.lastActivity && Date.now() - s.lastActivity < 15000);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

// ---- shell ----
function render() {
  app.innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="dot"></span> cc-deck</div>
      <div class="toggle tabs">
        <button data-tab="active" class="${tab === 'active' ? 'active' : ''}">Active</button>
        <button data-tab="history" class="${tab === 'history' ? 'active' : ''}">History</button>
      </div>
      <div class="spacer"></div>
      <button class="primary" id="new-btn">+ New session</button>
      <button id="logout-btn" title="Log out">⏻</button>
    </div>
    <div class="wrap">
      <div class="stats" id="stats"></div>
      <div class="subbar">
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
    container.innerHTML = groupByDir(filtered, (s) => s.dir)
      .map(([dir, items]) =>
        `<div class="group">
          <div class="group-head"><span class="group-dir">${esc(shortDir(dir))}</span><span class="group-count">${items.length}</span></div>
          <div class="grid">${items.map(cardHtml).join('')}</div>
        </div>`)
      .join('');
  } else {
    container.innerHTML = `<div class="grid ${view === 'list' ? 'list' : ''}">${filtered.map(cardHtml).join('')}</div>`;
  }
  wireActiveCards(container);
  loadPreviews(filtered);
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
  const live = isLive(s);
  return `<div class="card" data-name="${esc(s.name)}">
    <div class="card-head"><div class="card-title" title="${esc(s.title)}">${esc(s.title)}</div></div>
    <div class="card-dir" title="${esc(s.dir)}">${esc(shortDir(s.dir))}</div>
    <pre class="preview" data-preview="${esc(s.name)}">…</pre>
    <div class="card-foot">
      <span class="badge ${live ? 'live' : 'idle'}"><span class="pulse"></span>${live ? 'running' : 'idle'}</span>
      <span class="faint">${s.attached ? 'attached · ' : ''}${fmtTime(s.lastActivity)}</span>
      <div class="spacer"></div>
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
    if (tab === 'active') renderBody();
    else renderStats();
  } catch (e) {
    /* transient */
  }
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
  const filtered = search(history, (s) => `${s.title} ${s.cwd} ${s.gitBranch}`);
  if (!filtered.length) return emptySearch(container);

  if (view === 'group') {
    container.innerHTML = groupByDir(filtered, (s) => s.cwd)
      .map(([dir, items]) =>
        `<div class="group">
          <div class="group-head"><span class="group-dir">${esc(shortDir(dir))}</span><span class="group-count">${items.length}</span></div>
          <div class="grid list">${items.map(historyCardHtml).join('')}</div>
        </div>`)
      .join('');
  } else {
    container.innerHTML = `<div class="grid ${view === 'grid' ? '' : 'list'}">${filtered.map(historyCardHtml).join('')}</div>`;
  }
  wireHistoryCards(container);
}

function wireHistoryCards(container) {
  container.querySelectorAll('.card').forEach((el) => {
    const id = el.dataset.id;
    const s = history.find((x) => x.sessionId === id);
    const btn = el.querySelector('.resume-btn');
    const open = async () => {
      if (!s.cwd) return;
      btn.disabled = true;
      btn.textContent = 'Resuming…';
      try {
        const { name } = await api('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ dir: s.cwd, title: s.title, resume: s.sessionId }),
        });
        location.href = `/terminal.html?session=${encodeURIComponent(name)}`;
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '▶ Resume';
        alert('Could not resume: ' + e.message);
      }
    };
    el.addEventListener('click', (e) => { if (!e.target.closest('button')) open(); });
    btn?.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  });
}

function historyCardHtml(s) {
  const noCwd = !s.cwd;
  return `<div class="card hist" data-id="${esc(s.sessionId)}">
    <div class="card-head">
      <div style="flex:1;min-width:0">
        <div class="card-title" title="${esc(s.title)}">${esc(s.title)}</div>
        <div class="hist-dir">${esc(shortDir(s.cwd))}${s.gitBranch ? ` · ${esc(s.gitBranch)}` : ''}</div>
      </div>
    </div>
    <div class="card-foot">
      <span class="faint">${fmtAbsTime(s.lastModified)} · ${s.sizeKb} KB</span>
      <div class="spacer"></div>
      <button class="primary resume-btn" ${noCwd ? 'disabled title="No recorded directory"' : ''}>▶ Resume</button>
    </div>
  </div>`;
}

function emptySearch(container) {
  container.innerHTML = `<div class="empty"><p class="muted">No matches for “${esc(query)}”.</p></div>`;
}

// ---- new session modal ----
function openNewModal() {
  let currentPath = cfg.roots[0] || cfg.home || '/';
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
        <button class="primary" id="launch-btn">Launch ${esc(cfg.launchCommand)}</button>
      </div>
    </div>`;
  document.body.appendChild(bg);

  const dirInput = bg.querySelector('#dir-input');
  const browser = bg.querySelector('#browser');
  const errEl = bg.querySelector('#modal-error');

  async function browse(path) {
    try {
      const { path: abs, dirs } = await api(`/api/fs?path=${encodeURIComponent(path)}`);
      currentPath = abs;
      dirInput.value = abs;
      const parent = abs.split('/').slice(0, -1).join('/') || '/';
      browser.innerHTML =
        `<div class="row up" data-path="${esc(parent)}">⬆ ..</div>` +
        dirs.map((d) => `<div class="row" data-path="${esc(d.path)}">📁 ${esc(d.name)}</div>`).join('');
      browser.querySelectorAll('.row').forEach((r) => r.addEventListener('click', () => browse(r.dataset.path)));
    } catch (e) {
      errEl.textContent = e.message;
    }
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
      location.href = `/terminal.html?session=${encodeURIComponent(name)}`;
    } catch (e) {
      errEl.textContent = e.message;
    }
  });
}

// ---- boot ----
(async () => {
  try { cfg = await api('/api/config'); } catch { /* defaults */ }
  await refresh();
  render();
  refreshHistory(); // populate the "Past sessions" stat + history tab data
  setInterval(refresh, 4000);
})();
