// Every .modal-bg is a dialog: role + label, focus moves in and comes back,
// Tab stays inside, Esc closes only the top one through its own backdrop handler.
const stack = [];
let from = null;
const tabbables = (el) => [...el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
  .filter((x) => !x.disabled && x.getClientRects().length);
document.addEventListener('focusin', (e) => { if (!e.target.closest('.modal-bg')) from = e.target; });
new MutationObserver((ms) => ms.forEach((m) => {
  m.addedNodes.forEach((bg) => {
    if (!bg.classList?.contains('modal-bg')) return;
    stack.push(bg);
    const d = bg.querySelector('.modal') || bg;
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
    const h = d.querySelector('h2,h3'); if (h) d.setAttribute('aria-label', h.textContent.trim());
    if (!d.contains(document.activeElement)) { d.tabIndex = -1; d.focus({ preventScroll: true }); }
  });
  m.removedNodes.forEach((bg) => {
    const i = stack.indexOf(bg); if (i < 0) return;
    stack.splice(i, 1);
    if (document.activeElement && document.activeElement !== document.body) return; // the closer already moved focus (e.g. back to the terminal)
    const top = stack[stack.length - 1];
    if (top) (top.querySelector('.modal') || top).focus({ preventScroll: true });
    else if (from?.isConnected) from.focus({ preventScroll: true });
  });
})).observe(document.body, { childList: true });
addEventListener('keydown', (e) => {
  const bg = stack[stack.length - 1]; if (!bg) return;
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    (bg.querySelector('[data-esc]') || bg).click();
  } else if (e.key === 'Tab') {
    const f = tabbables(bg), i = f.indexOf(document.activeElement);
    if (!f.length) return e.preventDefault();
    if (e.shiftKey ? i <= 0 : i < 0 || i === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
  }
}, true);
