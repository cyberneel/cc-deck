#!/usr/bin/env bash
# cc-deck updater for a git-clone install: fast-forwards to the upstream branch,
# reinstalls deps only if the lockfile changed, rebuilds, and restarts the systemd
# user service. Sessions keep running (the unit uses KillMode=process, and restore
# only relaunches on a fresh boot). If the install or build fails, it rolls back to
# the previous commit and leaves the running server alone.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
CCDECK_DIR="$(pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }
die()  { warn "$1"; exit 1; }

[ -z "${CCDECK_TENANT_ID:-}" ] || die "Hosted cc-deck is updated by image roll, not this script."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Not a git checkout — reinstall from git (or pull a newer Docker image)."
git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || die "This branch has no upstream to update from (git branch -u origin/main)."
git diff --quiet HEAD || die "You have local changes to tracked files — commit or stash them first."

bold "Checking for updates…"
git fetch --quiet
OLD="$(git rev-parse HEAD)"
BEHIND="$(git rev-list --count 'HEAD..@{u}')"
if [ "$BEHIND" = 0 ]; then ok "Already up to date ($(git rev-parse --short HEAD))."; exit 0; fi
echo "$BEHIND new commit(s):"
git log --oneline --no-decorate 'HEAD..@{u}' | head -20
git merge --ff-only --quiet '@{u}' || die "Local commits have diverged from upstream — rebase or merge by hand."

rollback() {
  trap - ERR
  warn "Update failed — rolling back to ${OLD:0:7}."
  git reset --hard --quiet "$OLD" # safe: the tree was clean before the fast-forward
  if ! git diff --quiet "$OLD" "$NEW" -- package-lock.json; then npm ci; fi
  npm run build
  die "Rolled back; the running cc-deck was not restarted."
}
NEW="$(git rev-parse HEAD)"
trap rollback ERR
if ! git diff --quiet "$OLD" "$NEW" -- package-lock.json; then
  bold "Dependencies changed — installing…"
  npm ci
fi
bold "Building frontend…"
npm run build
trap - ERR

# Restart only if the installed user service runs THIS checkout.
if command -v systemctl >/dev/null 2>&1 \
  && [ "$(systemctl --user show cc-deck -p WorkingDirectory --value 2>/dev/null)" = "$CCDECK_DIR" ]; then
  systemctl --user restart cc-deck
  ok "Updated ${OLD:0:7} → ${NEW:0:7} and restarted cc-deck. Reload the page."
else
  ok "Updated ${OLD:0:7} → ${NEW:0:7}. Restart cc-deck (stop and re-run npm start) to finish."
fi
