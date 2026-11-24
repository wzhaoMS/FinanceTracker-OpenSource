#!/usr/bin/env bash
# Holdr's start script (design §8.1–§8.3, §8.5). Modes come from holdr.conf (or the environment), read with the same strict
# rules as the API and every CLI (K26):
#   dist  - production: the verified release and the API behind Tailscale Serve on a Unix socket; no Vite.
#   local - break-glass: the verified release on http://127.0.0.1:<web port>, never verified ingress.
#   vite  - login's flow (development; on a Mac host only the guarded legacy rollback until AL1 sign-off).
# Actions: no argument (start or restart), --preflight (read-only checks, nothing changes), --stop (the stop role).
set -euo pipefail
umask 077

# The service installation may pin Node with HOLDR_NODE. Otherwise use the
# executable installed on PATH, then resolve it to one canonical absolute path.
NODE="${HOLDR_NODE:-$(command -v node || true)}"
case "$NODE" in /*) ;; *) echo "Node was not found; set HOLDR_NODE to an absolute executable path." >&2; exit 1 ;; esac
[ -x "$NODE" ] || { echo "HOLDR_NODE is not executable: $NODE" >&2; exit 1; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
LOCKF=/usr/bin/lockf
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Step 1: the action is parsed before the lock and again under it; the lockf re-exec keeps the arguments.
usage() { echo "Usage: start-finance-mac.sh [--preflight | --stop]" >&2; exit 2; }
parse_action() {
  case "$#:${1:-}" in
    0:) echo start ;;
    1:--preflight) echo preflight ;;
    1:--stop) echo stop ;;
    *) return 1 ;;
  esac
}
locked=0
if [ "${1:-}" = "--holdr-start-locked" ]; then locked=1; shift; fi
action=$(parse_action "$@") || usage

# HOLDR_ROOT names the managed live deployment (the parent of its FinanceTracker), and only that. A staged candidate (§11.2
# step 6) is HOLDR_CANDIDATE: its code runs the read-only preflight, which still judges a running API by the live tree
# (B1 and B2 round-2 finding 2). A tree next to a holdr.conf or kit-runtime.txt (an entry of any type, a dangling link
# included), by HOLDR_ROOT or by its physical parent, is a staging tree or a rollback kit (B-D44; the API's managedLive).
non_live_entry() {
  local name
  for name in holdr.conf kit-runtime.txt; do
    if [ -e "$1/$name" ] || [ -L "$1/$name" ]; then echo "$name"; return 0; fi
  done
  return 1
}
ROOT="${HOLDR_ROOT:-$HOME/Holdr}"
FT="$ROOT/FinanceTracker"
if entry=$(non_live_entry "$ROOT"); then
  echo "HOLDR_ROOT ($ROOT) is a staging tree or a rollback kit, not the live deployment ($entry beside its FinanceTracker). For a staged preflight leave HOLDR_ROOT unset and set HOLDR_CANDIDATE=<staging>/FinanceTracker." >&2
  exit 2
fi
CANDIDATE="${HOLDR_CANDIDATE:-}"
if [ -n "$CANDIDATE" ]; then
  [ "$action" = preflight ] || { echo "HOLDR_CANDIDATE is only for --preflight: this script never starts or stops a candidate." >&2; exit 2; }
  case "$CANDIDATE" in /*) ;; *) echo "HOLDR_CANDIDATE must be an absolute path." >&2; exit 2 ;; esac
fi
BRIDGE_RUNTIME="${HOLDR_BRIDGE_RUNTIME:-$HOME/Library/Application Support/Holdr}"
if [ -f "$BRIDGE_RUNTIME/portfolio-bridge/server.py" ]; then
  BRIDGE="$BRIDGE_RUNTIME/portfolio-bridge"
  PY="$BRIDGE_RUNTIME/.venv313/bin/python"
else
  BRIDGE="$ROOT/apps/portfolio-bridge"
  PY="$ROOT/.venv313/bin/python"
fi
FT=$(cd "$FT" && pwd -P)
if entry=$(non_live_entry "$(dirname "$FT")"); then
  echo "The live tree $FT sits beside $entry: a staging tree or a rollback kit, not the live deployment." >&2
  exit 2
fi
if [ -n "$CANDIDATE" ]; then
  LIVE_FT="$FT"
  FT=$(cd "$CANDIDATE" 2>/dev/null && pwd -P) || { echo "HOLDR_CANDIDATE: no tree at $CANDIDATE." >&2; exit 2; }
  case "$FT/" in "$LIVE_FT/"*) echo "HOLDR_CANDIDATE ($FT) is the live tree or inside it." >&2; exit 2 ;; esac
  case "$LIVE_FT/" in "$FT/"*) echo "HOLDR_CANDIDATE ($FT) contains the live tree." >&2; exit 2 ;; esac
fi
LOGDIR="${HOLDR_LOG_DIR:-$HOME/holdr-logs}"
API_PORT="${HOLDR_API_PORT:-4000}"
WEB_PORT="${HOLDR_WEB_PORT:-8888}"
BRIDGE_PORT="${HOLDR_BRIDGE_PORT:-3003}"
for port in "$API_PORT" "$WEB_PORT" "$BRIDGE_PORT"; do
  case "$port" in ''|*[!0-9]*) echo "Invalid service port: $port" >&2; exit 1 ;; esac
  [ "$port" -gt 0 ] && [ "$port" -le 65535 ] || exit 1
done
[ "$API_PORT" != "$WEB_PORT" ] && [ "$API_PORT" != "$BRIDGE_PORT" ] && [ "$WEB_PORT" != "$BRIDGE_PORT" ] || exit 1
# Other devices reach Holdr over HTTPS through Tailscale Serve only. The LAN modes, plain HTTP to the network
# (HOLDR_LAN_HTTP=1) and the LAN HTTPS gateway (HOLDR_LAN_HTTPS_*, refused by start-config below), were removed: a setting
# that asks for one stops a start or preflight instead of being ignored. The stop role still runs, to stop an old stack.
if [ "$action" != stop ]; then
  case "${HOLDR_LAN_HTTP:-0}" in
    0) ;;
    *) echo "E0I_LAN_REMOVED: HOLDR_LAN_HTTP is no longer supported: Holdr's LAN modes were removed. Unset HOLDR_LAN_HTTP; other devices reach Holdr over HTTPS through Tailscale Serve (docs/deployment.md). Nothing was changed." >&2
       exit 1 ;;
  esac
fi
ATTEST_WAIT="${HOLDR_ATTEST_WAIT:-30}"
case "$ATTEST_WAIT" in ''|*[!0-9]*|????*) echo "Invalid HOLDR_ATTEST_WAIT: $ATTEST_WAIT" >&2; exit 1 ;; esac
mkdir -p "$LOGDIR"
LOCKFILE="$LOGDIR/start.lockfile"
if [ "$locked" = 0 ]; then
  exec "$LOCKF" -t 0 -k "$LOCKFILE" /bin/bash "$0" --holdr-start-locked "$@"
fi
# Under the lock (B2 review 2): --holdr-start-locked is accepted only while the start lock is really held for this process.
# The lock file is locked now (a non-blocking exclusive flock fails; lockf's O_EXLOCK is the same lock), this script's parent
# (the lockf above) has it open, and no process other than the parent (and this shell, should it have inherited the
# descriptor) has. A parent's command line proves nothing.
lock_held_by_parent() {
  local holders pid parent=0
  [ -f "$LOCKFILE" ] && [ ! -L "$LOCKFILE" ] || return 1
  /usr/bin/perl -e 'use Fcntl qw(:flock O_RDONLY); sysopen(my $f, $ARGV[0], O_RDONLY) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)' \
    "$LOCKFILE" || return 1
  holders=$(lsof -t -- "$LOCKFILE" 2>/dev/null | sort -u | xargs) || return 1
  for pid in $holders; do
    if [ "$pid" = "$PPID" ]; then parent=1; elif [ "$pid" != "$$" ]; then return 1; fi
  done
  [ "$parent" = 1 ]
}
if ! lock_held_by_parent; then
  echo "--holdr-start-locked is internal to the start script (the start lock is not held by this script's lockf parent)" >&2
  exit 2
fi

# Step 2: --stop is the stop role and nothing else: no holdr.conf release or mode settings, no preflight, no marker.
if [ "$action" = stop ]; then
  exec /bin/bash "$FT/scripts/holdr-stop.sh" --root "$ROOT"
fi

test -x "$FT/node_modules/.bin/tsx"
TSX="$FT/node_modules/.bin/tsx"

# Step 3 and 4: holdr.conf and the environment (K26, K5, K1–K10 for the mode), the release dir, and the lifecycle marker.
cfg_end=""
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  case "$key" in
    mode) cfg_mode=$value ;; config) cfg_config=$value ;; origin) cfg_origin=$value ;; digest) cfg_digest=$value ;;
    releaseDir) cfg_release_dir=$value ;; dataDir) cfg_data_dir=$value ;; controlDir) cfg_control_dir=$value ;;
    socket) cfg_socket=$value ;; cli) cfg_cli=$value ;; deviceApi) cfg_device_api=$value ;; ingressPort) cfg_ingress_port=$value ;;
    legacy) cfg_legacy=$value ;; marker) cfg_marker=$value ;; distOrigin) cfg_dist_origin=$value ;; distSocket) cfg_dist_socket=$value ;;
    nativeCommit) cfg_native_commit=$value ;; nativeManifest) cfg_native_manifest=$value ;; end) cfg_end=$value ;;
  esac
done < <("$TSX" "$FT/scripts/lib/start-config.ts" --root "$FT" --web-port "$WEB_PORT" --api-port "$API_PORT" || true)
if [ "$cfg_end" != ok ]; then
  echo "Holdr configuration refused (see above); nothing was changed." >&2
  exit 1
fi
case "$cfg_marker" in
  none|normal) ;;
  *) echo "E0I_MAINTENANCE: the lifecycle marker is not normal ($cfg_marker); Holdr does not start during maintenance." >&2
     echo "Run 'npm run holdr-lifecycle -- status' in $FT for details. Nothing was changed." >&2
     exit 1 ;;
esac
MODE="$cfg_mode"
if [ "$MODE" = local ]; then WEB_PORT="$cfg_ingress_port"; fi
# The bridge's prerequisites before anything changes (B2 review 3): a start that cannot finish never disturbs the old stack.
if [ "$MODE" != vite ] && { [ ! -x "$PY" ] || [ ! -f "$BRIDGE/server.py" ]; }; then
  echo "The portfolio bridge cannot start ($PY must be executable and $BRIDGE/server.py must exist); nothing was changed." >&2
  exit 1
fi

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
    bridge) [ "$directory" = "$BRIDGE" ] || return 1
      case "$command" in *"server.py"*) return 0 ;; esac ;;
    # The LAN gateway was removed; one an older version started outlives the upgrade, so it is still recognised and stopped.
    lan) [ "$directory" = "$FT/apps/api" ] || return 1
      case "$command" in "$NODE "*"$FT/apps/api/src/cli/lanGatewayMain.ts --serve") return 0 ;; esac ;;
  esac
  return 1
}
# Whether a Holdr process (Vite, or the API in break-glass) listens on the web port: the TCP-owner guard's subject.
holdr_web_listener() {
  local process_id service
  for process_id in $(lsof -nP -t -iTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    for service in web api; do
      if owns_process "$service" "$process_id"; then return 0; fi
    done
  done
  return 1
}

# Step 5: Tailscale (bounded wait, exact MagicDNS machine name). In dist/local the CLI is holdr.conf's.
if [ "$MODE" = vite ]; then tailscale_cli="${HOLDR_TAILSCALE:-tailscale}"; else tailscale_cli="${cfg_cli:-}"; fi
tailscale_wait="${HOLDR_TAILSCALE_WAIT:-60}"
case "$tailscale_wait" in ''|*[!0-9]*|????*) echo "Invalid HOLDR_TAILSCALE_WAIT: $tailscale_wait" >&2; exit 1 ;; esac
tailscale_snapshot() {
  "$NODE" --input-type=module - "$tailscale_cli" "$tailscale_wait" <<'JS'
import { execFile } from 'node:child_process';
const [cli, wait] = process.argv.slice(2);
const deadline = Date.now() + Number(wait) * 1000;
// Hard upper bound even if a killed CLI never exits.
setTimeout(() => process.exit(1), Number(wait) * 1000 + 15_000).unref();
const run = (...args) => new Promise((resolve) => {
  execFile(cli, args, { timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 8 << 20 },
    (error, stdout) => resolve(error ? null : stdout));
});
let addresses = await run('ip');
if (addresses === null && Date.now() < deadline) {
  console.error(`Waiting up to ${wait}s for Tailscale (tailscale ip)...`);
  while (addresses === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, deadline - Date.now())));
    addresses = await run('ip');
  }
}
if (addresses === null) {
  process.exitCode = 1;
} else {
  // Exact MagicDNS machine name only: Vite treats a leading dot as a wildcard.
  let hostname = '';
  try { hostname = String(JSON.parse(await run('status', '--json')).Self.DNSName).toLowerCase().replace(/\.$/, ''); } catch {}
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/.test(hostname)) hostname = '';
  process.stdout.write(`${addresses.replaceAll('\n', ',')}\n${hostname}\n`);
}
JS
}
tailnet=''
if [ -n "$tailscale_cli" ] && command -v "$tailscale_cli" >/dev/null 2>&1; then
  tailnet=$(tailscale_snapshot) || {
    tailnet=''
    echo "Tailscale was not ready within ${tailscale_wait}s; starting without tailnet access. Re-run this script once Tailscale is up." >&2
  }
fi
tailnet_addresses=$(printf '%s\n' "$tailnet" | sed -n 1p)
tailnet_hostname=$(printf '%s\n' "$tailnet" | sed -n 2p)

# The clean environment of §8.2 step 9, also used by the read-only preflight (step 6) and the serve probe (step 11).
api_env=()
if [ "$MODE" != vite ]; then
  api_env=(PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" LANG=en_US.UTF-8 TMPDIR="${TMPDIR:-}"
    NODE_ENV=production PORT="$API_PORT" HOLDR_HOST=127.0.0.1 HOLDR_WEB_MODE="$MODE"
    HOLDR_WEB_RELEASE_DIR="$cfg_release_dir" HOLDR_WEB_RELEASE_DIGEST="$cfg_digest" HOLDR_DATA_DIR="$cfg_data_dir"
    HOLDR_CONTROL_DIR="$cfg_control_dir" HOLDR_DEVICE_API="$cfg_device_api"
    BROKER_BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT" SNAPSHOTS_ENABLED=1)
  if [ "$cfg_config" != none ]; then api_env+=(HOLDR_CONFIG="$cfg_config"); fi
  if [ "$MODE" = dist ]; then
    api_env+=(HOLDR_SERVE_SOCKET="$cfg_socket" HOLDR_PUBLIC_ORIGIN="$cfg_origin" WEB_ORIGIN="$cfg_origin" HOLDR_TAILSCALE_CLI="$cfg_cli")
  else
    api_env+=(HOLDR_INGRESS_PORT="$cfg_ingress_port")
    if [ -n "$cfg_cli" ]; then api_env+=(HOLDR_TAILSCALE_CLI="$cfg_cli"); fi
  fi
  if [ -n "$cfg_native_commit" ]; then api_env+=(HOLDR_NATIVE_COMMIT="$cfg_native_commit"); fi
  if [ -n "$cfg_native_manifest" ]; then api_env+=(HOLDR_NATIVE_MANIFEST="$cfg_native_manifest"); fi
  for name in SNAPSHOT_INTERVAL_MS INDICATIVE_ENABLED EXTENDED_HOURS_ENABLED HL_DEX QLIB_THESIS_URL; do
    if [ -n "${!name+x}" ]; then api_env+=("$name=${!name}"); fi
  done
fi

if [ "$MODE" = dist ]; then
  public_host=${cfg_origin#https://}
  # K27: when Tailscale answers, its MagicDNS name must be the pinned origin's host.
  if [ -n "$tailnet_hostname" ] && [ "$tailnet_hostname" != "$public_host" ]; then
    echo "E0I_PUBLIC_ORIGIN_MISMATCH: Tailscale's MagicDNS name is $tailnet_hostname, holdr.conf pins $cfg_origin; nothing was changed." >&2
    exit 1
  fi
fi

# Step 6: the read-only preflight (shared lease, marker normal, every check of §7.2, the Serve validator). Nothing has changed yet.
preflight_line=""
run_preflight() {
  local output status
  if [ "$MODE" = vite ]; then
    local vite_env=(PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" LANG=en_US.UTF-8 TMPDIR="${TMPDIR:-}")
    if [ "$cfg_config" != none ]; then vite_env+=(HOLDR_CONFIG="$cfg_config"); fi
    output=$(cd "$FT" && env -i "${vite_env[@]}" "$TSX" "$FT/apps/api/src/cli/ingressMain.ts" preflight --web-port "$WEB_PORT") && status=0 || status=$?
  else
    # HOLDR_ROOT names the managed live tree whose running API may own the socket (B1 review 4), also when the code here is a
    # staged candidate (HOLDR_CANDIDATE); the API never gets it.
    output=$(cd "$FT" && env -i "${api_env[@]}" HOLDR_ROOT="$ROOT" "$TSX" "$FT/apps/api/src/cli/ingressMain.ts" preflight --web-port "$WEB_PORT") && status=0 || status=$?
  fi
  preflight_line=$(printf '%s\n' "$output" | grep '^PREFLIGHT ' | tail -n 1 || true)
  [ -n "$preflight_line" ] && echo "$preflight_line"
  return "$status"
}
if [ "$action" = preflight ] || [ "$MODE" != vite ]; then
  if ! run_preflight; then
    echo "Preflight refused; nothing was changed." >&2
    exit 1
  fi
  case "$preflight_line" in "PREFLIGHT ok "*) ;; *) echo "Preflight gave no verdict; nothing was changed." >&2; exit 1 ;; esac
  if [ "$action" = preflight ]; then exit 0; fi
fi
serve_verdict=$(printf '%s\n' "$preflight_line" | sed -n 's/.* serve=\([a-z-]*\).*/\1/p')

# One bounded read of Serve, judged by A2's validator: empty, approved-dist, approved-vite, refused or error (unknown).
serve_verdict_now() {
  "$TSX" "$FT/scripts/lib/serve-verdict.ts" --cli "$cfg_cli" --host "${cfg_origin#https://}" --socket "$cfg_socket" \
    --web-port "$WEB_PORT" --api-port "$API_PORT" --bridge-port "$BRIDGE_PORT" 2>/dev/null | awk '{print $1}' || echo error
}
# Every change to Serve is bounded (B-D33, B2 review 4): a hanging CLI never holds the start lock; the state after it is read.
serve_change() { "$NODE" "$FT/scripts/lib/bounded-cli.mjs" 20 "$cfg_cli" "$@"; }
describe_serve() {
  case "$1" in
    approved-dist) echo "on the socket target unix:$cfg_socket" ;;
    approved-vite) echo "on the TCP target http://127.0.0.1:$WEB_PORT" ;;
    empty) echo "empty" ;;
    refused) echo "a configuration this script does not manage" ;;
    *) echo "unknown (it could not be read)" ;;
  esac
}

# Step 7 (dist): Serve is switched to the socket before anything stops; the TCP-owner guard keeps a targeted web port's owner.
# A switch that did not reach the socket target never lets the start go on, and the state reported is always one a read
# confirmed (B2 review 8). §8.2's exception (the `error` verdict below): when Serve cannot be read at all and nothing owns the
# web port, the API starts unverified and admits nothing until it verifies by itself.
serve_switched=0
if [ "$MODE" = dist ]; then
  case "$serve_verdict" in
    approved-dist) echo "Tailscale Serve: $cfg_origin -> unix:$cfg_socket" ;;
    empty|approved-vite)
      serve_change serve --bg --https=443 "unix:$cfg_socket" >/dev/null 2>&1 || echo "The Serve switch command failed or timed out (step 7)." >&2
      serve_switched=1
      serve_state=$(serve_verdict_now)
      if [ "$serve_state" = approved-dist ]; then
        echo "Tailscale Serve: $cfg_origin -> unix:$cfg_socket (switched before stopping anything)"
      elif holdr_web_listener; then
        echo "E0I_SERVE_SWITCH_FAILED: Tailscale Serve did not switch to the socket (it is $(describe_serve "$serve_state")); the running stack is kept and nothing was stopped." >&2
        exit 1
      else
        # Nothing owns the web port, so a TCP target left there would be anyone's (§8.3): Serve is turned off, and only a
        # confirmed result is reported. The start does not go on without the socket target (§8.2 step 7).
        if [ "$serve_state" != empty ]; then
          serve_change serve --https=443 off >/dev/null 2>&1 || echo "Turning Tailscale Serve off failed or timed out." >&2
          serve_state=$(serve_verdict_now)
        fi
        if [ "$serve_state" = empty ]; then
          echo "E0I_SERVE_SWITCH_FAILED: Tailscale Serve did not switch to the socket; nothing owned port $WEB_PORT, so Serve is now empty (confirmed). Nothing else was changed." >&2
        else
          echo "E0I_SERVE_SWITCH_FAILED: Tailscale Serve did not switch to the socket and is $(describe_serve "$serve_state"), while nothing owns port $WEB_PORT. Turn it off now: $cfg_cli serve --https=443 off" >&2
        fi
        exit 1
      fi ;;
    error)
      if holdr_web_listener; then
        echo "E0I_SERVE_UNKNOWN: the Tailscale Serve configuration could not be read; the running stack is kept and nothing was stopped." >&2
        exit 1
      fi
      echo "The Tailscale Serve configuration could not be read; the API starts unverified until Tailscale answers." >&2 ;;
    *) echo "E0I_SERVE: unexpected Serve verdict '$serve_verdict'; nothing was changed." >&2; exit 1 ;;
  esac
fi

run_service() {
  if [ "${HOLDR_LAUNCHD:-0}" = "1" ]; then exec "$@"; fi
  exec nohup "$@"
}
rotate_logs() {
  local service
  for service in "$@"; do
    if [ -f "$LOGDIR/$service.log" ]; then mv -f "$LOGDIR/$service.log" "$LOGDIR/$service.previous.log"; fi
  done
}
launched_pids=""
start_bridge() {
  test -x "$PY"
  test -f "$BRIDGE/server.py"
  cd "$BRIDGE"
  run_service env PORTFOLIO_BRIDGE_HOST=127.0.0.1 PORTFOLIO_BRIDGE_PORT="$BRIDGE_PORT" \
    "$PY" server.py \
    < /dev/null > "$LOGDIR/bridge.log" 2>&1 &
  launched_pids="$launched_pids $!"
  echo $! > "$LOGDIR/bridge.pid"
}
check_health() {
  local endpoint service failed=0
  for endpoint in "$@"; do
    service=${endpoint%%:*}
    if curl -fsS --connect-timeout 1 --max-time 3 --retry 6 --retry-connrefused --retry-delay 1 --retry-max-time 20 \
      "http://127.0.0.1:${endpoint#*:}" >/dev/null && kill -0 "$(cat "$LOGDIR/$service.pid")" 2>/dev/null; then
      echo "$service ok"
    else
      echo "$service failed; see $LOGDIR/$service.log" >&2
      failed=1
    fi
  done
  return "$failed"
}

if [ "$MODE" != vite ]; then
  # Step 8: the stop role, with the TCP-owner guard (it re-reads Serve before stopping a web-port listener).
  if ! /bin/bash "$FT/scripts/holdr-stop.sh" --root "$ROOT"; then
    echo "The old services were not stopped; nothing new was started." >&2
    exit 1
  fi

  # Step 12, installed before anything is launched (B2 reviews 3, 4 and 8): any failure from the first launch on, expected or
  # not (a shell error, a signal), stops what this script started, turns a fresh Serve off again, and reports the Serve state
  # a read confirmed. It never publishes a TCP target.
  launched=0
  cleaning=0
  # This script's own background jobs first (a service may not be listening, or have its PID file, yet), then the stop role.
  stop_launched() {
    local pid running="" waited=0
    for pid in $launched_pids; do
      if jobs -p | grep -qx "$pid"; then kill -TERM "$pid" 2>/dev/null || true; running="$running $pid"; fi
    done
    while [ -n "$running" ] && [ "$waited" -lt 50 ]; do
      sleep 0.2
      waited=$((waited + 1))
      local still=""
      for pid in $running; do if kill -0 "$pid" 2>/dev/null; then still="$still $pid"; fi; done
      running="$still"
    done
  }
  cleanup_after_failure() {
    local after
    cleaning=1
    echo "$1" >&2
    stop_launched
    /bin/bash "$FT/scripts/holdr-stop.sh" --root "$ROOT" >&2 || echo "Stopping the new services failed; check $LOGDIR." >&2
    if [ "$MODE" = dist ]; then
      if [ "$serve_verdict" = empty ] && [ "$serve_switched" = 1 ]; then
        serve_change serve --https=443 off >/dev/null 2>&1 || echo "Turning Tailscale Serve off failed or timed out." >&2
      fi
      after=$(serve_verdict_now)
      case "$after" in
        approved-dist) echo "Tailscale Serve stays on the socket target (it answers 502 while Holdr is stopped; confirmed)." >&2 ;;
        empty) echo "Tailscale Serve is empty (confirmed)." >&2 ;;
        *) echo "Tailscale Serve is $(describe_serve "$after"); check it: $cfg_cli serve status --json" >&2 ;;
      esac
      if [ "$serve_verdict" = approved-vite ]; then
        echo "This script never re-publishes a TCP target; for the legacy Vite rollback (before AL1 only) run:" >&2
        echo "npm run holdr-ingress -- set-mode vite --legacy-rollback, then this script." >&2
      fi
    fi
  }
  fail_after_start() {
    cleanup_after_failure "$1"
    exit 1
  }
  on_exit() {
    local status=$?
    if [ "$launched" = 1 ] && [ "$cleaning" = 0 ] && [ "$status" -ne 0 ]; then
      cleanup_after_failure "The start failed unexpectedly (exit $status) after launching services; stopping them."
    fi
  }
  trap on_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Step 9: the API with the clean environment; no Vite; the bridge as before.
  rotate_logs api web bridge
  launched=1
  cd "$FT/apps/api"
  run_service env -i "${api_env[@]}" "$TSX" src/index.ts < /dev/null > "$LOGDIR/api.log" 2>&1 &
  launched_pids="$launched_pids $!"
  echo $! > "$LOGDIR/api.pid"
  start_bridge

  # Step 10: local health, then (dist) attestation `verified` within the wait.
  if ! check_health "api:$API_PORT/health" "bridge:$BRIDGE_PORT/health"; then fail_after_start "Health checks failed (step 10)."; fi
  if [ "$MODE" = local ]; then
    echo "BREAK-GLASS: local only, ingress not verified"
    echo "Holdr on this Mac: http://127.0.0.1:$WEB_PORT (break-glass; other devices get no Holdr until dist is restored)"
    exit 0
  fi
  state_file="$(dirname "$cfg_socket")/ingress-state.json"
  attestation=$("$NODE" --input-type=module - "$state_file" "$ATTEST_WAIT" <<'JS'
import fs from 'node:fs';
const [file, wait] = process.argv.slice(2);
const deadline = Date.now() + Number(wait) * 1000;
let last = 'none';
for (;;) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    last = `${state.name}${Array.isArray(state.codes) && state.codes.length ? ` (${state.codes.join(',')})` : ''}`;
    if (state.name === 'verified' && state.verified === true) { console.log('verified'); process.exit(0); }
  } catch { /* not written yet */ }
  if (Date.now() >= deadline) { console.log(last); process.exit(1); }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
JS
) && attested=1 || attested=0
  if [ "$attested" = 1 ]; then
    echo "attestation verified"
  elif [ "${HOLDR_LAUNCHD:-0}" = "1" ]; then
    echo "WARNING: attestation is $attestation after ${ATTEST_WAIT}s; at boot Tailscale may still be starting. The API stays running and admits nothing until it verifies by itself." >&2
    echo "Holdr: $cfg_origin (once attestation verifies)"
    exit 0
  else
    fail_after_start "Attestation did not reach verified within ${ATTEST_WAIT}s (last: $attestation)."
  fi

  # Step 11: end to end through the real HTTPS name, from this Mac.
  if (cd "$FT" && env -i "${api_env[@]}" "$TSX" "$FT/apps/api/src/cli/ingressMain.ts" serve-probe --origin "$cfg_origin" \
      --token-file "$cfg_data_dir/service-token" --release-dir "$cfg_release_dir"); then
    echo "serve-probe ok"
  else
    fail_after_start "The end-to-end probe through $cfg_origin failed (step 11)."
  fi
  # Step 13.
  echo "Holdr: $cfg_origin"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------- vite
# Login's flow, plus the argument-preserving lock, the stop role, the marker and the guarded publication of §8.3.
test -x "$FT/node_modules/.bin/vite"
test -x "$PY"
test -f "$BRIDGE/server.py"
BRIDGE=$(cd "$BRIDGE" && pwd -P)

# The origin other devices use: https://<machine>.<tailnet>.ts.net, which Tailscale
# Serve terminates and forwards to the loopback-only web server.
public_origin="${cfg_origin:-}"
if [ -z "$public_origin" ] && [ -n "$tailnet_hostname" ]; then public_origin="https://$tailnet_hostname"; fi
serve_command="tailscale serve --bg --https=443 http://127.0.0.1:$WEB_PORT"

# Points https://<MagicDNS name> at the web port unless port 443 already serves something else (the dist socket target is
# replaced only after this script's own Vite was verified). Idempotent: Serve keeps its configuration across reboots (--bg).
# Succeeds only when Serve forwards to Holdr afterwards.
tailscale_serve() {
  "$NODE" --input-type=module - "$tailscale_cli" "$tailnet_hostname" "$WEB_PORT" "${cfg_dist_socket:-}" "$1" <<'JS'
import { execFile } from 'node:child_process';
const [cli, hostname, port, distSocket, verified] = process.argv.slice(2);
const target = `http://127.0.0.1:${port}`;
const site = `${hostname}:443`;
const command = `${/\s/.test(cli) ? JSON.stringify(cli) : cli} serve --bg --https=443 ${target}`;
const help = [
  'Run once on this Mac after enabling MagicDNS and HTTPS certificates (Tailscale admin console > DNS):',
  `  ${command}`,
  'If it answers "Access denied", run it with sudo or allow your user first: sudo tailscale set --operator=$USER',
].join('\n');
// Hard upper bound even if a killed CLI never exits.
setTimeout(() => {
  console.error(`Tailscale Serve setup timed out.\n${help}`);
  process.exit(1);
}, 45_000).unref();
const run = (args, timeout) => new Promise((resolve) => {
  execFile(cli, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 8 << 20 }, (error, stdout, stderr) => resolve({
    ok: !error,
    stdout: String(stdout ?? ''),
    detail: `${stdout ?? ''}${stderr ?? ''}`.trim() || (error ? error.message : ''),
  }));
});
const readConfig = async () => {
  const result = await run(['serve', 'status', '--json'], 5_000);
  if (!result.ok) return { error: result.detail };
  try {
    return { config: JSON.parse(result.stdout.trim() || 'null') ?? {} };
  } catch {
    return { error: 'unreadable `tailscale serve status --json` output' };
  }
};
const owner = (config) => {
  const handlers = config.Web?.[site]?.Handlers;
  const tcp = config.TCP?.['443'];
  if (!handlers && !tcp) return 'nobody';
  const proxy = String(handlers?.['/']?.Proxy ?? '').replace(/\/+$/, '');
  const onlyRoot = Object.keys(handlers ?? {}).join() === '/';
  const sites = Object.keys(config.Web ?? {});
  const tcpPorts = Object.keys(config.TCP ?? {});
  if (tcp?.HTTPS && !tcp.TCPForward && onlyRoot && [target, `http://localhost:${port}`].includes(proxy)) return 'holdr';
  // The dist shape exactly (§8.3): a guarded legacy rollback replaces it once its own Vite is verified.
  if (distSocket && tcp?.HTTPS && Object.keys(tcp).length === 1 && onlyRoot && proxy === `unix:${distSocket}`
    && sites.length === 1 && tcpPorts.length === 1 && !config.AllowFunnel && !config.Services && !config.Foreground) return 'socket';
  return 'other';
};
let { config, error } = await readConfig();
if (error !== undefined) {
  console.error(`Could not read the Tailscale Serve configuration: ${error}\n${help}`);
  process.exit(1);
}
const before = owner(config);
if (before === 'other') {
  console.error(`Tailscale Serve already uses https://${hostname} for something else; Holdr left it unchanged.`);
  console.error(`To serve Holdr there instead (this replaces it), run: ${command}`);
  process.exitCode = 1;
} else if (before === 'holdr') {
  console.log(`Tailscale Serve: https://${hostname} -> ${target}`);
} else if (verified !== 'verified') {
  // Guarded publication (§8.3): a TCP target is published only for this script's own, verified Vite.
  console.error(`E0I_LEGACY_OWNER: port ${port} is not served by the Vite this script started (${verified}); Tailscale Serve was not changed.`);
  process.exitCode = 1;
} else {
  const result = await run(['serve', '--bg', '--https=443', target], 20_000);
  ({ config, error } = await readConfig());
  if (error === undefined && owner(config) === 'holdr') {
    console.log(`Tailscale Serve: https://${hostname} -> ${target} (configured now)`);
  } else {
    console.error(`Could not configure Tailscale Serve${result.detail ? `:\n${result.detail}` : '.'}\n${help}`);
    process.exitCode = 1;
  }
}
if (config?.AllowFunnel?.[site]) {
  console.error(`WARNING: Tailscale Funnel is on for https://${hostname}. Holdr refuses Funnel requests, but turn Funnel off:`);
  console.error(`  run "tailscale serve reset" (clears Funnel and Serve), then run this script again.`);
}
// Cookies are not port-scoped: other HTTPS services on this name would receive Holdr's session cookie.
const neighbours = Object.keys(config?.Web ?? {})
  .filter((key) => key.startsWith(`${hostname}:`) && key !== site && config.TCP?.[key.slice(hostname.length + 1)]?.HTTPS);
if (neighbours.length > 0) {
  console.error(`WARNING: Tailscale Serve also publishes ${neighbours.map((key) => `https://${key}`).join(', ')}.`);
  console.error('  Those services receive Holdr\'s session cookie too (cookies ignore the port); serve them from another machine.');
}
JS
}

# Guarded publication, owner check (§8.3): the web port's only listener is the Vite process this script just started, it passes
# the ownership check, and it serves a Vite document.
verify_own_vite() {
  local expected listeners
  expected=$(cat "$LOGDIR/web.pid" 2>/dev/null || true)
  listeners=$(lsof -nP -t -iTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | sort -u | xargs || true)
  [ -n "$expected" ] && [ "$listeners" = "$expected" ] || { echo "listener ${listeners:-none}, expected ${expected:-none}"; return 1; }
  owns_process web "$expected" || { echo "listener $expected is not this tree's Vite"; return 1; }
  curl -fsS --connect-timeout 1 --max-time 3 "http://127.0.0.1:$WEB_PORT/" 2>/dev/null | grep -q '/@vite/client' \
    || { echo "port $WEB_PORT does not serve a Vite document"; return 1; }
  echo verified
}

stop_targets=""
# lan: a LAN gateway an older version started, found by its PID file only (the gateway was removed).
for entry in "api:$API_PORT" "web:$WEB_PORT" "bridge:$BRIDGE_PORT" "lan:0"; do
  service=${entry%%:*}
  port=${entry#*:}
  process_ids=""
  if [ "$port" != 0 ]; then process_ids=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); fi
  if [ -f "$LOGDIR/$service.pid" ]; then
    saved_pid=$(cat "$LOGDIR/$service.pid")
    case "$saved_pid" in
      ''|*[!0-9]*) echo "Invalid PID file: $LOGDIR/$service.pid" >&2; exit 1 ;;
      *) if kill -0 "$saved_pid" 2>/dev/null && owns_process "$service" "$saved_pid"; then
           process_ids="$saved_pid $process_ids"
         fi ;;
    esac
  fi
  for process_id in $process_ids; do
    owns_process "$service" "$process_id" || { echo "Port $port belongs to a non-Holdr process ($process_id); nothing stopped." >&2; exit 1; }
    stop_targets="$stop_targets $service:$process_id"
  done
done
for target in $stop_targets; do
  service=${target%%:*}
  process_id=${target#*:}
  if kill -0 "$process_id" 2>/dev/null && owns_process "$service" "$process_id"; then
    kill -TERM "$process_id" 2>/dev/null || true
  fi
done
"$NODE" --input-type=module - "$API_PORT" "$WEB_PORT" "$BRIDGE_PORT" <<'JS'
import { spawnSync } from 'node:child_process';
const ports = process.argv.slice(2).map((port) => `-iTCP:${port}`);
const result = spawnSync('/usr/sbin/lsof', ['-nP', '-t', '-a', ...ports, '-sTCP:LISTEN', '+r', '1'], {
  timeout: 10_000, stdio: 'ignore',
});
if (result.error || (result.status !== 0 && result.status !== 1)) {
  console.error('Holdr ports did not stop within 10 seconds; no duplicate services started.');
  process.exit(1);
}
JS
for port in "$API_PORT" "$WEB_PORT" "$BRIDGE_PORT"; do
  if lsof -nP -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port has not stopped; no second service started." >&2
    exit 1
  fi
done

if [ -z "${WEB_ORIGIN:-}" ]; then
  WEB_ORIGIN="http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT"
  if [ -n "$public_origin" ]; then WEB_ORIGIN="$WEB_ORIGIN,$public_origin"; fi
fi

rotate_logs api web bridge

# Both listen on loopback only; other devices reach Vite through Tailscale Serve.
cd "$FT/apps/api"
run_service env HOLDR_WEB_MODE="$MODE" \
  PORT="$API_PORT" \
  HOLDR_HOST=127.0.0.1 \
  HOLDR_PUBLIC_ORIGIN="$public_origin" \
  WEB_ORIGIN="$WEB_ORIGIN" \
  BROKER_BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT" \
  SNAPSHOTS_ENABLED=1 \
  "$TSX" src/index.ts \
  < /dev/null > "$LOGDIR/api.log" 2>&1 &
echo $! > "$LOGDIR/api.pid"

cd "$FT/apps/web"
run_service env HOLDR_WEB_MODE="$MODE" HOLDR_TAILNET_ADDRESSES="$tailnet_addresses" HOLDR_TAILNET_HOSTNAME="$tailnet_hostname" \
  HOLDR_PUBLIC_ORIGIN="$public_origin" HOLDR_API_TARGET="http://127.0.0.1:$API_PORT" \
  "$FT/node_modules/.bin/vite" --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
  < /dev/null > "$LOGDIR/web.log" 2>&1 &
echo $! > "$LOGDIR/web.pid"

start_bridge

failed=0
check_health "api:$API_PORT/health" "web:$WEB_PORT/" "bridge:$BRIDGE_PORT/health" || failed=1

echo "Holdr on this Mac: http://127.0.0.1:$WEB_PORT"
if [ -n "$tailnet_hostname" ] && [ "$public_origin" = "https://$tailnet_hostname" ]; then
  vite_check=$(verify_own_vite) || true
  if tailscale_serve "${vite_check:-not verified}"; then
    echo "Holdr on your devices: $public_origin"
  else
    echo "Holdr on your devices: $public_origin, once Tailscale Serve forwards it here (see above)" >&2
    if [ "${vite_check:-}" != verified ]; then failed=1; fi
  fi
elif [ -n "$public_origin" ]; then
  echo "Holdr on your devices: $public_origin (HOLDR_PUBLIC_ORIGIN; its HTTPS front end must forward to http://127.0.0.1:$WEB_PORT)"
else
  echo "Other devices: not set up. Tailscale's MagicDNS name was not found (is Tailscale running, with MagicDNS on?)." >&2
  echo "Once it is, run this script again; it configures: $serve_command" >&2
fi
exit "$failed"
