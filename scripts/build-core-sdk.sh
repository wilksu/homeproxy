#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only
# CI only: build the paired sing-box package in an extracted ImmortalWrt SDK.
set -euo pipefail

[ "${GITHUB_ACTIONS:-}" = true ] || {
	echo 'Core SDK builds are restricted to GitHub Actions.' >&2
	exit 1
}

source_dir="$(cd "$(dirname "$0")/.." && pwd)"
sdk_dir="${1:?Usage: build-core-sdk.sh /path/to/disposable-sdk}"
sdk_dir="$(cd "$sdk_dir" && pwd)"
[ -f "$sdk_dir/include/toplevel.mk" ] || { echo 'Not an OpenWrt SDK' >&2; exit 1; }

cd "$sdk_dir"
./scripts/feeds update -a
./scripts/feeds install -a

# Keep the companion recipe isolated from and preferred over the SDK feed copy.
rm -f package/feeds/packages/sing-box
[ ! -e package/homeproxy-core ] || { echo 'Use a fresh SDK directory' >&2; exit 1; }
mkdir -p package/homeproxy-core/scripts package/homeproxy-core/root/usr/share/homeproxy
cp "$source_dir/pairing.mk" package/homeproxy-core/
cp "$source_dir/scripts/pairing.py" package/homeproxy-core/scripts/
cp "$source_dir/root/usr/share/homeproxy/compat.json" package/homeproxy-core/root/usr/share/homeproxy/
cp -a "$source_dir/packages" package/homeproxy-core/

cat >> .config <<'CONFIG'
CONFIG_PACKAGE_sing-box=m
# CONFIG_PACKAGE_sing-box-tiny is not set
CONFIG_ALL_KMODS=n
CONFIG_ALL_NONSHARED=n
CONFIG_ALL=n
CONFIG
make defconfig
make package/homeproxy-core/packages/sing-box/compile -j"${JOBS:-2}" V=s
