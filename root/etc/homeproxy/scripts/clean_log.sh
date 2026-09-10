#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
# Keep a bounded previous window rather than discarding all failure evidence.
while true; do
	sleep 60
	for file in /var/run/homeproxy/homeproxy.log /var/run/homeproxy/sing-box-c.log /var/run/homeproxy/sing-box-s.log; do
		[ -f "$file" ] || continue
		[ "$(wc -c < "$file")" -lt 262144 ] && continue
		tail -c 262144 "$file" > "$file.1"
		chmod 600 "$file.1"
		: > "$file"
	done

 done
