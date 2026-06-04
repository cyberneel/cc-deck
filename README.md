# cc-deck

A self-hosted web dashboard for your **Claude CLI** sessions. See every running session
in a grid/list/grouped view, launch a new `claude` in any directory, resume past
conversations, and click into a fast, smooth in-browser terminal — the real CLI, no wrapper.

Each session is a **tmux** session running `claude`, so sessions survive tab-closes and
server restarts, and you can still `tmux attach` to any of them from a normal shell.

```
browser (xterm.js)  ──ws──▶  Node/Fastify  ──node-pty──▶  tmux attach -t ccdeck-…  ──▶  claude
        ▲                          │
        └──── grid / list / group / search / launch / resume / kill (REST) ──┘
```

## Screenshots

| Active sessions | Usage & ROI |
|---|---|
| ![Active sessions grid with live previews](docs/active.png) | ![Usage tab with plan ROI](docs/usage.png) |

| Grouped by directory | History (resume) |
|---|---|
| ![Grouped, collapsible view](docs/grouped.png) | ![History of past sessions](docs/history.png) |

<sub>Regenerate with `node scripts/screenshots.mjs` (needs `npm install playwright --no-save && npx playwright install chromium`, plus a `TOKEN` cookie value).</sub>

## Features

- **Status panel** — at-a-glance counts: active sessions, running, attached, distinct
  directories, and total past sessions. The tiles double as quick tab switches.
- **Fuzzy search** — instant subsequence search across title, directory, and git branch,
  ranked by relevance. Works in both Active and History tabs.
- **Three views** — grid (with live pane previews), compact list, or **grouped by directory**.
- **Active tab** — launch a session in any directory under your roots (with a folder picker),
  rename, kill, and open a full-screen xterm.js terminal (WebGL/canvas renderer, auto-reconnect).
  Closing the browser only *detaches* — Claude keeps running. A per-terminal **scroll-mode
  toggle** switches between *tmux* (native copy-mode, full history) and *fast* (strips the
  alt-screen so the wheel scrolls xterm's local buffer instantly).
- **In-terminal session switcher** — a collapsible sidebar lists every active session with
  live/idle and "needs-attention" indicators (unseen activity since you last viewed it).
  Click to switch in place (no reload), **Alt+` / Alt+Shift+`** to cycle in
  most-recently-used order (Zen-style overlay; hold Alt, tap backtick, release to commit),
  or **Alt+1–9** to jump directly. (Ctrl+Tab also works where the browser doesn't reserve it.)
  The current + 2 most-recent sessions are kept **warm** (attached in the background, marked
  with a green dot), so switching between them is instant — no reconnect/repaint delay.
- **History tab** — lists past Claude sessions from `~/.claude/projects` with directory,
  branch, time, and opening prompt. "▶ Resume" runs `claude --resume <id>` in the original
  directory as a fresh live session — a backend equivalent of `claude --resume`.
- **Usage tab** — token-spend and **ROI on your plan**: pick your plan (Pro / Max 5× /
  Max 20× / custom) and billing-renewal day, then see the API-equivalent dollar value of
  your usage this billing cycle vs the subscription price ("are you breaking even?"), a
  daily-spend chart, and a per-model breakdown. Token prices are pulled **live** from the
  [LiteLLM pricing dataset](https://github.com/BerriAI/litellm) (cached on disk, ~7-day
  refresh, with a built-in fallback) so the numbers don't go stale as Anthropic's prices
  change. If [`ccburn`](https://github.com/JuanjoFuchs/ccburn) is installed, it also shows
  live session (5h) and weekly plan-limit utilization with pace indicators.
- **Collapsible grouped view** — group sessions by directory; groups start collapsed so you
  can scan many directories quickly, then expand the ones you want.
- **Auth** — password login with a signed cookie. Binds to loopback; exposed via
  Tailscale or Cloudflare. Safe to put on a public hostname.

## Requirements

- **Node.js ≥ 18**, **tmux**, and the **Claude CLI** (`claude`) on `PATH`.
- A C toolchain (`gcc`/`clang`, `make`, `python3`) is needed once to build `node-pty`.
- Linux or macOS. The optional background service uses systemd (Linux).
- *Optional:* [`ccburn`](https://github.com/JuanjoFuchs/ccburn) (`npm i -g ccburn`) for the
  live plan-limit charts in the Usage tab. The Usage tab's ROI/cost numbers work without it.

## Quick start

```bash
git clone <your-fork-url> cc-deck && cd cc-deck
./setup.sh            # checks deps, installs, builds, creates .env, optional service
npm start             # if you didn't install the service — listens on 127.0.0.1:8787
```

`setup.sh` is interactive and idempotent: it installs dependencies, builds the frontend,
generates a `.env` (random cookie secret + a password you choose), and optionally installs
a systemd **user** service. Re-running it won't clobber an existing `.env`.

Manual setup instead of the script:

```bash
npm install && npm run build
cp .env.example .env      # then set CCDECK_PASSWORD and a random CCDECK_SECRET:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

Rebuild the frontend after editing anything in `src/client/` with `npm run build`
(or `npm run dev` for watch mode + server auto-restart).

## Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `CCDECK_PASSWORD` | — | Login password (**required**). |
| `CCDECK_SECRET` | insecure default | Random string used to sign cookies. Set this. |
| `PORT` | `8787` | Listen port. |
| `CCDECK_BIND` | `127.0.0.1` | Bind address — keep loopback so the raw port isn't exposed. |
| `CCDECK_ROOTS` | `$HOME` | Colon-separated dirs sessions may launch/browse under. |
| `CCDECK_LAUNCH` | `claude` | Command run in each new session. |

## Serve it on your tailnet (TLS, no open ports)

[`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve) terminates HTTPS with an
automatic cert and proxies to the local app:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status      # prints the https://<machine>.<tailnet>.ts.net URL
```

Reachable from any device on your tailnet. (If it says "Access denied", run
`sudo tailscale set --operator=$USER` once.) Stop with `tailscale serve --https=443 off`.

## Keep it running (systemd user service)

`setup.sh` can do this for you. Manually:

```bash
# the unit in systemd/ uses placeholders; fill them for your machine:
mkdir -p ~/.config/systemd/user
sed -e "s|__CCDECK_DIR__|$PWD|g" -e "s|__NODE__|$(command -v node)|g" \
    -e "s|__PATH__|$(dirname $(command -v node)):/usr/local/bin:/usr/bin:/bin|g" \
    systemd/cc-deck.service > ~/.config/systemd/user/cc-deck.service
systemctl --user daemon-reload && systemctl --user enable --now cc-deck
sudo loginctl enable-linger "$USER"     # keep running while logged out
journalctl --user -u cc-deck -f         # logs
```

**Remember:** changes to `.env` need `systemctl --user restart cc-deck`; changes to
`src/client/*` need `npm run build` first.

## Exposing on your own domain via Cloudflare

1. Install `cloudflared`, create a tunnel to `http://127.0.0.1:8787`, and route your
   hostname (`cloudflared tunnel route dns <tunnel> claude.example.com`).
2. The app's password login already protects it. For a stronger layer, add a
   **Cloudflare Access** policy (SSO) in front of the hostname.
3. cc-deck sets `secure` cookies when it sees `x-forwarded-proto: https`, so login works
   correctly behind Cloudflare's TLS.

## Security notes

- All tmux/pty calls use `execFile`/`spawn` with argument arrays — no shell, no injection.
- Session names are validated (`^ccdeck-[A-Za-z0-9]+$`), resume IDs must be UUIDs, and
  launch directories must resolve under `CCDECK_ROOTS`.
- Single shared password (no multi-user accounts) — layer Cloudflare Access for per-identity control.
- Keep `CCDECK_BIND=127.0.0.1` so the unauthenticated raw port is never on the network.

## Project layout

```
src/server.js      Fastify app: static, REST API, auth gate, ws route
src/auth.js        password check + HMAC-signed cookie
src/tmux.js        list/create/kill/rename/preview/fs — wraps tmux (create supports --resume)
src/history.js     scans ~/.claude/projects for resumable past sessions
src/usage.js       token usage + API-equivalent cost from transcripts (ROI)
src/pricing.js     live Anthropic token pricing (LiteLLM dataset, disk-cached + fallback)
src/burn.js        shells out to `ccburn --json` for live plan-limit utilization
src/pty.js         websocket ⇄ node-pty(`tmux attach`) bridge
src/config.js      env config
src/client/*.js    dashboard + terminal (bundled by esbuild into public/)
public/*.html      login / dashboard / terminal pages
systemd/           user-service unit template (filled in by setup.sh)
setup.sh           one-command installer
```

## License

[Apache-2.0](LICENSE).
