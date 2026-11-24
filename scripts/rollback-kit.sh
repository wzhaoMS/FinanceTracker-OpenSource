#!/usr/bin/env bash
# rollback-kit.sh: the deployment's snapshot and rollback kit (design §11.3 steps 10, 11, 11a; §11.5 step 0). Nothing here
# changes the live tree, the live configuration, Serve or any state file.
#
#   snapshot --snap SNAP [--tree T]   step 10: code snapshot (symlinks, modes and exec bits kept), ~/bin/start-finance-mac.sh,
#                                     the live holdr.conf (or holdr.conf.absent: the target configuration a revert restores)
#                                     and `tailscale serve status --json`; then step 11's restore test of the snapshot
#   prepare --snap SNAP --stage C     step 11a: KR=~/holdr-rollback/<stamp of SNAP> with K (an APFS clone of the verified staging
#                                     tree), KC (the candidate holdr.conf) and kit-runtime.txt; the manifest goes to
#                                     SNAP/rollback-kit.sha256 and SNAP/rollback-kit.links; then `verify`
#   verify --snap SNAP                step 11a's checks, and step 0 of every rollback
set -euo pipefail
umask 077

NODE="${HOLDR_NODE:-$(command -v node || true)}"
case "$NODE" in /*) ;; *) echo "rollback-kit: set HOLDR_NODE to an absolute Node executable" >&2; exit 1 ;; esac
[ -x "$NODE" ] || { echo "rollback-kit: HOLDR_NODE is not executable" >&2; exit 1; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
NPM="$(dirname "$NODE")/npm"
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# This script's own helpers (C's while preparing, K's when verifying a kit, which the manifest pins first).
SCRIPTS=$(cd "$(dirname "$0")" && pwd -P)
# Every Tailscale CLI call is bounded (B-D33): <seconds> <file> [args...].
bounded() { "$NODE" "$SCRIPTS/lib/bounded-cli.mjs" "$@"; }
LIVE_CONF="$HOME/Library/Application Support/Holdr/holdr.conf"
fail() { echo "rollback-kit: $*" >&2; exit 1; }
usage() { echo "Usage: rollback-kit.sh snapshot --snap SNAP [--tree T] | prepare --snap SNAP --stage C | verify --snap SNAP" >&2; exit 2; }

command="${1:-}"
[ "$#" -gt 0 ] && shift
snap=""; tree=""; stage=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --snap) [ "$#" -ge 2 ] || usage; snap="$2"; shift 2 ;;
    --tree) [ "$#" -ge 2 ] || usage; tree="$2"; shift 2 ;;
    --stage) [ "$#" -ge 2 ] || usage; stage="$2"; shift 2 ;;
    *) usage ;;
  esac
done
case "$snap" in /*) ;; *) usage ;; esac
STAMP=$(basename "$snap")
KR="$HOME/holdr-rollback/$STAMP"
K="$KR/FinanceTracker"
KC="$KR/holdr.conf"

# The only holdr.conf keys a kit needs to name its external programs (trusted configuration of KC).
conf_key() {
  local file="$1" key="$2" count
  count=$(grep -c "^$key=" "$file" || true)
  [ "$count" -le 1 ] || fail "E0I_CONFIG_FILE ($key repeated in $file)"
  if [ "$count" = 1 ]; then sed -n "s/^$key=//p" "$file"; fi
}
tree_counts() { # symlinks and owner-executable regular files, with the snapshot's excludes
  (cd "$1" && find . \( -path ./apps/api/data -o -path ./backups \) -prune -o -type l -print | wc -l | tr -d ' ')
  (cd "$1" && find . \( -path ./apps/api/data -o -path ./backups \) -prune -o -type f -perm -u+x -print | wc -l | tr -d ' ')
}
runtime_report() {
  local cli="$1"
  printf 'node %s %s\n' "$NODE" "$("$NODE" --version)"
  printf 'npm %s %s\n' "$NPM" "$("$NPM" --version)"
  local version
  version=$(bounded 10 "$cli" version 2>/dev/null) || version=unavailable
  printf 'tailscale %s %s\n' "$cli" "${version%%$'\n'*}"
}

case "$command" in
  snapshot)
    tree="${tree:-${HOLDR_ROOT:-$HOME/Holdr}/FinanceTracker}"
    T=$(cd "$tree" && pwd -P)
    [ ! -e "$snap" ] || fail "$snap already exists; snapshots are never reused"
    mkdir -p "$(dirname "$snap")"
    mkdir -m 700 "$snap"
    rsync -a --exclude /apps/api/data/ --exclude /backups/ "$T/" "$snap/FinanceTracker/"
    if [ -f "$HOME/bin/start-finance-mac.sh" ]; then cp -p "$HOME/bin/start-finance-mac.sh" "$snap/start-finance-mac.sh"; fi
    if [ -e "$LIVE_CONF" ]; then cp -p "$LIVE_CONF" "$snap/holdr.conf"; chmod 600 "$snap/holdr.conf"; else : > "$snap/holdr.conf.absent"; fi
    cli=""
    if [ -f "$snap/holdr.conf" ]; then cli=$(conf_key "$snap/holdr.conf" HOLDR_TAILSCALE_CLI); fi
    cli="${cli:-$(command -v "${HOLDR_TAILSCALE:-tailscale}" || true)}"
    [ -n "$cli" ] || fail "no Tailscale CLI to record serve-status.json"
    bounded 10 "$cli" serve status --json > "$snap/serve-status.json" || fail "tailscale serve status --json failed or timed out; the snapshot is incomplete"
    # Step 11: the restore test of the snapshot.
    found=$(find "$snap" \( -name 'finance.db*' -o -name '*.db-wal' -o -name service-token \) -print | head -n 1)
    [ -z "$found" ] || fail "state file in the snapshot: $found"
    [ "$(tree_counts "$T")" = "$(tree_counts "$snap/FinanceTracker")" ] || fail "symlink or executable counts differ between $T and the snapshot"
    "$snap/FinanceTracker/node_modules/.bin/tsx" --version >/dev/null || fail "the snapshot's tsx does not run"
    echo "snapshot $snap: code, start script, $( [ -f "$snap/holdr.conf" ] && echo holdr.conf || echo holdr.conf.absent ), serve-status.json; restore test ok"
    ;;

  prepare)
    case "$stage" in /*) ;; *) usage ;; esac
    [ -d "$snap" ] || fail "no snapshot at $snap (run snapshot first)"
    [ ! -e "$KR" ] || fail "$KR exists; a kit belongs to one deployment and is never reused"
    [ -d "$stage/FinanceTracker" ] && [ -f "$stage/holdr.conf" ] || fail "$stage must hold FinanceTracker/ and holdr.conf"
    mkdir -p "$HOME/holdr-rollback"
    chmod 700 "$HOME/holdr-rollback"
    mkdir -m 700 "$KR"
    cp -cRp "$stage/FinanceTracker" "$K"
    cp -p "$stage/holdr.conf" "$KC"
    chmod 600 "$KC"
    cli=$(conf_key "$KC" HOLDR_TAILSCALE_CLI)
    [ -n "$cli" ] || fail "E0I_CONFIG_FILE (the kit configuration names no HOLDR_TAILSCALE_CLI)"
    runtime_report "$cli" > "$KR/kit-runtime.txt"
    chmod 600 "$KR/kit-runtime.txt"
    # The links first, from a walk of KR (scripts/lib/kit-links.mjs): one JSON record per link, and no name or target that a
    # line-oriented listing could split (B2 round-2 finding 1); every link contained in K.
    "$NODE" "$SCRIPTS/lib/kit-links.mjs" record "$(cd "$KR" && pwd -P)" > "$snap/rollback-kit.links" \
      || fail "a name or symlink in the kit is refused, absolute or resolves outside K (see above)"
    (cd "$KR" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) > "$snap/rollback-kit.sha256"
    chmod 600 "$snap/rollback-kit.sha256" "$snap/rollback-kit.links"
    exec /bin/bash "$0" verify --snap "$snap"
    ;;

  verify)
    [ -d "$KR" ] && [ -f "$snap/rollback-kit.sha256" ] && [ -f "$snap/rollback-kit.links" ] || fail "no kit for $snap"
    (cd "$KR" && shasum -a 256 -c --quiet "$snap/rollback-kit.sha256") || fail "kit files differ from $snap/rollback-kit.sha256"
    # A fresh walk of KR must give exactly the recorded links, and every actual link lies inside K, its target is relative, and
    # it resolves inside K as the kernel resolves it: every symlink on the way followed, `..` taken physically, never passing
    # outside K (scripts/lib/kit-links.mjs, pinned by the manifest just checked; lexical checks miss chains). It also refuses
    # any name with a control character, so the line-oriented file comparison below cannot be split.
    KR_REAL=$(cd "$KR" && pwd -P)
    "$NODE" "$SCRIPTS/lib/kit-links.mjs" verify "$KR_REAL" "$snap/rollback-kit.links" \
      || fail "the kit's symlinks differ from $snap/rollback-kit.links, or one is refused, absolute or resolves outside K"
    listed=$(sed 's/^[0-9a-f]\{64\}  //' "$snap/rollback-kit.sha256" | LC_ALL=C sort)
    present=$(cd "$KR" && find . -type f -print | LC_ALL=C sort)
    [ "$listed" = "$present" ] || fail "the kit has files that the manifest does not list (or lacks listed ones)"
    state=$(find "$KR" \( -name 'finance.db*' -o -name service-token -o -name 'sync-auth-state*' -o -name 'lifecycle-state*' \
      -o -name lifecycle.lock -o -name authorization.lock -o -name recovery.lock \) -print | head -n 1)
    [ -z "$state" ] || fail "state file in the kit: $state"
    cli=$(conf_key "$KC" HOLDR_TAILSCALE_CLI)
    runtime_report "$cli" | cmp -s - "$KR/kit-runtime.txt" || fail "node, npm or the Tailscale CLI differ from $KR/kit-runtime.txt"
    "$K/node_modules/.bin/tsx" --version >/dev/null || fail "the kit's tsx does not run"
    status=$(cd "$K" && HOLDR_CONFIG="$KC" "$NPM" --silent run holdr-lifecycle -- status) || fail "holdr-lifecycle status from the kit failed"
    control=$(conf_key "$KC" HOLDR_CONTROL_DIR)
    case "$status" in *"control dir: $control"*) ;; *) fail "the kit's holdr-lifecycle does not name the live control dir" ;; esac
    [ "$(HOLDR_CONFIG="$KC" /bin/bash "$K/scripts/holdr-stop.sh" --version)" = "holdr-stop 2" ] || fail "the kit's holdr-stop is not version 2"
    HOLDR_CONFIG="$KC" /bin/bash "$K/scripts/holdr-publish-legacy.sh" --kit "$K" --check-only || fail "the kit's legacy publisher check failed"
    echo "rollback kit $KR verified"
    ;;

  *) usage ;;
esac
