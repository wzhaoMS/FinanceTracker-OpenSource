#!/usr/bin/env bash
# Kept so existing commands keep working: the runner is scripts/e2e-disposable.mjs,
# one implementation for macOS, Linux and Windows. Its header lists the options.
#
#   scripts/e2e-disposable.sh [options] [--] [playwright test arguments]
exec "${NODE:-node}" "$(dirname "$0")/e2e-disposable.mjs" "$@"
