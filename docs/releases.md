# Releases and signed APK feed

Version tags matching `vYYYY.MM.DD` run the complete release workflow. A release
is created only after the JavaScript and Python tests, standalone package build,
package signing, index generation, and signature verification all succeed.

The release contains:

- `luci-app-homeproxy` and Simplified Chinese APK/IPK packages;
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

The release does not contain sing-box. A matching `sing-box 1.14.0-r1` package
must already be installed or available from another configured repository.
After the key and feed have been installed, HomeProxy appears as a normal
trusted package; apk resolves the remaining dependencies from configured feeds.

The LuCI package manager always shows a generic warning for a manually pasted
URL or uploaded package, regardless of its signature. Installing by package name
from the configured feed avoids that generic warning and retains signature
verification.

## Paired core releases

The sing-box core has a separate, low-frequency release workflow. A push to
`master` that changes `core_package_version` in
`root/usr/share/homeproxy/compat.json` automatically builds the default
`aarch64_cortex-a53` and `x86_64` packages. Changes to other compatibility
metadata do not create a core release.

Maintainers can also run `Build and release paired sing-box core` manually and
select any combination of A53, x86-64, generic ARM64, and Cortex-A72. A manual
run can add a previously unbuilt architecture to the same
`core-v<package-version>` release, but it refuses to overwrite an existing
asset. Core releases are never marked as the repository's latest application
release.

Each target uses a pinned ImmortalWrt 25.12 SDK and the source version/hash from
the compatibility manifest. The workflow builds only sing-box, replaces the
SDK package signature with the HomeProxy APK signature, checks package metadata,
build tags and native API symbols, and publishes an architecture-qualified APK,
SHA256 file and provenance JSON.

## Maintainer release process

1. Ensure `master` is green and points to the intended release commit.
2. Push a tag such as `v2026.09.12`.
3. The `Tagged signed HomeProxy release` workflow creates the GitHub Release only after
   the complete build and verification pipeline succeeds.

The private EC P-256 key is stored only in the repository Actions secret named
`APK_SIGNING_KEY`. Never commit or upload it as an artifact.
