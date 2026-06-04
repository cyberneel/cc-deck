#!/usr/bin/env bash
# cc-deck setup — installs deps, builds the frontend, creates .env, and (optionally)
# installs a systemd user service. Safe to re-run; it won't overwrite an existing .env.
set -euo pipefail

CCDECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$CCDECK_DIR"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }

bold "cc-deck setup  ($CCDECK_DIR)"

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
need node "install Node.js >= 18 (https://nodejs.org)"
need npm  "comes with Node.js"
need tmux "install tmux (your package manager)"
need claude "install the Claude CLI (https://claude.com/claude-code) — or set CCDECK_LAUNCH to another command"
if [ "$missing" = 1 ]; then
  warn "Some prerequisites are missing. Install them, then re-run ./setup.sh"
  [ "${CCDECK_FORCE:-}" = 1 ] || exit 1
fi

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node $NODE_MAJOR detected; cc-deck needs >= 18."
  exit 1
fi

# ---- 2. dependencies + build ----
bold "Installing dependencies…"
npm install
bold "Building frontend…"
npm run build

# ---- 3. .env ----
if [ -f .env ]; then
  ok ".env already exists — leaving it untouched."
else
  bold "Creating .env…"
  cp .env.example .env
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  # portable in-place sed (GNU + BSD)
  sed_i() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
  sed_i "s|^CCDECK_SECRET=.*|CCDECK_SECRET=$SECRET|" .env

  PW=""
  if [ -t 0 ]; then
    printf "Set a login password (leave blank to edit .env yourself later): "
    read -rs PW; echo
  fi
  if [ -n "$PW" ]; then
    esc_pw=$(printf '%s' "$PW" | sed 's/[\\&|]/\\&/g')
    sed_i "s|^CCDECK_PASSWORD=.*|CCDECK_PASSWORD=$esc_pw|" .env
    ok "Password set; secret generated."
  else
    warn "No password set yet — edit CCDECK_PASSWORD in .env before exposing cc-deck."
  fi
fi

# ---- 4. optional systemd user service (Linux) ----
if command -v systemctl >/dev/null 2>&1 && [ "$(uname)" = "Linux" ]; then
  install_svc="n"
  if [ -t 0 ]; then
    printf "Install & start a systemd *user* service so cc-deck runs in the background? [y/N] "
    read -r install_svc
  fi
  if [ "$install_svc" = "y" ] || [ "$install_svc" = "Y" ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    SVC_PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
    sed -e "s|__CCDECK_DIR__|$CCDECK_DIR|g" \
        -e "s|__NODE__|$NODE_BIN|g" \
        -e "s|__PATH__|$SVC_PATH|g" \
        systemd/cc-deck.service > "$UNIT_DIR/cc-deck.service"
    systemctl --user daemon-reload
    systemctl --user enable --now cc-deck
    ok "Service installed. Logs: journalctl --user -u cc-deck -f"
    warn "To keep it running while logged out: sudo loginctl enable-linger \"$USER\""
  fi
fi

PORT="$(grep -E '^PORT=' .env | cut -d= -f2 || true)"; PORT="${PORT:-8787}"
bold "Done."
echo "Start manually with:  npm start   (listens on 127.0.0.1:$PORT)"
echo "Expose on a tailnet:  tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
echo "See README.md for Cloudflare / domain instructions."
