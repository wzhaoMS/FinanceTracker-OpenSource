#!/usr/bin/env bash
# deploy-apply.sh: the maintenance apply step (design §11.4 step 16) and the revert (§11.5); the bash lease-accepting role of
# §9.3 rule 4. Inside a lease it runs only bash tools (which keep fd 3), the lease-aware `holdr-leased.sh` roles, and helpers
# started with fd 3 closed (the Tailscale CLI never gets the lease); never npm, npx or a tsx launcher.
#
#   --record-archive          in the staging tree, right after extraction and before `npm ci`: <stage>/archive.sha256
#   --kit K                   apply, run from ~/holdr-staging/C/FinanceTracker/scripts inside `holdr-lifecycle exclusive`:
#                             a) the archive's files into T, every hash checked; b) node_modules swapped if the lockfile
#                             changed; c) release and native build copied, verify-release; d) ~/bin/start-finance-mac.sh and
#                             holdr.conf installed; e) validate-offline. Any failure: the revert from K in the same lease.
#   --revert SNAP --kit K     T, ~/bin/start-finance-mac.sh and the target configuration from SNAP; validate-offline against
#                             both configurations; Serve restored to exactly SNAP/serve-status.json (never a TCP target)
# HOLDR_CONFIG names the rollback operation's configuration (KC); it locates the lease, the control and data dirs and the
# socket, never the target configuration.
set -euo pipefail
umask 077

NODE="${HOLDR_NODE:-$(command -v node || true)}"
case "$NODE" in /*) ;; *) echo "deploy-apply: set HOLDR_NODE to an absolute Node executable" >&2; exit 1 ;; esac
[ -x "$NODE" ] || { echo "deploy-apply: HOLDR_NODE is not executable" >&2; exit 1; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SELF=$(cd "$(dirname "$0")/.." && pwd -P)
LIVE_CONF="$HOME/Library/Application Support/Holdr/holdr.conf"
T="${HOLDR_ROOT:-$HOME/Holdr}/FinanceTracker"
fail() { echo "deploy-apply: $*" >&2; exit 1; }
usage() { echo "Usage: deploy-apply.sh --record-archive | --kit K | --revert SNAP --kit K" >&2; exit 2; }

mode=""; kit=""; snap=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --record-archive) mode=record; shift ;;
    --kit) [ "$#" -ge 2 ] || usage; kit="$2"; shift 2 ;;
    --revert) [ "$#" -ge 2 ] || usage; mode=revert; snap="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$mode" ] || { [ -n "$kit" ] && mode=apply; } || usage

if [ "$mode" = record ]; then
  STAGE=$(dirname "$SELF")
  [ ! -e "$STAGE/archive.sha256" ] || fail "$STAGE/archive.sha256 exists; record it once, right after extraction"
  [ ! -e "$SELF/node_modules" ] || fail "record the archive before npm ci (node_modules exists)"
  (cd "$SELF" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) > "$STAGE/archive.sha256"
  echo "recorded $(wc -l < "$STAGE/archive.sha256" | tr -d ' ') files in $STAGE/archive.sha256"
  exit 0
fi

case "$kit" in /*) ;; *) usage ;; esac
K=$(cd "$kit" && pwd -P)
KC="${HOLDR_CONFIG:-}"
case "$KC" in /*) ;; *) fail "HOLDR_CONFIG must name the rollback operation's configuration (the kit's holdr.conf)" ;; esac
[ -f "$KC" ] || fail "no configuration at $KC"
T=$(cd "$T" && pwd -P)
conf_key() {
  local count
  count=$(grep -c "^$2=" "$1" || true)
  [ "$count" -le 1 ] || fail "E0I_CONFIG_FILE ($2 repeated in $1)"
  if [ "$count" = 1 ]; then sed -n "s/^$2=//p" "$1"; fi
}
cli=$(conf_key "$KC" HOLDR_TAILSCALE_CLI)
origin=$(conf_key "$KC" HOLDR_PUBLIC_ORIGIN)
socket=$(conf_key "$KC" HOLDR_SERVE_SOCKET)

# The lease: proven by the kit's lease-aware role (descriptor identity, an exclusive lease present, the marker's nonce).
"$K/scripts/holdr-leased.sh" status >/dev/null || { echo "deploy-apply: E0I_LEASE_REQUIRED (run inside holdr-lifecycle exclusive)" >&2; exit 3; }

# Helpers outside the lease: fd 3 closed and the lease variables dropped (the Tailscale CLI never gets the lease). Every CLI
# call is bounded by K's own runner (B-D33): a hanging CLI never holds the lease indefinitely.
tailscale() { env -u HOLDR_LIFECYCLE_LEASE_FD -u HOLDR_LIFECYCLE_LEASE "$NODE" "$K/scripts/lib/bounded-cli.mjs" 20 "$cli" "$@" 3>&-; }
verdict() {
  env -u HOLDR_LIFECYCLE_LEASE_FD -u HOLDR_LIFECYCLE_LEASE "$NODE" --import "$K/node_modules/tsx/dist/loader.mjs" \
    "$K/scripts/lib/serve-verdict.ts" "$@" --host "${origin#https://}" --socket "$socket" --web-port "${HOLDR_WEB_PORT:-8888}" 3>&- 2>/dev/null \
    | awk '{print $1}' || echo error
}

if [ "$mode" = revert ]; then
  case "$snap" in /*) ;; *) usage ;; esac
  [ -d "$snap/FinanceTracker" ] || fail "no code snapshot in $snap"
  [ -f "$snap/serve-status.json" ] || fail "no serve-status.json in $snap"
  if [ -f "$snap/holdr.conf" ]; then target_config="$snap/holdr.conf"; elif [ -f "$snap/holdr.conf.absent" ]; then target_config=none; else
    fail "the snapshot names no target configuration"; fi
  excludes=(--exclude /apps/api/data/ --exclude /backups/)
  if [ -d "$snap/node_modules.live" ]; then
    # The reverse of step 16b: two renames on one volume.
    rm -rf "$T/node_modules"
    mv "$snap/node_modules.live" "$T/node_modules"
    excludes+=(--exclude /node_modules/)
  fi
  rsync -a --delete "${excludes[@]}" "$snap/FinanceTracker/" "$T/"
  mkdir -p "$HOME/bin"
  if [ -f "$snap/start-finance-mac.sh" ]; then cp -p "$snap/start-finance-mac.sh" "$HOME/bin/start-finance-mac.sh.revert.$$"; mv -f "$HOME/bin/start-finance-mac.sh.revert.$$" "$HOME/bin/start-finance-mac.sh"
  else rm -f "$HOME/bin/start-finance-mac.sh"; fi
  if [ "$target_config" = none ]; then rm -f "$LIVE_CONF"; else
    mkdir -p "$(dirname "$LIVE_CONF")"
    cp "$target_config" "$LIVE_CONF.revert.$$"; chmod 600 "$LIVE_CONF.revert.$$"; mv -f "$LIVE_CONF.revert.$$" "$LIVE_CONF"
  fi
  "$K/scripts/holdr-leased.sh" validate-offline --snap "$snap" --target-root "$T" --target-config "$target_config" \
    || fail "the reverted state did not validate; marker left in maintenance (escalate)"
  recorded=$(verdict --file "$snap/serve-status.json")
  current=$(verdict --cli "$cli")
  case "$recorded" in
    empty)
      if [ "$current" != empty ]; then tailscale serve --https=443 off >/dev/null 2>&1 || true; fi
      now=$(verdict --cli "$cli")
      [ "$now" = empty ] || fail "E0I_SERVE_RESTORE (Serve is '$now', not empty as recorded)" ;;
    approved-dist)
      if [ "$current" != approved-dist ]; then tailscale serve --bg --https=443 "unix:$socket" >/dev/null 2>&1 || true; fi
      now=$(verdict --cli "$cli")
      [ "$now" = approved-dist ] || fail "E0I_SERVE_RESTORE (Serve is '$now', not on the socket as recorded)" ;;
    approved-vite)
      # Never re-published here, and never left empty (the login-era launcher would publish it itself, §8.3).
      if [ "$current" = empty ]; then tailscale serve --bg --https=443 "unix:$socket" >/dev/null 2>&1 || true; fi
      now=$(verdict --cli "$cli")
      [ "$now" = approved-dist ] || fail "E0I_SERVE_RESTORE (Serve is '$now'; it could not be kept on the socket target)"
      echo "Serve stays on the socket target (502). After leaving maintenance: check that nothing listens on port ${HOLDR_WEB_PORT:-8888},"
      echo "run the restored ~/bin/start-finance-mac.sh, then: HOLDR_CONFIG=\"$KC\" \"$K/scripts/holdr-publish-legacy.sh\" --root \"$(dirname "$T")\" --kit \"$K\"" ;;
    *) fail "E0I_SERVE_RESTORE (the recorded Serve shape '$recorded' is not one a rollback restores)" ;;
  esac
  echo "reverted $T to $snap (target configuration: $target_config; Serve: $recorded)"
  exit 0
fi

# ------------------------------------------------------------------------------------------------------------ apply
STAGE=$(dirname "$SELF")
SNAP="$HOME/holdr-snapshots/$(basename "$(dirname "$K")")"
[ -d "$SNAP/FinanceTracker" ] || fail "no snapshot at $SNAP for kit $K"
[ -f "$STAGE/archive.sha256" ] || fail "no $STAGE/archive.sha256 (recorded at extraction)"
[ -f "$STAGE/holdr.conf" ] || fail "no candidate configuration at $STAGE/holdr.conf"
cmp -s "$STAGE/holdr.conf" "$KC" || fail "the kit's configuration is not the candidate's"
digest=$(conf_key "$KC" HOLDR_WEB_RELEASE)
case "$digest" in [0-9a-f]*) [ "${#digest}" = 64 ] || fail "E0I_RELEASE_CONFIG" ;; *) fail "E0I_RELEASE_CONFIG" ;; esac
release="apps/web/releases/${digest:0:12}"

revert() {
  echo "deploy-apply: step $1 failed; reverting from $K in the same lease" >&2
  if /bin/bash "$K/scripts/deploy-apply.sh" --revert "$SNAP" --kit "$K"; then
    local target=none
    if [ -f "$SNAP/holdr.conf" ]; then target="$SNAP/holdr.conf"; fi
    echo "deploy-apply: reverted; the marker stays maintenance. Check, then leave and start the old stack:" >&2
    echo "  HOLDR_CONFIG=\"$KC\" npm --prefix \"$K\" run holdr-lifecycle -- leave --snap \"$SNAP\" --target-root \"$T\" --target-config \"$target\"" >&2
    exit 4
  fi
  echo "deploy-apply: the revert failed too; the marker stays maintenance (escalate)" >&2
  exit 1
}
lock_changed=1
if cmp -s "$SELF/package-lock.json" "$T/package-lock.json"; then lock_changed=0; fi

# a) the archive's file set into T, then every file's hash checked against the archive's list.
(
  cd "$SELF"
  sed 's/^[0-9a-f]\{64\}  //' "$STAGE/archive.sha256" | while IFS= read -r file; do
    mkdir -p "$T/$(dirname "$file")"
    cp -p "$file" "$T/$file"
  done
) || revert a
(cd "$T" && shasum -a 256 -c --quiet "$STAGE/archive.sha256") || revert a
# a') Managed retirement (B-D24 as revised, B2 review 5): the files the candidate's own scripts/retired-files.txt names are
# removed from T. Only regular files and symlinks, only listed paths: a directory there, a malformed entry or a retired path in
# the archive fails step a. The snapshot keeps the old files, so a revert restores them; step e (validate-offline) refuses a
# tree that still contains one. The entry rule is apps/api/src/control/retiredFiles.ts's.
retire() {
  local list="$SELF/scripts/retired-files.txt" entry
  [ -f "$list" ] || return 0
  while IFS= read -r entry || [ -n "$entry" ]; do
    case "$entry" in ''|'#'*) continue ;; esac
    printf '%s\n' "$entry" | grep -Eq '^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$' || { echo "deploy-apply: malformed retired entry" >&2; return 1; }
    case "/$entry/" in */./*|*/../*|*//*) echo "deploy-apply: malformed retired entry" >&2; return 1 ;; esac
    case "$entry" in */|apps/api/data|apps/api/data/*|backups|backups/*|node_modules|node_modules/*) echo "deploy-apply: retired entry outside managed code" >&2; return 1 ;; esac
    if sed 's/^[0-9a-f]\{64\}  //' "$STAGE/archive.sha256" | grep -qxF "./$entry"; then echo "deploy-apply: the archive ships the retired $entry" >&2; return 1; fi
    if [ -L "$T/$entry" ] || [ -f "$T/$entry" ]; then
      rm -f "$T/$entry" || return 1
      echo "retired $entry"
    elif [ -e "$T/$entry" ]; then
      echo "deploy-apply: the retired $entry is not a file in $T" >&2
      return 1
    fi
  done < "$list"
}
retire || revert a
# b) node_modules swapped only if the lockfile changed: two renames, so links and exec bits stay as npm ci made them.
if [ "$lock_changed" = 1 ]; then
  { mv "$T/node_modules" "$SNAP/node_modules.live" && mv "$SELF/node_modules" "$T/node_modules"; } || revert b
fi
# c) the release, the native build and the compiled shared package (the API and every CLI load @finance-tracker/shared from
# packages/shared/dist), then the release verified in T (lease-aware role).
{ rm -rf "$T/$release" "$T/apps/api/native/build" "$T/packages/shared/dist" && mkdir -p "$T/apps/web/releases" "$T/apps/api/native" \
  && cp -Rp "$SELF/$release" "$T/$release" && cp -Rp "$SELF/apps/api/native/build" "$T/apps/api/native/build" \
  && cp -Rp "$SELF/packages/shared/dist" "$T/packages/shared/dist"; } || revert c
"$T/scripts/holdr-leased.sh" verify-release "$T/$release" --digest "$digest" || revert c
# d) the start script and the configuration.
{ mkdir -p "$HOME/bin" "$(dirname "$LIVE_CONF")" \
  && cp -p "$T/scripts/start-finance-mac.sh" "$HOME/bin/start-finance-mac.sh.apply.$$" && chmod 755 "$HOME/bin/start-finance-mac.sh.apply.$$" \
  && mv -f "$HOME/bin/start-finance-mac.sh.apply.$$" "$HOME/bin/start-finance-mac.sh" \
  && cp "$STAGE/holdr.conf" "$LIVE_CONF.apply.$$" && chmod 600 "$LIVE_CONF.apply.$$" && mv -f "$LIVE_CONF.apply.$$" "$LIVE_CONF"; } || revert d
# e) offline validation inside the lease: the live tree with the live configuration just installed, which is what lets a tree
# validate itself (B1 round-2 finding 3); the kit's KC, byte-equal but elsewhere, would not.
HOLDR_CONFIG="$LIVE_CONF" "$T/scripts/holdr-leased.sh" validate-offline || revert e
echo "applied $(basename "$STAGE") to $T (release ${digest:0:12}); validated offline under the inherited lease"
