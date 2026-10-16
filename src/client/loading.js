// What a list shows while its data isn't in yet. Nothing for the first 300ms
// (fast loads never flash), then skeleton rows, then at 10s "Still loading…".
// A failure says so. Both messages carry a [data-retry] button for the caller
// to wire. Call loadSteps(rerender) when a load starts so those switches show.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function loadingHtml(since, err, what = 'this') {
  if (err) return `<div class="load-msg" role="alert">Couldn't load ${what}: ${esc(err)}<button data-retry>Retry</button></div>`;
  const ms = Date.now() - since;
  const body = ms < 300 ? '' : ms < 10_000
    ? `<div class="sk-wrap">${'<div class="sk"></div>'.repeat(6)}</div>`
    : `<div class="load-msg">Still loading…<button data-retry>Retry</button></div>`;
  return `<div aria-busy="true">${body}</div>`;
}

export function loadSteps(rerender) {
  setTimeout(rerender, 300);
  setTimeout(rerender, 10_000);
}
