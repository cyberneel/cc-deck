#!/bin/sh
set -e

# Fall back to an ephemeral cookie secret so we never use the insecure default.
# Set CCDECK_SECRET in the environment to keep logins valid across restarts.
if [ -z "$CCDECK_SECRET" ]; then
  CCDECK_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  export CCDECK_SECRET
  echo "[cc-deck] generated an ephemeral CCDECK_SECRET (set one in the env to persist logins)."
fi

if [ -z "$CCDECK_PASSWORD" ]; then
  echo "[cc-deck] WARNING: CCDECK_PASSWORD is not set — login is effectively disabled. Set it in the env."
fi

# The CLIs need to be authenticated once; their creds live under $HOME (keep it on
# a volume). Nudge the user if neither is set up yet.
if [ ! -e "$HOME/.claude/.credentials.json" ] && [ ! -d "$HOME/.claude/projects" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
  echo "[cc-deck] No CLI auth found. Log in once inside the container, e.g.:"
  echo "           docker compose exec cc-deck claude    # then /login"
  echo "           docker compose exec cc-deck codex login"
fi

exec "$@"
