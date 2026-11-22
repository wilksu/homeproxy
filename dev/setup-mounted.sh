#!/bin/sh
# Only prepare dependencies and HomeProxy metadata; never build or start a proxy.
set -eu
attempt=0
until ubus list session >/dev/null 2>&1; do
 attempt=$((attempt + 1))
 [ "$attempt" -lt 60 ] || { echo 'rpcd did not start' >&2; exit 1; }
 sleep 1
done
if ! apk info -e curl bind-dig openssl-util >/dev/null 2>&1; then
 apk add curl bind-dig openssl-util
fi
/etc/homeproxy/scripts/prepare.sh
ucode /etc/homeproxy/scripts/migrate_config.uc
gateway="$(ip -4 route show default | awk '/^default via / { print $3; exit }')"
if [ -n "$gateway" ]; then
 uci batch <<-EOF
set firewall.@defaults[0].flow_offloading=0
set firewall.@defaults[0].flow_offloading_hw=0
set firewall.homeproxy_dev_dashboard=rule
set firewall.homeproxy_dev_dashboard.name=Allow-Development-Web
set firewall.homeproxy_dev_dashboard.src=wan
set firewall.homeproxy_dev_dashboard.src_ip=$gateway
set firewall.homeproxy_dev_dashboard.proto=tcp
set firewall.homeproxy_dev_dashboard.dest_port='80 5334 5336 5337'
set firewall.homeproxy_dev_dashboard.target=ACCEPT
commit firewall
EOF
 fw4 reload
fi
rm -f /tmp/luci-indexcache*
rm -rf /tmp/luci-modulecache
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
