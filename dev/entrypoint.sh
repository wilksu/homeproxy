#!/bin/sh
set -eu
umask 022
mkdir -p /var/lock /var/run /tmp/.uci /etc/homeproxy/resources /opt/apk-cache
chmod 755 /var/run
chmod 1777 /var/lock
# Use the same signed-package mirror selected by this image's Chinese defaults.
sed -i 's|https://downloads.immortalwrt.org|https://mirrors.vsean.net/openwrt|g' /etc/apk/repositories.d/distfeeds.list
# Install released packages only. No SDK, compiler or image build is involved.
if ! apk info -e curl bind-dig ucode-mod-digest >/dev/null 2>&1; then
 apk --cache-dir /opt/apk-cache update
 apk --cache-dir /opt/apk-cache add curl=8.19.0-r2 bind-dig=9.20.26-r1 ucode-mod-digest=2026.01.16~85922056-r1
fi
# Docker owns the network. Do not run DHCP clients/servers, firewall or NTP.
for service in network firewall dnsmasq odhcpd sysntpd dropbear; do
 /etc/init.d/$service disable || true
done
# Preserve UCI changes across recreation; seed the application's defaults once.
[ -f /etc/config/homeproxy ] || cp /workspace/root/etc/config/homeproxy /etc/config/homeproxy
for file in /workspace/root/etc/homeproxy/resources/*; do
 [ -e "$file" ] || continue
 [ -e "/etc/homeproxy/resources/${file##*/}" ] || cp "$file" /etc/homeproxy/resources/
done
# Link individual application paths; never overlay all of /www, /etc or /usr.
find /workspace/root -type f | while IFS= read -r source; do
 target=${source#/workspace/root}
 case "$target" in /etc/config/*|/etc/homeproxy/resources/*|/etc/uci-defaults/*) continue;; esac
 mkdir -p "${target%/*}"
 ln -sf "$source" "$target"
done
find /workspace/htdocs -type f | while IFS= read -r source; do
 target=/www${source#/workspace/htdocs}
 mkdir -p "${target%/*}"
 ln -sf "$source" "$target"
done
ln -sf /opt/homeproxy-assets/core/sing-box /usr/bin/sing-box
# Shadow is image-local; restore the development password on recreation.
{ cat /run/homeproxy-dev-password; printf '\n'; cat /run/homeproxy-dev-password; printf '\n'; } | passwd root >/dev/null
touch /etc/config/system
uci -q get 'system.@system[0]' >/dev/null || uci set system.dev=system
uci set 'system.@system[0].hostname=homeproxy-dev'
uci set uhttpd.main.redirect_https=0
uci set uhttpd.main.max_requests=8
uci commit system
uci commit uhttpd
/etc/homeproxy/scripts/prepare.sh
ucode /etc/homeproxy/scripts/migrate_config.uc
# Keep the environment idle; application testing is started manually.
cp /workspace/dev/rc.local /etc/rc.local
chmod 755 /etc/rc.local
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null || true
exec /sbin/init
