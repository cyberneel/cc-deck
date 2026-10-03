// Stale-while-revalidate around a slow async loader (a CLI exec, an SSH round-trip).
// Fresh (< ttlMs): served as-is. Stale but < maxStaleMs: served instantly while ONE
// background load refreshes it. Never loaded, or too old to trust: callers await the
// single shared in-flight load. Concurrent misses never stack up duplicate execs.
export function swr(load, ttlMs, maxStaleMs = Infinity) {
  let at = 0, data, loaded = false, inflight = null;
  const refresh = () => inflight ||= Promise.resolve().then(load)
    .then((d) => { data = d; loaded = true; at = Date.now(); return d; })
    .finally(() => { inflight = null; });
  return () => {
    const age = Date.now() - at;
    if (loaded && age < ttlMs) return Promise.resolve(data);
    if (loaded && age < maxStaleMs) { refresh().catch(() => {}); return Promise.resolve(data); }
    return refresh();
  };
}
