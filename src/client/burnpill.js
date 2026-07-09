// Shared ccburn quick-view pill (top bar) for the dashboard and terminal pages.
// Each page owns its own fetch loop; this module owns the rendering + popover so
// the two can't drift.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pctOf = (l) => (l ? Math.round((l.utilization || 0) * 100) : null);
const burnCls = (l) => { if (!l) return ''; const p = (l.utilization || 0) * 100; return p >= 90 ? 'burn-crit' : l.status === 'ahead_pace' ? 'burn-warn' : 'burn-ok'; };

export async function fetchBurn() {
  try { const r = await fetch('/api/burn'); if (r.ok) return await r.json(); } catch { /* */ }
  return null;
}

export function renderBurnPill(btn, burn) {
  if (!btn) return;
  if (!burn || !burn.available) { btn.style.display = 'none'; return; }
  const s = burn.limits?.session, w = burn.limits?.weekly;
  btn.innerHTML = `<span class="bp-seg ${burnCls(s)}">${pctOf(s) ?? '–'}%</span><span class="bp-sep">·</span><span class="bp-seg ${burnCls(w)}">${pctOf(w) ?? '–'}%</span>`;
  btn.title = `Session ${pctOf(s)}% · Weekly ${pctOf(w)}% used (ccburn) — tap for detail`;
  btn.style.display = '';
}

function detailHtml(b) {
  const lim = b.limits || {};
  const card = (name, l) => {
    if (!l) return '';
    const pct = (l.utilization || 0) * 100;
    const resets = l.resets_in_minutes != null ? `${l.resets_in_minutes}m` : l.resets_in_hours != null ? `${l.resets_in_hours.toFixed(0)}h` : '—';
    return `<div class="limit"><div class="limit-top"><span>${name}</span><span>${pct.toFixed(0)}%</span></div>
      <div class="limit-bar"><div class="limit-fill" style="width:${Math.min(100, pct)}%"></div></div>
      <div class="faint">resets in ${resets} · budget pace ${((l.budget_pace || 0) * 100).toFixed(0)}%</div></div>`;
  };
  const br = b.burn_rate;
  return `<div class="burn-pop-title">Plan limits <span class="faint">· ccburn</span></div>
    ${card('Session (5h)', lim.session)}${card('Weekly', lim.weekly)}${lim.monthly ? card('Monthly', lim.monthly) : ''}
    ${br ? `<div class="faint" style="margin-top:2px">🔥 ${Number(br.percent_per_hour).toFixed(1)}%/h (${esc(br.trend || '')})${br.estimated_minutes_to_100 ? ` · ~${Math.round(br.estimated_minutes_to_100 / 60 * 10) / 10}h to 100%` : ''}</div>` : ''}
    ${b.recommendation ? `<div class="faint">${esc(String(b.recommendation).replace(/_/g, ' '))}</div>` : ''}`;
}

// Toggle the detail popover under `btn`. `refresh` (optional) is an async fn that
// returns fresh burn data to re-render the open popover with.
export async function openBurnPopover(btn, burn, refresh) {
  const open = document.getElementById('burn-pop');
  if (open) { open.remove(); return; }
  const p = document.createElement('div');
  p.id = 'burn-pop'; p.className = 'burn-pop';
  p.innerHTML = burn && burn.available ? detailHtml(burn) : '<div class="faint">ccburn unavailable</div>';
  const r = btn.getBoundingClientRect();
  p.style.top = `${r.bottom + 6}px`;
  if (window.matchMedia('(max-width: 700px)').matches) {
    // Narrow screens: center under the bar + clamp to viewport (anchoring to the
    // button's edge overflows off-screen).
    p.style.left = '50%';
    p.style.right = 'auto';
    p.style.transform = 'translateX(-50%)';
    p.style.width = 'min(340px, calc(100vw - 16px))';
  } else {
    p.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }
  document.body.appendChild(p);
  setTimeout(() => document.addEventListener('click', function h() { p.remove(); document.removeEventListener('click', h); }, { once: true }), 0);
  if (refresh) {
    const fresh = await refresh();
    const still = document.getElementById('burn-pop');
    if (still && fresh && fresh.available) still.innerHTML = detailHtml(fresh);
  }
}
