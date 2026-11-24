#!/usr/bin/env bash
# holdr-publish-legacy: the guarded legacy publication of a TCP target (design §8.3, §11.5; before AL1 sign-off only). Run from a
# rollback kit's own copy ($K/scripts, never ~/bin): it publishes http://127.0.0.1:<web port> through Tailscale Serve only when
# the web port's single listener is the restored launcher's own Vite (PID, cwd and command against --root, and a Vite
# document), starting from the socket target (approved-dist) that keeps the login-era launcher from publishing by itself. On
# any other verdict after publishing it turns 443 off again. --check-only verifies every dependency and runs the validator on
# the current configuration without changing anything.
set -euo pipefail
umask 077

VERSION=1
NODE="${HOLDR_NODE:-$(command -v node || true)}"
case "$NODE" in /*) ;; *) echo "holdr-publish-legacy: set HOLDR_NODE to an absolute Node executable" >&2; exit 1 ;; esac
[ -x "$NODE" ] || { echo "holdr-publish-legacy: HOLDR_NODE is not executable" >&2; exit 1; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SELF=$(cd "$(dirname "$0")/.." && pwd -P)

usage() { echo "Usage: holdr-publish-legacy.sh --kit <K> [--root <dir>] [--check-only] [--version]" >&2; exit 2; }
kit=""
root_arg=""
check_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) echo "holdr-publish-legacy $VERSION"; exit 0 ;;
    --kit) [ "$#" -ge 2 ] && [ -n "$2" ] || usage; kit="$2"; shift 2 ;;
    --root) [ "$#" -ge 2 ] && [ -n "$2" ] || usage; root_arg="$2"; shift 2 ;;
    --check-only) check_only=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$kit" ] || usage
# Only the kit's own copy runs: the validator and its node_modules come from the same pinned tree.
kit=$(cd "$kit" 2>/dev/null && pwd -P) || { echo "holdr-publish-legacy: no kit at the given path" >&2; exit 1; }
[ "$kit" = "$SELF" ] || { echo "holdr-publish-legacy: run the kit's own copy ($kit/scripts/holdr-publish-legacy.sh)" >&2; exit 1; }

ROOT="${root_arg:-${HOLDR_ROOT:-$HOME/Holdr}}"
WEB_PORT="${HOLDR_WEB_PORT:-8888}"
case "$WEB_PORT" in ''|*[!0-9]*) echo "holdr-publish-legacy: invalid web port" >&2; exit 1 ;; esac

# The rollback operation's configuration (HOLDR_CONFIG="$KC"): only these trusted keys are read.
conf_file="${HOLDR_CONFIG:-$HOME/Library/Application Support/Holdr/holdr.conf}"
if [ "$conf_file" = none ] || [ -L "$conf_file" ] || [ ! -f "$conf_file" ]; then
  echo "holdr-publish-legacy: E0I_CONFIG_FILE (HOLDR_CONFIG must name the kit's holdr.conf)" >&2; exit 1
fi
read -r conf_owner conf_mode < <(stat -f '%u %Lp' "$conf_file")
if [ "$conf_owner" != "$(id -u)" ] || [ "$conf_mode" != 600 ]; then
  echo "holdr-publish-legacy: E0I_CONFIG_FILE ($conf_file must be a 0600 file of $(id -un))" >&2; exit 1
fi
conf_key() {
  local count
  count=$(grep -c "^$1=" "$conf_file" || true)
  if [ "$count" -gt 1 ]; then echo "holdr-publish-legacy: E0I_CONFIG_FILE ($1 repeated)" >&2; exit 1; fi
  if [ "$count" = 1 ]; then sed -n "s/^$1=//p" "$conf_file"; fi
}
cli=$(conf_key HOLDR_TAILSCALE_CLI)
origin=$(conf_key HOLDR_PUBLIC_ORIGIN)
socket=$(conf_key HOLDR_SERVE_SOCKET)
legacy=$(conf_key HOLDR_LEGACY_VITE_ROLLBACK)
case "$cli" in /*) ;; *) echo "holdr-publish-legacy: E0I_CONFIG_FILE (HOLDR_TAILSCALE_CLI missing or not absolute)" >&2; exit 1 ;; esac
case "$origin" in https://*) ;; *) echo "holdr-publish-legacy: E0I_CONFIG_FILE (HOLDR_PUBLIC_ORIGIN missing)" >&2; exit 1 ;; esac
case "$socket" in /*) ;; *) echo "holdr-publish-legacy: E0I_CONFIG_FILE (HOLDR_SERVE_SOCKET missing)" >&2; exit 1 ;; esac
host=${origin#https://}

for tool in "$NODE" "$SELF/node_modules/.bin/tsx" "$cli" /usr/sbin/lsof /bin/ps /usr/bin/curl; do
  [ -x "$tool" ] || { echo "holdr-publish-legacy: missing dependency $tool" >&2; exit 1; }
done
for helper in "$SELF/scripts/lib/bounded-cli.mjs" "$SELF/scripts/lib/serve-verdict.ts"; do
  [ -f "$helper" ] || { echo "holdr-publish-legacy: missing dependency $helper" >&2; exit 1; }
done
verdict() {
  "$SELF/node_modules/.bin/tsx" "$SELF/scripts/lib/serve-verdict.ts" --cli "$cli" --host "$host" --socket "$socket" \
    --web-port "$WEB_PORT" 2>/dev/null | awk '{print $1}' || echo error
}
# Every change to Serve is bounded (B-D33): a hanging CLI never blocks the rollback.
serve_change() { "$NODE" "$SELF/scripts/lib/bounded-cli.mjs" 20 "$cli" "$@"; }
before=$(verdict)
if [ "$check_only" = 1 ]; then
  echo "holdr-publish-legacy $VERSION: dependencies ok; Serve verdict $before; nothing changed"
  [ "$before" != error ] || exit 1
  exit 0
fi
# AL1 sign-off removes the key: from then on no TCP target is ever published.
[ "$legacy" = 1 ] || { echo "holdr-publish-legacy: E0I_TCP_TARGET_RETIRED (no HOLDR_LEGACY_VITE_ROLLBACK=1); nothing changed" >&2; exit 1; }
case "$before" in
  approved-dist|approved-vite) ;;
  *) echo "holdr-publish-legacy: E0I_SERVE (Serve is '$before', expected the socket target); nothing changed" >&2; exit 1 ;;
esac

FT=$(cd "$ROOT/FinanceTracker" 2>/dev/null && pwd -P) || { echo "holdr-publish-legacy: no Holdr tree at $ROOT" >&2; exit 1; }
listeners=$(lsof -nP -t -iTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | sort -u | xargs || true)
owner_ok=0
case "$listeners" in
  ''|*' '*) ;;
  *)
    directory=$(lsof -a -p "$listeners" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    command=$(ps -p "$listeners" -o command=)
    user=$(ps -p "$listeners" -o user= | xargs)
    if [ "$user" = "$(id -un)" ] && [ "$directory" = "$FT/apps/web" ]; then
      case "$command" in *"$FT/node_modules/"*"vite"*) owner_ok=1 ;; esac
    fi ;;
esac
if [ "$owner_ok" = 1 ] && ! curl -fsS --connect-timeout 1 --max-time 3 "http://127.0.0.1:$WEB_PORT/" 2>/dev/null | grep -q '/@vite/client'; then
  owner_ok=0
fi
if [ "$owner_ok" != 1 ]; then
  echo "holdr-publish-legacy: E0I_LEGACY_OWNER (port $WEB_PORT's listener (${listeners:-none}) is not the Vite of $FT); Serve unchanged" >&2
  exit 1
fi
if [ "$before" = approved-vite ]; then echo "Tailscale Serve already targets http://127.0.0.1:$WEB_PORT (owner verified)"; exit 0; fi
serve_change serve --bg --https=443 "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1 || echo "holdr-publish-legacy: the Serve command failed or timed out" >&2
after=$(verdict)
if [ "$after" != approved-vite ]; then
  serve_change serve --https=443 off >/dev/null 2>&1 || echo "holdr-publish-legacy: turning 443 off failed or timed out" >&2
  final=$(verdict)
  echo "holdr-publish-legacy: E0I_SERVE_SWITCH_FAILED (Serve became '$after'; after turning 443 off it is '$final'$( [ "$final" = empty ] || echo "; turn it off by hand: $cli serve --https=443 off"))" >&2
  exit 1
fi
echo "Tailscale Serve: $origin -> http://127.0.0.1:$WEB_PORT (guarded legacy publication)"
