#!/bin/sh
# cgi-exec reports HTTP transport success even when a command fails. Preserve
# the updater's exit status explicitly for the UI, without exposing feed URLs.
umask 077
mkdir -p /var/run/homeproxy || exit 1
/etc/homeproxy/scripts/update_subscriptions.uc "$@" >>/var/run/homeproxy/homeproxy.log 2>&1
status=$?
printf '{"code":%d}\n' "$status"
