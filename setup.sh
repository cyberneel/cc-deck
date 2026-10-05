#!/usr/bin/env bash
# Polymux setup — installs deps, builds the frontend, creates .env, and (optionally)
# installs a systemd user service. Safe to re-run; it won't overwrite an existing .env.
set -euo pipefail

POLYMUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$POLYMUX_DIR"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }

bold "Polymux setup  ($POLYMUX_DIR)"

# ---- 1. prerequisites ----
missing=0
need() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "  ✓ $1 ($(command -v "$1"))"
  else
    warn "  ✗ $1 not found — $2"
    missing=1
  fi
}
echo "Checking prerequisites:"
need node "install Node.js >= 20 (https://nodejs.org)"
need npm  "comes with Node.js"
need tmux "install tmux (your package manager)"
need claude "install the Claude CLI (https://claude.com/claude-code) — or set POLYMUX_LAUNCH to another command"
if [ "$missing" = 1 ]; then
  warn "Some prerequisites are missing. Install them, then re-run ./setup.sh"
  [ "${POLYMUX_FORCE:-}" = 1 ] || exit 1
fi

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $NODE_MAJOR detected; Polymux needs >= 20."
  exit 1
fi

# ---- 2. dependencies + build ----
bold "Installing dependencies…"
npm install
bold "Building frontend…"
npm run build

# ---- optional: ccburn for live plan-limit charts in the Usage tab ----
if ! command -v ccburn >/dev/null 2>&1; then
  inst="n"
  if [ -t 0 ]; then
    printf "Install ccburn (live plan-limit usage in the Usage tab)? [y/N] "
    read -r inst
  fi
  if [ "$inst" = "y" ] || [ "$inst" = "Y" ]; then
    npm install -g ccburn || warn "ccburn install failed — the Usage tab still works (ROI from transcripts); just no live limits."
  fi
else
  ok "ccburn already installed ($(command -v ccburn))."
fi

# ---- 3. .env ----
if [ -f .env ]; then
  ok ".env already exists — leaving it untouched."
else
  bold "Creating .env…"
  cp .env.example .env
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  # portable in-place sed (GNU + BSD)
  sed_i() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
  sed_i "s|^POLYMUX_SECRET=.*|POLYMUX_SECRET=$SECRET|" .env

  PW=""
  if [ -t 0 ]; then
    printf "Set a login password (leave blank to edit .env yourself later): "
    read -rs PW; echo
  fi
  if [ -n "$PW" ]; then
    esc_pw=$(printf '%s' "$PW" | sed 's/[\\&|]/\\&/g')
    sed_i "s|^POLYMUX_PASSWORD=.*|POLYMUX_PASSWORD=$esc_pw|" .env
    ok "Password set; secret generated."
  else
    warn "No password set yet — edit POLYMUX_PASSWORD in .env before exposing Polymux."
  fi
fi

# ---- 4. optional systemd user service (Linux) ----
if command -v systemctl >/dev/null 2>&1 && [ "$(uname)" = "Linux" ]; then
  install_svc="n"
  if [ -t 0 ]; then
    printf "Install & start a systemd *user* service so Polymux runs in the background? [y/N] "
    read -r install_svc
  fi
  if [ "$install_svc" = "y" ] || [ "$install_svc" = "Y" ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    SVC_PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
    sed -e "s|__POLYMUX_DIR__|$POLYMUX_DIR|g" \
        -e "s|__NODE__|$NODE_BIN|g" \
        -e "s|__PATH__|$SVC_PATH|g" \
        systemd/polymux.service > "$UNIT_DIR/polymux.service"
    systemctl --user daemon-reload
    systemctl --user enable --now polymux
    ok "Service installed. Logs: journalctl --user -u polymux -f"
    warn "To keep it running while logged out: sudo loginctl enable-linger \"$USER\""
  fi
fi

PORT="$(grep -E '^PORT=' .env | cut -d= -f2 || true)"; PORT="${PORT:-8787}"
bold "Done."
echo "Start manually with:  npm start   (listens on 127.0.0.1:$PORT)"
echo "Expose on a tailnet:  tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
echo "See README.md for Cloudflare / domain instructions."
