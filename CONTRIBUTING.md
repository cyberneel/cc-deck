# Contributing to cc-deck

Thanks for your interest! cc-deck is a small, self-hosted app — contributions that keep it
lean and dependency-light are the most welcome.

## Getting set up

```bash
git clone https://github.com/cyberneel/cc-deck && cd cc-deck
npm install
cp .env.example .env      # set CCDECK_PASSWORD and a random CCDECK_SECRET
npm run dev               # esbuild --watch + node --watch (rebuilds + restarts on change)
```

`npm run dev` watches both the client bundle and the server. For a one-off build use
`npm run build`; to run the server without watching use `npm start`. It listens on
`127.0.0.1:8787` by default.

You'll need **Node ≥ 18**, **tmux**, and the **Claude CLI** on your `PATH` (or point
`CCDECK_LAUNCH` at another command). A C toolchain is needed once to build `node-pty`.

## How it's laid out

See the **Project layout** section of the [README](README.md#project-layout). In short:
`src/*.js` is the Fastify server + helpers, `src/client/*` is the browser code (bundled by
esbuild into `public/`), and `public/*.html` are the pages.

**After editing anything in `src/client/`, rebuild** (`npm run build`) — the served bundle is
generated, and stale bundles are the most common "my change didn't show up" gotcha. The
`public/*.js` bundles are gitignored; don't commit them.

## Code style

- **Plain ESM JavaScript, no TypeScript, no build-time framework.** Match the style of the
  file you're editing — it's a small codebase and consistency matters more than preference.
- **No shell for subprocess calls.** Every tmux/pty/CLI invocation uses `execFile`/`spawn`
  with an argument array — never string interpolation into a shell. Keep it that way.
- **Validate at trust boundaries.** Session names, resume IDs, and any path must be checked
  (names match `^ccdeck-[A-Za-z0-9]+$`, resume IDs are UUIDs, paths must resolve under
  `CCDECK_ROOTS`). Don't loosen these.
- **Lean on the standard library and already-installed deps.** Please don't add a dependency
  for something a few lines can do; new runtime deps need a good reason.
- Keep diffs focused — one concern per PR, and avoid unrelated reformatting.

## Testing / verifying a change

There's no test framework; cc-deck is verified by running it. For a change, please:

1. `npm run build && npm start` (or `npm run dev`) and exercise the affected feature in the
   browser.
2. For anything touching sessions, confirm launch / attach / resume / kill still work and that
   sessions survive a `systemctl --user restart cc-deck` (the `KillMode=process` guarantee).
3. Note in the PR what you did to verify. If you add non-trivial logic, a small runnable check
   is appreciated.

## Submitting a change

1. Branch off `main`.
2. Write a clear commit message: a short imperative summary line, then a body explaining the
   *why* if it isn't obvious.
3. Open a PR describing the change and how you verified it. Screenshots help for UI changes
   (regenerate the README set with `node scripts/screenshots.mjs` — see the script header; it
   runs in demo mode with fabricated data).

## Security

Please **don't** open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md) for
private reporting.

By contributing, you agree your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
