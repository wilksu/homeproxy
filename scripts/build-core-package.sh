#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only
set -euo pipefail

root_dir="${1:?Usage: build-core-package.sh ROOT ARCH VERSION OUTPUT}"
arch="${2:?Missing package architecture}"
version="${3:?Missing package version}"
output_dir="${4:?Missing output directory}"
signing_key="${APK_SIGNING_KEY_FILE:?APK_SIGNING_KEY_FILE is required}"

[[ "$arch" =~ ^[A-Za-z0-9_-]+$ ]]
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$ ]]
[ -x "$root_dir/usr/bin/sing-box" ]
[ -s "$signing_key" ]
mkdir -p "$root_dir/lib/apk/packages" "$output_dir"

printf '%s\n' 'sing-box=5566:sing-box=5566' > "$root_dir/lib/apk/packages/sing-box.rusers"
find "$root_dir" -type f,l -printf '/%P\n' | sort > "$root_dir/lib/apk/packages/sing-box.list"
chown -R 0:0 "$root_dir"

post_install=$(mktemp)
trap 'rm -f "$post_install"' EXIT
printf '%s\n' \
  '#!/bin/sh' \
  '[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0' \
  '[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0' \
  '. ${IPKG_INSTROOT}/lib/functions.sh' \
  'export root="${IPKG_INSTROOT}"' \
  'export pkgname="sing-box"' \
  'add_group_and_user' \
  'default_postinst' > "$post_install"

plain="$output_dir/sing-box-$version.apk"
apk mkpkg \
  --sign-key "$signing_key" \
  --info 'name:sing-box' \
  --info "version:$version" \
  --info 'description:The universal proxy platform paired with HomeProxy' \
  --info "arch:$arch" \
  --info 'license:GPL-3.0-or-later' \
  --info 'origin:https://github.com/wilksu/homeproxy' \
  --info 'url:https://sing-box.sagernet.org/' \
  --info 'maintainer:HomeProxy maintainers' \
  --info 'provides:sing-box-any' \
  --info 'depends:ca-bundle kmod-inet-diag kmod-netlink-diag kmod-tun libc' \
  --script "post-install:$post_install" \
  --files "$root_dir" \
  --output "$plain"
mv "$plain" "$output_dir/sing-box-$version-$arch.apk"
