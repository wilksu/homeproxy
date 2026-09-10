#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
set -eu
umask 077
mkdir -p /etc/homeproxy /var/run/homeproxy
if [ ! -s /etc/homeproxy/api.secret ]; then
	secret_tmp=$(mktemp /etc/homeproxy/api.secret.XXXXXX)
	trap 'rm -f "$secret_tmp"' EXIT HUP INT TERM
	dd if=/dev/urandom bs=32 count=1 2>/dev/null | hexdump -v -e '1/1 "%02x"' > "$secret_tmp"
	[ "$(wc -c < "$secret_tmp")" -eq 64 ]
	mv "$secret_tmp" /etc/homeproxy/api.secret
	trap - EXIT HUP INT TERM
fi
chmod 600 /etc/homeproxy/api.secret
