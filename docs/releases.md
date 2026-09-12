# Releases and signed APK feed

Version tags matching `vYYYY.MM.DD` run the complete release workflow. A release
is created only after the JavaScript and Python tests, standalone package build,
paired ImmortalWrt 25.12 Filogic core build, package signing, index generation,
and signature verification all succeed.

The release contains:

- `luci-app-homeproxy` and Simplified Chinese APK/IPK packages;
- the paired `sing-box` APK for `aarch64_cortex-a53`;
- a signed `packages.adb` APK repository index;
- the public signing key and `SHA256SUMS`.

## First installation on ImmortalWrt 25.12

The public key fingerprint is:

```text
SHA256:d4f8ae549d80c9ab147309dfe8b44716a1f997aed528aa4d4ddade988be3252a
```

Install the key once and configure the stable feed URL:

```sh
wget -O /etc/apk/keys/homeproxy-apk.pem \
  https://github.com/wilksu/homeproxy/releases/latest/download/homeproxy-apk.pem

echo 'https://github.com/wilksu/homeproxy/releases/latest/download/packages.adb' \
  > /etc/apk/repositories.d/homeproxy.list

apk update
apk add luci-app-homeproxy luci-i18n-homeproxy-zh-cn
```

After the key and feed have been installed, HomeProxy appears as a normal
trusted package and its paired sing-box dependency is resolved automatically.

The LuCI package manager always shows a generic warning for a manually pasted
URL or uploaded package, regardless of its signature. Installing by package name
from the configured feed avoids that generic warning and retains signature
verification.

## Maintainer release process

1. Ensure `master` is green and points to the intended release commit.
2. Push a tag such as `v2026.09.12`.
3. The `Tagged signed release` workflow creates the GitHub Release only after
   the complete build and verification pipeline succeeds.

The private EC P-256 key is stored only in the repository Actions secret named
`APK_SIGNING_KEY`. Never commit or upload it as an artifact.
