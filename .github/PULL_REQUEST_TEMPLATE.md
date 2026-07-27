<!-- Thanks for contributing! Keep PRs focused on one concern. -->

## What & why

<!-- What does this change do, and why? Link any related issue (Fixes #123). -->

## How I verified it

<!-- e.g. built + ran, exercised the affected feature, confirmed sessions survive a restart. -->

## Checklist

- [ ] Rebuilt the client (`npm run build`) if I touched `src/client/**`
- [ ] No new runtime dependency (or explained why one is needed)
- [ ] Subprocess calls still use `execFile`/`spawn` with arg arrays (no shell)
- [ ] Trust-boundary validation (session names / resume IDs / paths under roots) intact
- [ ] Screenshots updated if this changes the UI (`node scripts/screenshots.mjs`, demo mode)
