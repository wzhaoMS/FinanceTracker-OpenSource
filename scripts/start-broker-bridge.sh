#!/usr/bin/env bash
#
# Start the portfolio-bridge sidecar (Playwright Firefox) used by the
# "Pull from broker" button in the Finance Tracker web UI.
#
# Runs in the foreground - Ctrl-C to stop.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
VENV_PY="$WORKSPACE_ROOT/.venv/bin/python"
BRIDGE_DIR="$WORKSPACE_ROOT/apps/portfolio-bridge"

if [ ! -x "$VENV_PY" ]; then
  echo "error: $VENV_PY not found. Create the venv:" >&2
  echo "  python -m venv $WORKSPACE_ROOT/.venv && source $WORKSPACE_ROOT/.venv/bin/activate" >&2
  echo "  pip install -r $BRIDGE_DIR/requirements.txt" >&2
  echo "  playwright install firefox" >&2
  exit 1
fi

if [ ! -d "$BRIDGE_DIR" ]; then
  echo "error: $BRIDGE_DIR not found" >&2
  exit 1
fi

echo "Starting portfolio-bridge on http://127.0.0.1:3003"
echo "(Ctrl-C to stop)"
exec "$VENV_PY" "$BRIDGE_DIR/server.py"
