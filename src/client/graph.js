// Read-only session graph viewer: renders a transcript's branch/conversation
// tree (git-log style rail on the left, message list on the right). Click a node
// to load the full conversation thread leading to that point.

const ROWH = 34, COLW = 18, PADX = 14, PADY = 16, DOT = 5;

async function gj(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) { let m = `HTTP ${r.status}`; try { m = (await r.json()).error || m; } catch { /* */ } throw new Error(m); }
  return r.json();
}
const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const timeShort = (ts) => { if (!ts) return ''; const d = new Date(ts); return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };

export async function openGraph(sessionId, fallbackTitle, cwd) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg graph-bg';
  bg.innerHTML = `
    <div class="modal graph-modal">
      <div class="graph-top">
        <div class="graph-titles">
          <h2>${escH(fallbackTitle || 'Session graph')}</h2>
          <div class="faint" id="gx-sub">loading…</div>
        </div>
        <div class="graph-actions">
          <button class="primary gx-fork" title="Fork into a new session that copies this context" disabled>⑂ Fork</button>
          <button class="icon gx-close" title="Close">✕</button>
        </div>
      </div>
      <div class="graph-body">
        <div class="graph-scroll" id="gx-scroll"><div class="graph-empty">Loading transcript…</div></div>
        <div class="graph-detail" id="gx-detail"><div class="graph-hint">Click a point to read the conversation up to there.</div></div>
      </div>
    </div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.querySelector('.gx-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });

  const scroll = bg.querySelector('#gx-scroll');
  const detail = bg.querySelector('#gx-detail');
  const cwdQ = cwd ? `&cwd=${encodeURIComponent(cwd)}` : '';

  let g;
  try { g = await gj(`/api/transcripts/${encodeURIComponent(sessionId)}/graph?_=1${cwdQ}`); }
  catch (e) { scroll.innerHTML = `<div class="graph-empty">Couldn’t load graph: ${escH(e.message)}</div>`; return; }

  bg.querySelector('h2').textContent = g.title || fallbackTitle || 'Session graph';
  bg.querySelector('#gx-sub').textContent =
    `${g.cwd || ''}${g.gitBranch ? ' · ' + g.gitBranch : ''} · ${g.stats.messages} msgs · ` +
    `${g.stats.branchPoints} branch${g.stats.branchPoints === 1 ? '' : 'es'} · ~${tok(g.stats.totalTokens)} tokens`;

  // Wire the Fork action now that we know the session's directory.
  const forkDir = g.cwd || cwd || '';
  const forkBtn = bg.querySelector('.gx-fork');
  if (forkDir) {
    forkBtn.disabled = false;
    forkBtn.addEventListener('click', async () => {
      forkBtn.disabled = true; forkBtn.textContent = 'Forking…';
      try {
        const r = await fetch('/api/sessions', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir: forkDir, resume: sessionId, fork: true, title: `${g.title || fallbackTitle || 'session'} (fork)` }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        location.href = `/terminal.html?session=${encodeURIComponent(j.name)}`;
      } catch (e) { forkBtn.disabled = false; forkBtn.textContent = '⑂ Fork'; alert('Fork failed: ' + e.message); }
    });
  } else {
    forkBtn.title = 'No recorded directory — can’t fork';
  }

  if (!g.nodes.length) { scroll.innerHTML = `<div class="graph-empty">No conversation messages to graph.</div>`; return; }

  // ---- layout ----
  const railW = PADX * 2 + g.maxCol * COLW + DOT * 2;
  const colX = (c) => PADX + c * COLW + DOT;
  const rowY = (r) => PADY + r * ROWH + ROWH / 2;
  const totalH = PADY * 2 + g.nodes.length * ROWH;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  // edges
  let paths = '';
  for (const n of g.nodes) {
    if (!n.parent || !byId.has(n.parent)) continue;
    const p = byId.get(n.parent);
    const x1 = colX(p.col), y1 = rowY(p.row), x2 = colX(n.col), y2 = rowY(n.row);
    const cls = n.main ? 'ge-main' : 'ge-branch';
    paths += x1 === x2
      ? `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`
      : `<path class="${cls}" d="M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}"/>`;
  }
  // dots
  let dots = '';
  for (const n of g.nodes) {
    const cx = colX(n.col), cy = rowY(n.row);
    const role = n.role === 'user' ? 'gd-user' : 'gd-asst';
    const cls = `gdot ${role} ${n.main ? 'gd-main' : 'gd-off'} ${n.current ? 'gd-current' : ''}`;
    if (n.current) dots += `<circle class="gd-ring" cx="${cx}" cy="${cy}" r="${DOT + 3}"/>`;
    dots += `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${DOT}"/>`;
  }
  const svg = `<svg class="graph-svg" width="${railW}" height="${totalH}" viewBox="0 0 ${railW} ${totalH}">${paths}${dots}</svg>`;

  // rows
  const rows = g.nodes.map((n) => {
    const roleLabel = n.role === 'user' ? 'You' : 'Claude';
    const tools = n.tools.length ? `<span class="gtag">🔧 ${n.tools.reduce((s, t) => s + t.count, 0)}</span>` : '';
    const sub = n.sub ? `<span class="gtag">⤷ ${n.sub}</span>` : '';
    const tt = (n.tokens.in + n.tokens.out + n.tokens.cache);
    const ttag = tt ? `<span class="gtag">${tok(tt)} tok</span>` : '';
    const branchTag = (n.leaf && !n.current) ? `<span class="gtag gtag-branch">branch</span>` : '';
    return `<div class="gnode" data-id="${escH(n.id)}" style="height:${ROWH}px;padding-left:${railW}px">
      <div class="gnode-line">
        <span class="grole ${n.role}">${roleLabel}</span>
        <span class="gtext">${escH(n.text) || '<span class="faint">(no text)</span>'}</span>
      </div>
      <div class="gmeta">${ttag}${tools}${sub}${branchTag}<span class="faint">${timeShort(n.ts)}</span></div>
    </div>`;
  }).join('');

  scroll.innerHTML = `${svg}<div class="graph-rows" style="height:${totalH}px">${rows}</div>`;

  // ---- interaction ----
  let selected = null;
  const selectNode = async (id) => {
    if (selected) selected.classList.remove('sel');
    const row = scroll.querySelector(`.gnode[data-id="${CSS.escape(id)}"]`);
    if (row) { row.classList.add('sel'); selected = row; }
    detail.innerHTML = `<div class="graph-hint">Loading conversation…</div>`;
    let t;
    try { t = await gj(`/api/transcripts/${encodeURIComponent(sessionId)}/thread?uuid=${encodeURIComponent(id)}${cwdQ}`); }
    catch (e) { detail.innerHTML = `<div class="graph-hint">Couldn’t load: ${escH(e.message)}</div>`; return; }
    const msgs = t.messages.map((m) => {
      const tools = m.tools && m.tools.length ? `<div class="gt-tools">${m.tools.map((x) => `<span class="gtag">${escH(x)}</span>`).join('')}</div>` : '';
      return `<div class="gmsg ${m.role}">
        <div class="gmsg-head"><span class="grole ${m.role}">${m.role === 'user' ? 'You' : 'Claude'}</span><span class="faint">${timeShort(m.ts)}</span></div>
        <div class="gmsg-body">${escH(m.text) || '<span class="faint">(no text)</span>'}</div>${tools}
      </div>`;
    }).join('');
    detail.innerHTML = `<div class="gd-head">Conversation up to this point · ${t.messages.length} message${t.messages.length === 1 ? '' : 's'}</div><div class="gd-thread">${msgs}</div>`;
    detail.querySelector('.gd-thread')?.scrollTo(0, detail.querySelector('.gd-thread').scrollHeight);
  };
  scroll.querySelectorAll('.gnode').forEach((r) => r.addEventListener('click', () => selectNode(r.dataset.id)));

  // Open the current head by default.
  const cur = g.nodes.find((n) => n.current) || g.nodes[g.nodes.length - 1];
  if (cur) selectNode(cur.id);
}
