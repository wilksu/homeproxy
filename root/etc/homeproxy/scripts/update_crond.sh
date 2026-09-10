#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
#
# Copyright (C) 2023 ImmortalWrt.org

SCRIPTS_DIR="/etc/homeproxy/scripts"

resources_changed=0
for i in "china_ip4" "china_ip6" "gfw_list" "china_list"; do
	# 0 means updated; 3 means unchanged, 1/2 mean failed/busy.
	if "$SCRIPTS_DIR"/update_resources.sh "$i"; then resources_changed=1; fi
done

HP_RESOURCES_CHANGED="$resources_changed" "$SCRIPTS_DIR"/update_subscriptions.uc
