#!/bin/sh
# Docker already isolates this development instance. Nested ujail is unavailable
# without broader host privileges; keep this adjustment inside the container.
set -eu

# The container engine assigns a static address. Keep netifd from replacing it
# with a DHCP lease when the archived OpenWrt image boots.
if [ -n "${HP_DEV_IPV4_ADDRESS:-}" ]; then
 prefix=${HP_DEV_SUBNET##*/}
 nameservers=$(awk '/^nameserver / && $2 != "127.0.0.1" && $2 != "::1" { print $2 }' /etc/resolv.conf)
 uci batch <<-EOF
set network.wan.proto=static
set network.wan.device=eth0
set network.wan.ipaddr=$HP_DEV_IPV4_ADDRESS/$prefix
set network.wan.gateway=$HP_DEV_GATEWAY
set network.wan6.auto=0
EOF
 uci -q delete network.wan.dns || true
 for nameserver in $nameservers; do
  uci add_list "network.wan.dns=$nameserver"
 done
 uci commit network
fi

if [ -x /sbin/ujail ]; then
 mv /sbin/ujail /sbin/ujail.disabled-in-container
fi
exec /sbin/init
