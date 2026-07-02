// Populate a checkbox list with sessions you can pull context from (active +
// past), for the "seed with context" option in the New Session modal. Each row's
// checkbox carries the Claude session id (data-id) and its directory (data-cwd).
// Supports selecting MULTIPLE sessions.
const escA = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function populateSeedSources(listEl, excludeId) {
  const [act, hist] = await Promise.all([
    fetch('/api/sessions').then((r) => r.json()).catch(() => ({ sessions: [] })),
    fetch('/api/history').then((r) => r.json()).catch(() => ({ sessions: [] })),
  ]);
  const row = (id, cwd, title) =>
    `<label class="seed-item"><input type="checkbox" data-id="${escA(id)}" data-cwd="${escA(cwd)}"><span class="seed-item-main"><span class="seed-item-title">${escA(title)}</span><span class="seed-item-meta faint">${escA(cwd || '')}</span></span></label>`;
  const a = (act.sessions || [])
    .filter((s) => s.liveSessionId && s.liveSessionId !== excludeId)
    .map((s) => row(s.liveSessionId, s.dir || '', s.title || s.name));
  const h = (hist.sessions || [])
    .filter((s) => s.sessionId && s.sessionId !== excludeId)
    .map((s) => row(s.sessionId, s.cwd || '', s.title || '(untitled)'));
  listEl.innerHTML =
    (a.length ? `<div class="seed-group">Active</div>${a.join('')}` : '') +
    (h.length ? `<div class="seed-group">Past</div>${h.join('')}` : '')
    || '<div class="faint" style="padding:8px">(no other sessions found)</div>';
}

// Reusable "seed with context" field for the New Session modal (multi-select).
export const SEED_FIELD_HTML = `
  <div class="field">
    <label class="seed-toggle"><input type="checkbox" id="seed-on" /> Seed with context from other sessions</label>
    <div id="seed-opts" style="display:none;margin-top:8px">
      <input id="seed-filter" placeholder="filter by title / directory…" spellcheck="false" autocomplete="off" style="margin-bottom:6px" />
      <div id="seed-list" class="seed-list"><div class="faint" style="padding:8px">Loading…</div></div>
      <div class="seg" id="seed-scope" style="margin-top:8px">
        <button type="button" data-v="summary" class="active">AI summary</button>
        <button type="button" data-v="thread">Full transcript</button>
      </div>
      <div class="faint" id="seed-count" style="margin-top:6px">Pick one or more sessions to seed from.</div>
    </div>
  </div>`;

// Wire the seed field; returns getSeed() -> null (off/none) or
// { sources: [{sourceId, cwd}, …], scope }.
export function wireSeedSection(root, excludeId) {
  const on = root.querySelector('#seed-on');
  const opts = root.querySelector('#seed-opts');
  const list = root.querySelector('#seed-list');
  const scope = root.querySelector('#seed-scope');
  const filter = root.querySelector('#seed-filter');
  const count = root.querySelector('#seed-count');
  let loaded = false;
  const updateCount = () => {
    const n = list.querySelectorAll('input[data-id]:checked').length;
    count.textContent = n
      ? `${n} session${n > 1 ? 's' : ''} selected — the new session starts having read ${n > 1 ? 'their combined context' : 'its context'}.`
      : 'Pick one or more sessions to seed from.';
  };
  on.addEventListener('change', async () => {
    opts.style.display = on.checked ? '' : 'none';
    if (on.checked && !loaded) {
      loaded = true;
      await populateSeedSources(list, excludeId);
      list.addEventListener('change', updateCount);
    }
  });
  filter.addEventListener('input', () => {
    const q = filter.value.toLowerCase();
    list.querySelectorAll('.seed-item').forEach((el) => { el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
  scope.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    scope.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  });
  return () => {
    if (!on.checked) return null;
    const checked = [...list.querySelectorAll('input[data-id]:checked')];
    if (!checked.length) return null;
    return {
      sources: checked.map((c) => ({ sourceId: c.dataset.id, cwd: c.dataset.cwd || '' })),
      scope: scope.querySelector('button.active')?.dataset.v || 'summary',
    };
  };
}
