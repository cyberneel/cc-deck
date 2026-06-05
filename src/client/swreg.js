// Service-worker registration + update plumbing shared by dashboard & terminal.
// onUpdate(worker) fires when a new build has installed and is waiting — the
// caller shows a "Reload" toast and passes the worker back to applyUpdate().

export function registerServiceWorker(onUpdate) {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    let reg;
    try { reg = await navigator.serviceWorker.register('/sw.js'); } catch { return; }

    // Only treat it as an "update" if a worker already controls this page
    // (otherwise it's the first install — nothing to reload for).
    const notify = (w) => { if (w && navigator.serviceWorker.controller) onUpdate(w); };

    if (reg.waiting) notify(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed') notify(nw);
      });
    });

    // Poll for a new worker on an interval and whenever the tab refocuses, so a
    // home-screen app picks up deploys quickly instead of on next cold start.
    const check = () => reg.update().catch(() => {});
    setInterval(check, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  });
}

// Activate a waiting worker (if any) and reload. Navigation is network-first, so
// the reloaded page gets the newest build regardless; the new worker then takes
// over for subsequent loads + offline.
export function applyUpdate(worker) {
  try { worker?.postMessage({ type: 'SKIP_WAITING' }); } catch { /* */ }
  location.reload();
}
