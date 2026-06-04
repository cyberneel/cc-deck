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
- **Mobile-friendly** — responsive layout (no overflow), iOS safe-area + dynamic-viewport
  handling, the session sidebar becomes an off-canvas drawer, and the terminal gets an
  on-screen key bar (Esc / Tab / Ctrl / arrows) since phone keyboards lack those keys.

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

## Exposing on your own domain via Cloudflare (access off-VPN)

A named Cloudflare Tunnel reaches the loopback app with no inbound ports, and Cloudflare
Access gates it at the edge so it's never publicly exposed:

```bash
# 1. install cloudflared, then authenticate + pick your domain (opens a browser)
cloudflared tunnel login
# 2. create the tunnel and route a hostname to it
cloudflared tunnel create cc-deck
cloudflared tunnel route dns cc-deck claude.example.com
# 3. config pointing at the local app (use a dedicated file if you have other tunnels)
cat > ~/.cloudflared/cc-deck.config.yml <<YAML
tunnel: <TUNNEL_ID>
credentials-file: $HOME/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: claude.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
YAML
# 4. run it (a systemd user service like cc-deck's keeps it up; enable-linger to persist)
cloudflared tunnel --config ~/.cloudflared/cc-deck.config.yml run
```

Then, in **Zero Trust → Access → Applications**, add a **self-hosted** app for
`claude.example.com` with an **Allow** policy limited to your email (the built-in
**One-time PIN** method emails you a code — no IdP setup needed). Now reaching the hostname
requires a Cloudflare login *before* the app is touched, and the app password is a second
layer. cc-deck sets `secure` cookies when it sees `x-forwarded-proto: https`, and WebSockets
(the terminal) pass through Access using the browser's Access cookie, so it all works behind
the tunnel. Keep your Tailscale route as well — on-VPN access is unaffected.

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
