#!/bin/sh
set -e

# Fall back to an ephemeral cookie secret so we never use the insecure default.
# Set POLYMUX_SECRET in the environment to keep logins valid across restarts.
# The old CCDECK_* names still count (the app maps them), so don't shadow them here.
if [ -z "$POLYMUX_SECRET$CCDECK_SECRET" ]; then
  POLYMUX_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  export POLYMUX_SECRET
  echo "[polymux] generated an ephemeral POLYMUX_SECRET (set one in the env to persist logins)."
fi

if [ -z "$POLYMUX_PASSWORD$CCDECK_PASSWORD" ]; then
  echo "[polymux] WARNING: POLYMUX_PASSWORD is not set — login is effectively disabled. Set it in the env."
fi

# The CLIs need to be authenticated once; their creds live under $HOME (keep it on
# a volume). Nudge the user if neither is set up yet.
if [ ! -e "$HOME/.claude/.credentials.json" ] && [ ! -d "$HOME/.claude/projects" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
  echo "[polymux] No CLI auth found. Log in once inside the container, e.g.:"
  echo "           docker compose exec polymux claude    # then /login"
  echo "           docker compose exec polymux codex login"
fi

exec "$@"
