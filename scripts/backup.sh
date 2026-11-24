#!/usr/bin/env bash
# Snapshot the API's data directory to ./backups/db/<UTC timestamp>/ (design §11.3 step 9, K19).
#
# The body is `holdr-backup`: finance.db is copied with VACUUM INTO (a consistent single-file snapshot, even while the
# server writes) under the lifecycle shared lease, so a backup never runs beside a maintenance holder; the other regular
# files of the data dir are copied too, except the access tokens (service-token, agent-token), which the API makes anew.
# Everything is 0600 in 0700 directories. It reads holdr.conf like every Holdr CLI.
#
# Restore is a recovery operation, never a file copy over a running Holdr: after E2, `holdr-recovery restore` (plan §9.5).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node_modules/.bin/tsx apps/api/src/cli/holdrBackupMain.ts "$@"
