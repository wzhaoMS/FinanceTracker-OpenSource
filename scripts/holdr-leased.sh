#!/bin/bash
# The lease-aware entrypoint (design §9.3): inside a maintenance lease, Node runs only through this script. It checks the
# role against the lease-accepting roles and execs one Node process with the tsx loader in-process (no npm, npx or tsx
# launcher, which would respawn and lose fd 3), so the role itself holds the lease and proves it.
set -euo pipefail
role="${1:-}"
case "$role" in
  validate-offline|verify-release|status) shift ;;
  *) echo "holdr-leased: role must be validate-offline, verify-release or status" >&2; exit 64 ;;
esac
T=$(cd "$(dirname "$0")/.." && pwd -P)
NODE="${HOLDR_NODE:-$(command -v node || true)}"
case "$NODE" in /*) ;; *) echo "holdr-leased: set HOLDR_NODE to an absolute Node executable" >&2; exit 1 ;; esac
[ -x "$NODE" ] || { echo "holdr-leased: HOLDR_NODE is not executable" >&2; exit 1; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
exec "$NODE" --import "$T/node_modules/tsx/dist/loader.mjs" "$T/apps/api/src/cli/leasedMain.ts" "$role" "$@"
