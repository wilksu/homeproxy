#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only
#
# Copyright (C) 2023 Tianling Shen <cnsztl@immortalwrt.org>

set -o errexit
set -o pipefail

PKG_MGR="${1:-apk}"
RELEASE_TYPE="${2:-snapshot}"
LANGUAGE="${3:-}"
case "$PKG_MGR" in apk|ipk) ;; *) echo "Expected apk or ipk" >&2; exit 1;; esac
if [ -n "$LANGUAGE" ] && [[ ! "$LANGUAGE" =~ ^[A-Za-z0-9_@-]+$ ]]; then exit 1; fi

export PKG_SOURCE_DATE_EPOCH="${PKG_SOURCE_DATE_EPOCH:-$(date "+%s")}"
export SOURCE_DATE_EPOCH="$PKG_SOURCE_DATE_EPOCH"

BASE_DIR="$(cd "$(dirname $0)"; pwd)"
PKG_DIR="$BASE_DIR/.."

function get_mk_value() {
	awk -F "$1:=" '{print $2}' "$PKG_DIR/Makefile" | xargs
}

PKG_NAME="$(get_mk_value "PKG_NAME")"
CORE_PACKAGE_VERSION="$(python3 "$PKG_DIR/scripts/pairing.py" core_package_version)"
APK_DEPENDS="libc sing-box=$CORE_PACKAGE_VERSION curl bind-dig firewall4 kmod-nft-tproxy ucode-mod-digest"
IPK_DEPENDS="libc, sing-box (= $CORE_PACKAGE_VERSION), curl, bind-dig, firewall4, kmod-nft-tproxy, ucode-mod-digest"
if [ -n "$LANGUAGE" ]; then
 [ -f "$PKG_DIR/po/$LANGUAGE/homeproxy.po" ] || exit 1
 LANGUAGE_CODE="${LANGUAGE//_/-}"
 LANGUAGE_CODE="${LANGUAGE_CODE,,}"
 case "$LANGUAGE" in zh_Hans) LANGUAGE_CODE=zh-cn;; zh_Hant) LANGUAGE_CODE=zh-tw;; esac
 PKG_NAME="luci-i18n-homeproxy-$LANGUAGE_CODE"
 APK_DEPENDS="luci-app-homeproxy"
 IPK_DEPENDS="luci-app-homeproxy"
fi
if [ "$RELEASE_TYPE" == "release" ] && [ -z "${PKG_VERSION:-}" ]; then
	PKG_VERSION="$(get_mk_value "PKG_VERSION")"
fi
if [ -z "${PKG_VERSION:-}" ]; then
	PKG_VERSION="$PKG_SOURCE_DATE_EPOCH~$(git rev-parse --short HEAD)"
fi

TEMP_DIR="$(mktemp -d -p $BASE_DIR)"
trap 'rm -rf "$TEMP_DIR"' EXIT
TEMP_PKG_DIR="$TEMP_DIR/$PKG_NAME"
mkdir -p "$TEMP_PKG_DIR/lib/upgrade/keep.d/"
mkdir -p "$TEMP_PKG_DIR/www/"
if [ "$PKG_MGR" == "apk" ]; then
	APK_SIGN_ARGS=()
	if [ -n "${APK_SIGNING_KEY_FILE:-}" ]; then
		[ -s "$APK_SIGNING_KEY_FILE" ] || { echo "APK signing key is missing" >&2; exit 1; }
		APK_SIGN_ARGS=(--sign-key "$APK_SIGNING_KEY_FILE")
	fi
	mkdir -p "$TEMP_PKG_DIR/lib/apk/packages/"
else
	mkdir -p "$TEMP_PKG_DIR/CONTROL/"
fi

if [ -z "$LANGUAGE" ]; then
 cp -fpR "$PKG_DIR/htdocs"/* "$TEMP_PKG_DIR/www/"
 cp -fpR "$PKG_DIR/root"/* "$TEMP_PKG_DIR/"
 cat > "$TEMP_PKG_DIR/lib/upgrade/keep.d/$PKG_NAME" <<-EOF
/etc/homeproxy/api.secret
/etc/homeproxy/tailscale/
/etc/homeproxy/certs/
/etc/homeproxy/ruleset/
/etc/homeproxy/resources/direct_list.txt
/etc/homeproxy/resources/proxy_list.txt
EOF
else
 mkdir -p "$TEMP_PKG_DIR/usr/lib/lua/luci/i18n/" "$TEMP_PKG_DIR/etc/uci-defaults"
 po2lmo "$PKG_DIR/po/$LANGUAGE/homeproxy.po" "$TEMP_PKG_DIR/usr/lib/lua/luci/i18n/homeproxy.$LANGUAGE_CODE.lmo"
 # Register the installed language with LuCI; language metadata is package-owned.
 LANGUAGE_LABEL="$LANGUAGE_CODE"
 case "$LANGUAGE" in zh_Hans) LANGUAGE_LABEL='简体中文 (Chinese Simplified)';; zh_Hant) LANGUAGE_LABEL='繁體中文 (Chinese Traditional)';; esac
 printf '#!/bin/sh\nuci -q set luci.languages.%s="%s"\nuci -q commit luci\nexit 0\n' "${LANGUAGE_CODE//-/_}" "$LANGUAGE_LABEL" > "$TEMP_PKG_DIR/etc/uci-defaults/$PKG_NAME"
 chmod 0755 "$TEMP_PKG_DIR/etc/uci-defaults/$PKG_NAME"
fi

if [ "$PKG_MGR" == "apk" ]; then
	find "$TEMP_PKG_DIR" -type f,l -printf '/%P\n' | sort > "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.list"
	touch "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.conffiles"
	[ -n "$LANGUAGE" ] || printf "/etc/config/homeproxy\n/etc/homeproxy/api.secret\n" >> "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.conffiles"
	cat "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.conffiles" | while IFS= read -r file; do
		[ -f "$TEMP_PKG_DIR/$file" ] || continue
		sha256sum "$TEMP_PKG_DIR/$file" | sed "s,$TEMP_PKG_DIR/,," >> "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.conffiles_static"
	done

	echo -e '#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="'"$PKG_NAME"'"
add_group_and_user
default_postinst
[ -n "${IPKG_INSTROOT}" ] || { rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	killall -HUP rpcd 2>/dev/null
	exit 0
}' > "$TEMP_DIR/post-install"

	echo -e '#!/bin/sh
export PKG_UPGRADE=1
#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="'"$PKG_NAME"'"
add_group_and_user
default_postinst
[ -n "${IPKG_INSTROOT}" ] || { rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	killall -HUP rpcd 2>/dev/null
	exit 0
}' > "$TEMP_DIR/post-upgrade"

	echo -e '#!/bin/sh
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="'"$PKG_NAME"'"
default_prerm' > "$TEMP_DIR/pre-deinstall"

	apk mkpkg \
		"${APK_SIGN_ARGS[@]}" \
		--info "name:$PKG_NAME" \
		--info "version:$PKG_VERSION" \
		--info "description:The modern ImmortalWrt proxy platform for ARM64/AMD64" \
		--info "arch:noarch" \
		--info "origin:https://github.com/immortalwrt/homeproxy" \
		--info "url:" \
		--info "maintainer:Tianling Shen <cnsztl@immortalwrt.org>" \
		--info "provides:" \
		--script "post-install:$TEMP_DIR/post-install" \
		--script "post-upgrade:$TEMP_DIR/post-upgrade" \
		--script "pre-deinstall:$TEMP_DIR/pre-deinstall" \
		--info "depends:$APK_DEPENDS" \
		--files "$TEMP_PKG_DIR" \
		--output "$TEMP_DIR/${PKG_NAME}-${PKG_VERSION}.apk"

	mv "$TEMP_DIR/${PKG_NAME}-${PKG_VERSION}.apk" "$BASE_DIR/${PKG_NAME}-${PKG_VERSION}.apk"
else
	mkdir -p "$TEMP_PKG_DIR/CONTROL/"

	cat > "$TEMP_PKG_DIR/CONTROL/control" <<-EOF
		Package: $PKG_NAME
		Version: $PKG_VERSION
		Depends: $IPK_DEPENDS
		Source: https://github.com/immortalwrt/homeproxy
		SourceName: $PKG_NAME
		Section: luci
		SourceDateEpoch: $PKG_SOURCE_DATE_EPOCH
		Maintainer: Tianling Shen <cnsztl@immortalwrt.org>
		Architecture: all
		Installed-Size: TO-BE-FILLED-BY-IPKG-BUILD
		Description:  The modern ImmortalWrt proxy platform for ARM64/AMD64
	EOF
	chmod 0644 "$TEMP_PKG_DIR/CONTROL/control"

	[ -n "$LANGUAGE" ] || printf "/etc/config/homeproxy\n/etc/homeproxy/api.secret\n" > "$TEMP_PKG_DIR/CONTROL/conffiles"

	echo -e '#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
default_postinst $0 $@' > "$TEMP_PKG_DIR/CONTROL/postinst"
	chmod 0755 "$TEMP_PKG_DIR/CONTROL/postinst"

	echo -e "[ -n "\${IPKG_INSTROOT}" ] || {
	(. /etc/uci-defaults/$PKG_NAME) && rm -f /etc/uci-defaults/$PKG_NAME
	rm -f /tmp/luci-indexcache
	rm -rf /tmp/luci-modulecache/
	exit 0
}" > "$TEMP_PKG_DIR/CONTROL/postinst-pkg"
	chmod 0755 "$TEMP_PKG_DIR/CONTROL/postinst-pkg"

	echo -e '#!/bin/sh
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
default_prerm $0 $@' > "$TEMP_PKG_DIR/CONTROL/prerm"
	chmod 0755 "$TEMP_PKG_DIR/CONTROL/prerm"

	ipkg-build -m "" "$TEMP_PKG_DIR" "$TEMP_DIR"

	mv "$TEMP_DIR/${PKG_NAME}_${PKG_VERSION}_all.ipk" "$BASE_DIR/${PKG_NAME}_${PKG_VERSION}_all.ipk"
fi

rm -rf "$TEMP_DIR"

# Build each shipped translation as a separate optional package.
if [ -z "$LANGUAGE" ]; then
 for translation in "$PKG_DIR"/po/*/homeproxy.po; do
  [ -f "$translation" ] || continue
  language_dir="${translation%/homeproxy.po}"
  bash "$BASE_DIR/build-ipk.sh" "$PKG_MGR" "$RELEASE_TYPE" "${language_dir##*/}"
 done
fi
