// Populate a <select> with sessions you can pull context from (active + past),
// for the "seed with context" option in the New Session modal. Each option's
// value is the Claude session id; data-cwd carries its directory.
const escA = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function populateSeedSources(selectEl, excludeId) {
  const [act, hist] = await Promise.all([
    fetch('/api/sessions').then((r) => r.json()).catch(() => ({ sessions: [] })),
    fetch('/api/history').then((r) => r.json()).catch(() => ({ sessions: [] })),
  ]);
  const a = (act.sessions || [])
    .filter((s) => s.liveSessionId && s.liveSessionId !== excludeId)
    .map((s) => `<option value="${escA(s.liveSessionId)}" data-cwd="${escA(s.dir || '')}">${escA(s.title || s.name)}</option>`);
  const h = (hist.sessions || [])
    .filter((s) => s.sessionId && s.sessionId !== excludeId)
    .map((s) => `<option value="${escA(s.sessionId)}" data-cwd="${escA(s.cwd || '')}">${escA(s.title || '(untitled)')}</option>`);
  selectEl.innerHTML =
    (a.length ? `<optgroup label="Active sessions">${a.join('')}</optgroup>` : '') +
    (h.length ? `<optgroup label="Past sessions">${h.join('')}</optgroup>` : '');
  if (!a.length && !h.length) selectEl.innerHTML = '<option value="">(no other sessions found)</option>';
}

// Reusable "seed with context" field for the New Session modal.
export const SEED_FIELD_HTML = `
  <div class="field">
    <label class="seed-toggle"><input type="checkbox" id="seed-on" /> Seed with context from another session</label>
    <div id="seed-opts" style="display:none;margin-top:8px">
      <select id="seed-src"></select>
      <div class="seg" id="seed-scope" style="margin-top:8px">
        <button type="button" data-v="summary" class="active">AI summary</button>
        <button type="button" data-v="thread">Full transcript</button>
      </div>
      <div class="faint" style="margin-top:6px">The new session starts having read a handoff from the chosen session.</div>
    </div>
  </div>`;

// Wire the seed field; returns getSeed() -> null (off) or {sourceId, cwd, scope}.
export function wireSeedSection(root, excludeId) {
  const on = root.querySelector('#seed-on');
  const opts = root.querySelector('#seed-opts');
  const src = root.querySelector('#seed-src');
  const scope = root.querySelector('#seed-scope');
  let loaded = false;
  on.addEventListener('change', async () => {
    opts.style.display = on.checked ? '' : 'none';
    if (on.checked && !loaded) { loaded = true; await populateSeedSources(src, excludeId); }
  });
  scope.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    scope.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  });
  return () => {
    if (!on.checked || !src.value) return null;
    const opt = src.selectedOptions[0];
    return { sourceId: src.value, cwd: opt?.dataset.cwd || '', scope: scope.querySelector('button.active')?.dataset.v || 'summary' };
  };
}
