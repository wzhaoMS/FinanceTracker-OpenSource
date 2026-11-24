#!/bin/bash
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOLDR_LAUNCHD=1

if ! scutil -w State:/Network/Global/IPv4 -t 60; then
	echo "holdr-boot: IPv4 was not ready within 60 seconds; starting local services while networking settles" >&2
fi
/bin/bash "$HOME/bin/start-finance-mac.sh" < /dev/null
status=$?
echo "holdr-boot: startup exit=$status"
exit "$status"