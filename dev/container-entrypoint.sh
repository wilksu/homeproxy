#!/bin/sh
# Docker already isolates this development instance. Nested ujail is unavailable
# without broader host privileges; keep this adjustment inside the container.
set -eu
if [ -x /sbin/ujail ]; then
 mv /sbin/ujail /sbin/ujail.disabled-in-container
fi
exec /sbin/init
