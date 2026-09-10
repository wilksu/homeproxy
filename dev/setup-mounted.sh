#!/bin/sh
# Only prepare dependencies and HomeProxy metadata; never build or start a proxy.
set -eu
attempt=0
until ubus list session >/dev/null 2>&1; do
 attempt=$((attempt + 1))
 [ "$attempt" -lt 60 ] || { echo 'rpcd did not start' >&2; exit 1; }
 sleep 1
done
if ! apk info -e curl bind-dig >/dev/null 2>&1; then
 apk update
 apk add curl bind-dig
fi
/etc/homeproxy/scripts/prepare.sh
ucode /etc/homeproxy/scripts/migrate_config.uc
rm -f /tmp/luci-indexcache*
rm -rf /tmp/luci-modulecache
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
