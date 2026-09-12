#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only
# CI only: run in an extracted, disposable ImmortalWrt 25.12 SDK.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'SDK builds are restricted to GitHub Actions; local development uses script checks.' >&2; exit 1; }
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
sdk_dir="${1:?Usage: build-sdk.sh /path/to/disposable-sdk}"
sdk_dir="$(cd "$sdk_dir" && pwd)"
[ -f "$sdk_dir/include/toplevel.mk" ] || { echo 'Not an OpenWrt SDK' >&2; exit 1; }
cd "$sdk_dir"
# The SDK's feed configuration identifies its compatible branches/revisions.
./scripts/feeds update -a
./scripts/feeds install -a
# Override only the core feed link in this disposable build environment.
rm -f package/feeds/packages/sing-box package/feeds/luci/luci-app-homeproxy
[ ! -e package/homeproxy-paired ] || { echo 'Existing homeproxy-paired build directory; use a fresh SDK' >&2; exit 1; }
mkdir package/homeproxy-paired
cp -a "$source_dir/Makefile" "$source_dir/pairing.mk" "$source_dir/root" "$source_dir/htdocs" "$source_dir/po" "$source_dir/scripts" "$source_dir/packages" package/homeproxy-paired/
# The top-level recipe and nested companion recipes remain in one checkout.
cat >> .config <<'CONFIG'
CONFIG_PACKAGE_luci-app-homeproxy=m
CONFIG_LUCI_LANG_zh_Hans=y
CONFIG_PACKAGE_luci-i18n-homeproxy-zh-cn=m
CONFIG_PACKAGE_sing-box=m
# CONFIG_PACKAGE_sing-box-tiny is not set
CONFIG_ALL_KMODS=n
CONFIG_ALL_NONSHARED=n
CONFIG_ALL=n
CONFIG
make defconfig
make package/homeproxy-paired/compile -j"${JOBS:-2}" V=s
make package/homeproxy-paired/packages/sing-box/compile -j"${JOBS:-2}" V=s
