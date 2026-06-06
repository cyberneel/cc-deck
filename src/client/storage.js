// Storage & cleanup hub: a controlled, selective-delete view over everything
// cc-deck keeps on disk — context handoffs, caches, and Claude transcripts
// (grouped by directory, including ones hidden from the History tab). Nothing is
// deleted unless explicitly checked and confirmed.

const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' MB' : `${n} KB`);
const dt = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
async function gj(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export async function openStorage() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal storage-modal">
      <div class="graph-top">
        <div class="graph-titles"><h2>Storage &amp; cleanup</h2><div class="faint" id="st-sub">Loading…</div></div>
        <button class="icon st-close" title="Close">✕</button>
      </div>
      <div class="st-body" id="st-body"><div class="graph-hint">Loading…</div></div>
      <div class="st-foot">
        <span id="st-sel" class="faint">Nothing selected</span>
        <div class="spacer"></div>
        <button id="st-refresh">Refresh</button>
        <button class="danger" id="st-del" disabled>Delete selected</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.querySelector('.st-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });

  const body = bg.querySelector('#st-body');
  const sub = bg.querySelector('#st-sub');
  const selEl = bg.querySelector('#st-sel');
  const delBtn = bg.querySelector('#st-del');
  let liveIds = new Set();

  const fileRow = (cat, f) =>
    `<label class="st-row"><input type="checkbox" data-cat="${cat}" data-id="${escH(f.name)}" data-kb="${f.sizeKb}">
      <span class="st-name">${escH(f.name)}</span><span class="faint st-rmeta">${dt(f.mtime)} · ${kb(f.sizeKb)}</span></label>`;

  const fileSection = (title, cat, files) => {
    if (!files.length) return `<div class="st-sec"><div class="st-sec-head"><span>${title}</span> <span class="faint">(none)</span></div></div>`;
    return `<div class="st-sec"><div class="st-sec-head">
        <label class="st-all"><input type="checkbox" class="st-selall"><span>${title}</span></label>
        <span class="faint">${files.length} · ${kb(files.reduce((n, x) => n + x.sizeKb, 0))}</span>
      </div>${files.map((f) => fileRow(cat, f)).join('')}</div>`;
  };

  const transcriptSection = (groups) => {
    if (!groups.length) return '';
    const blocks = groups.map((g) => {
      const rows = g.items.map((it) => {
        const running = liveIds.has(it.sessionId);
        return `<label class="st-row ${running ? 'st-disabled' : ''}">
          <input type="checkbox" data-cat="transcripts" data-id="${escH(it.sessionId)}" data-kb="${it.sizeKb}" ${running ? 'disabled' : ''}>
          <span class="st-name">${escH(it.sessionId.slice(0, 8))}…</span>
          <span class="faint st-rmeta">${running ? '<span class="gtag gtag-branch">running</span> ' : ''}${dt(it.mtime)} · ${kb(it.sizeKb)}</span></label>`;
      }).join('');
      return `<details class="st-grp">
        <summary><label class="st-all st-selall-wrap"><input type="checkbox" class="st-selall"></label>
          <span class="st-grp-dir">${escH(g.cwd)}</span><span class="faint">${g.count} · ${kb(g.sizeKb)}</span></summary>
        ${rows}</details>`;
    }).join('');
    return `<div class="st-sec"><div class="st-sec-head"><span>Past sessions (transcripts)</span>
      <span class="faint">includes ones hidden from History · deletes are permanent</span></div>${blocks}</div>`;
  };

  function updateSel() {
    const checked = [...body.querySelectorAll('input[type=checkbox][data-id]:checked')];
    const total = checked.reduce((n, c) => n + Number(c.dataset.kb || 0), 0);
    selEl.textContent = checked.length ? `${checked.length} selected · ~${kb(total)}` : 'Nothing selected';
    delBtn.disabled = !checked.length;
  }

  function wire() {
    body.querySelectorAll('.st-selall').forEach((sa) => {
      sa.addEventListener('click', (e) => e.stopPropagation()); // don't toggle <details>
      sa.addEventListener('change', (e) => {
        e.stopPropagation();
        const scope = sa.closest('.st-grp') || sa.closest('.st-sec');
        scope.querySelectorAll('input[type=checkbox][data-id]:not(:disabled)').forEach((c) => { c.checked = sa.checked; });
        updateSel();
      });
    });
    body.querySelectorAll('input[type=checkbox][data-id]').forEach((c) => c.addEventListener('change', updateSel));
  }

  async function load() {
    body.innerHTML = '<div class="graph-hint">Loading…</div>';
    let data, sess;
    try { [data, sess] = await Promise.all([gj('/api/storage'), gj('/api/sessions').catch(() => ({ sessions: [] }))]); }
    catch (e) { body.innerHTML = `<div class="graph-hint">Couldn’t load: ${escH(e.message)}</div>`; return; }
    liveIds = new Set();
    (sess.sessions || []).forEach((s) => { if (s.liveSessionId) liveIds.add(s.liveSessionId); if (s.resumedFrom) liveIds.add(s.resumedFrom); });
    const t = data.totals;
    sub.textContent = `${t.transcriptCount} transcripts · ${data.handoffs.length} handoffs · ${data.caches.length} caches · ~${kb(t.handoffsKb + t.cachesKb + t.transcriptsKb)} total`;
    body.innerHTML = fileSection('Context handoffs', 'handoffs', data.handoffs)
      + fileSection('Caches', 'caches', data.caches)
      + transcriptSection(data.transcripts);
    wire();
    updateSel();
  }

  bg.querySelector('#st-refresh').addEventListener('click', load);
  delBtn.addEventListener('click', async () => {
    const checked = [...body.querySelectorAll('input[type=checkbox][data-id]:checked')];
    if (!checked.length) return;
    if (!confirm(`Permanently delete ${checked.length} item(s)? This can’t be undone.`)) return;
    const payload = { handoffs: [], caches: [], transcripts: [] };
    checked.forEach((c) => payload[c.dataset.cat].push(c.dataset.id));
    delBtn.disabled = true; delBtn.textContent = 'Deleting…';
    try {
      const r = await fetch('/api/storage/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await load();
      selEl.textContent = `Deleted ${j.deleted} · freed ~${kb(j.freedKb)}${j.errors.length ? ` · ${j.errors.length} skipped` : ''}`;
    } catch (e) { alert('Delete failed: ' + e.message); }
    finally { delBtn.textContent = 'Delete selected'; }
  });

  load();
}
