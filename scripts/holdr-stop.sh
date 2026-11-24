#!/usr/bin/env bash
# holdr-stop: the stop role (design §9.3, §9.6). Stops only Holdr's own processes (PID files and listeners, ownership checked
# exactly like start-finance-mac.sh), applies the TCP-owner guard (§8.3: a Holdr listener on the web port is stopped only after a
# successful Serve read shows Serve does not target that port), sends SIGTERM and waits at most 10 s. It never reads release
# settings, never checks the lifecycle marker and never touches the database or any file: it works in maintenance, with a broken
# release and with an unreadable control dir. The only holdr.conf key it reads is HOLDR_TAILSCALE_CLI (trusted configuration).
# Run from the tree that ships it (T/scripts or a rollback kit's K/scripts); --root names the tree being stopped.
set -euo pipefail
umask 077

VERSION=2
NODE="${HOLDR_NODE:-$(command -v node || true)}"
case "$NODE" in /*) ;; *) echo "holdr-stop: set HOLDR_NODE to an absolute Node executable" >&2; exit 1 ;; esac
[ -x "$NODE" ] || { echo "holdr-stop: HOLDR_NODE is not executable" >&2; exit 1; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SELF=$(cd "$(dirname "$0")/.." && pwd -P)

root_arg=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) echo "holdr-stop $VERSION"; exit 0 ;;
    --expect-version)
      [ "$#" -ge 2 ] || { echo "holdr-stop: --expect-version needs a value" >&2; exit 2; }
      [ "$2" = "$VERSION" ] || { echo "holdr-stop: this is holdr-stop $VERSION, not $2" >&2; exit 2; }
      shift 2 ;;
    --root)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "holdr-stop: --root needs a value" >&2; exit 2; }
      root_arg="$2"; shift 2 ;;
    *) echo "Usage: holdr-stop.sh [--root <dir>] [--expect-version $VERSION] [--version]" >&2; exit 2 ;;
  esac
done

ROOT="${root_arg:-${HOLDR_ROOT:-$HOME/Holdr}}"
FT="$ROOT/FinanceTracker"
BRIDGE_RUNTIME="${HOLDR_BRIDGE_RUNTIME:-$HOME/Library/Application Support/Holdr}"
if [ -f "$BRIDGE_RUNTIME/portfolio-bridge/server.py" ]; then BRIDGE="$BRIDGE_RUNTIME/portfolio-bridge"; else BRIDGE="$ROOT/apps/portfolio-bridge"; fi
FT=$(cd "$FT" 2>/dev/null && pwd -P) || { echo "holdr-stop: no Holdr tree at $ROOT/FinanceTracker" >&2; exit 1; }
# Only the live deployment is stopped (B-D44, the start script's rule): a root, or the tree's physical parent, holding a
# holdr.conf or kit-runtime.txt (any entry, a dangling link included) is a staging tree or a rollback kit.
for dir in "$ROOT" "$(dirname "$FT")"; do
  for name in holdr.conf kit-runtime.txt; do
    if [ -e "$dir/$name" ] || [ -L "$dir/$name" ]; then
      echo "holdr-stop: $dir holds $name: a staging tree or a rollback kit, not the live deployment; nothing stopped." >&2
      exit 2
    fi
  done
done
BRIDGE=$(cd "$BRIDGE" 2>/dev/null && pwd -P) || BRIDGE=""
LOGDIR="${HOLDR_LOG_DIR:-$HOME/holdr-logs}"
API_PORT="${HOLDR_API_PORT:-4000}"
WEB_PORT="${HOLDR_WEB_PORT:-8888}"
BRIDGE_PORT="${HOLDR_BRIDGE_PORT:-3003}"
for port in "$API_PORT" "$WEB_PORT" "$BRIDGE_PORT"; do
  case "$port" in ''|*[!0-9]*) echo "holdr-stop: invalid service port: $port" >&2; exit 1 ;; esac
  [ "$port" -gt 0 ] && [ "$port" -le 65535 ] || { echo "holdr-stop: invalid service port: $port" >&2; exit 1; }
done

# The Tailscale CLI for the guard: holdr.conf's HOLDR_TAILSCALE_CLI (a private file of this user), else HOLDR_TAILSCALE or
# `tailscale` in the fixed PATH. No CLI at all is not evidence that the daemon stopped serving: the guard is then `unknown`.
conf_file="${HOLDR_CONFIG:-$HOME/Library/Application Support/Holdr/holdr.conf}"
tailscale_cli=""
if [ "$conf_file" != none ] && [ -e "$conf_file" ]; then
  if [ -L "$conf_file" ] || [ ! -f "$conf_file" ]; then echo "holdr-stop: E0I_CONFIG_FILE ($conf_file is not a regular file)" >&2; exit 1; fi
  read -r conf_owner conf_mode < <(stat -f '%u %Lp' "$conf_file")
  if [ "$conf_owner" != "$(id -u)" ] || [ $(( 8#$conf_mode & 8#022 )) -ne 0 ]; then
    echo "holdr-stop: E0I_CONFIG_FILE ($conf_file must be owned by $(id -un) and not writable by others)" >&2; exit 1
  fi
  cli_lines=$(grep -c '^HOLDR_TAILSCALE_CLI=' "$conf_file" || true)
  if [ "$cli_lines" -gt 1 ]; then echo "holdr-stop: E0I_CONFIG_FILE (HOLDR_TAILSCALE_CLI repeated)" >&2; exit 1; fi
  if [ "$cli_lines" = 1 ]; then
    tailscale_cli=$(sed -n 's/^HOLDR_TAILSCALE_CLI=//p' "$conf_file")
    case "$tailscale_cli" in /*) ;; *) echo "holdr-stop: E0I_CONFIG_FILE (HOLDR_TAILSCALE_CLI is not absolute)" >&2; exit 1 ;; esac
  fi
fi
if [ -z "$tailscale_cli" ]; then tailscale_cli=$(command -v "${HOLDR_TAILSCALE:-tailscale}" 2>/dev/null || true); fi

owns_process() {
  local service="$1" process_id="$2" directory command
  [ "$(ps -p "$process_id" -o user= | xargs)" = "$(id -un)" ] || return 1
  directory=$(lsof -a -p "$process_id" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  command=$(ps -p "$process_id" -o command=)
  case "$service" in
    api) [ "$directory" = "$FT/apps/api" ] || return 1
      case "$command" in *"$FT/node_modules/"*"src/index.ts"*) return 0 ;; esac ;;
    web) [ "$directory" = "$FT/apps/web" ] || return 1
      case "$command" in *"$FT/node_modules/"*"vite"*) return 0 ;; esac ;;
    bridge) [ -n "$BRIDGE" ] && [ "$directory" = "$BRIDGE" ] || return 1
      case "$command" in *"server.py"*) return 0 ;; esac ;;
    # The LAN gateway was removed; one an older version started outlives the upgrade, so it is still recognised and stopped.
    lan) [ "$directory" = "$FT/apps/api" ] || return 1
      case "$command" in "$NODE "*"$FT/apps/api/src/cli/lanGatewayMain.ts --serve") return 0 ;; esac ;;
  esac
  return 1
}
# Any Holdr service may listen on the web port: Vite, or the API in break-glass mode (127.0.0.1:8888).
owner_of() {
  local process_id="$1" service
  for service in api web bridge lan; do
    if owns_process "$service" "$process_id"; then echo "$service"; return 0; fi
  done
  return 1
}

targets=""
web_listener=0
for entry in "api:$API_PORT" "web:$WEB_PORT" "bridge:$BRIDGE_PORT" "lan:0"; do
  service=${entry%%:*}
  port=${entry#*:}
  listeners=""
  if [ "$port" != 0 ]; then listeners=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); fi
  for process_id in $listeners; do
    owner=$(owner_of "$process_id") || { echo "holdr-stop: port $port belongs to a non-Holdr process ($process_id); nothing stopped." >&2; exit 1; }
    if [ "$service" = web ]; then web_listener=1; fi
    case " $targets " in *" $owner:$process_id "*) ;; *) targets="$targets $owner:$process_id" ;; esac
  done
  if [ -f "$LOGDIR/$service.pid" ]; then
    saved_pid=$(cat "$LOGDIR/$service.pid")
    case "$saved_pid" in
      ''|*[!0-9]*) echo "holdr-stop: invalid PID file $LOGDIR/$service.pid; nothing stopped." >&2; exit 1 ;;
    esac
    if kill -0 "$saved_pid" 2>/dev/null && owner=$(owner_of "$saved_pid"); then
      case " $targets " in *" $owner:$saved_pid "*) ;; *) targets="$targets $owner:$saved_pid" ;; esac
    fi
  fi
done

# TCP-owner guard (§8.3; B-D27 as revised after the B2 review): a listener on the web port is stopped only after a successful
# read of a configuration in Serve's known schema shows that nothing targets the port. A missing CLI, a failed or unreadable
# read and anything unrecognised keep it.
if [ "$web_listener" = 1 ]; then
  if [ -z "$tailscale_cli" ]; then
    echo "holdr-stop: E0I_SERVE_UNKNOWN (no Tailscale CLI: holdr.conf names none and \`tailscale\` is not on PATH, so Serve could still target port $WEB_PORT; its owner is kept); nothing stopped." >&2
    exit 1
  fi
  guard=$("$SELF/node_modules/.bin/tsx" "$SELF/scripts/lib/serve-verdict.ts" --cli "$tailscale_cli" --port-guard "$WEB_PORT" 2>/dev/null || echo unknown)
  case "$guard" in
    clear) ;;
    targeted)
      echo "holdr-stop: E0I_SERVE_TARGETS_WEB (Tailscale Serve still targets port $WEB_PORT; move Serve first, e.g. tailscale serve --https=443 off); nothing stopped." >&2
      exit 1 ;;
    *)
      echo "holdr-stop: E0I_SERVE_UNKNOWN (the Tailscale Serve configuration could not be read or is not one this guard recognises; the web port's owner is kept); nothing stopped." >&2
      exit 1 ;;
  esac
fi

if [ -z "$targets" ]; then echo "holdr-stop $VERSION: nothing to stop"; exit 0; fi
for target in $targets; do
  service=${target%%:*}
  process_id=${target#*:}
  if kill -0 "$process_id" 2>/dev/null && owns_process "$service" "$process_id"; then kill -TERM "$process_id" 2>/dev/null || true; fi
done
deadline=$(( $(date +%s) + 10 ))
while :; do
  alive=""
  for target in $targets; do
    process_id=${target#*:}
    if kill -0 "$process_id" 2>/dev/null; then alive="$alive $process_id"; fi
  done
  listening=$(lsof -nP -t -a -iTCP:"$API_PORT" -iTCP:"$WEB_PORT" -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN 2>/dev/null || true)
  [ -z "$alive" ] && [ -z "$listening" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "holdr-stop: Holdr did not stop within 10 seconds (still running:${alive:- none}; listening: ${listening:-none})." >&2
    exit 1
  fi
  sleep 0.2
done
echo "holdr-stop $VERSION: stopped$targets"
