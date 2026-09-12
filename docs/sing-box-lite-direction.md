# sing-box Lite direction (deferred)

Status: design record only. No Lite package or runtime behavior is implemented by this document.

## Goal

Investigate a HomeProxy-compatible sing-box build for storage-constrained OpenWrt devices, especially 16 MiB flash targets, without weakening the normal package. The normal build remains the compatibility baseline; a future Lite build would be an explicit, separately tested package profile.

Sixteen MiB is total flash, not free package space. A binary-size result alone does not prove that a post-install or firmware image fits. A final decision requires a real firmware build, first-boot free-space measurement, and runtime memory testing on target hardware.

## Measurements

The remote benchmark workflow pins sing-box v1.14.0 and the project Go toolchain. Its Cortex-A53-compatible ARM64 results establish the build-tag baseline:

| Variant | ELF | gzip proxy | Saved ELF vs baseline |
| --- | ---: | ---: | ---: |
| Current tiny-style baseline | 40.56 MiB | 13.87 MiB | - |
| No gVisor | 36.69 MiB | 12.62 MiB | 9.6% |
| No WireGuard | 39.81 MiB | 13.64 MiB | 1.8% |
| No QUIC | 37.38 MiB | 12.80 MiB | 7.9% |
| No Clash API | 40.44 MiB | 13.82 MiB | 0.3% |
| `with_utls,with_low_memory` | 32.63 MiB | 11.25 MiB | 19.6% |
| `with_low_memory` only | 32.44 MiB | 11.19 MiB | 20.0% |

`gzip` is a comparison proxy, not an APK/IPK installed-size guarantee.

Additional source-pruning experiments used the same ARM64 target but a local Go 1.26.4 container, so their absolute sizes must be repeated in the pinned remote workflow before release decisions:

| Experimental profile | ELF | gzip proxy |
| --- | ---: | ---: |
| Full registries, native API, full CLI, Clash API enabled | 32.62 MiB | 11.31 MiB |
| Full registries, native API, HomeProxy CLI whitelist | 31.69 MiB | 11.02 MiB |
| Full registries, Clash API only, HomeProxy CLI whitelist | 27.00 MiB | 9.56 MiB |
| HomeProxy-compatible registries, Clash API only, CLI whitelist | 21.63 MiB | 7.96 MiB |
| Client-only registry experiment | 20.63 MiB | 7.60 MiB |

Removing HomeProxy's server protocol inbounds saves only about 1 MiB of ELF and 367 KiB of gzip in the pruned graph. Client and server implementations share substantial protocol code, so a future Lite profile should retain the existing non-QUIC server functionality.

## Candidate build profile

Keep:

- `with_low_memory`
- `with_utls` (small cost; required for Reality and TLS fingerprints)
- `with_clash_api` (small standalone cost and covers most useful observation controls)
- the upstream release/linker compatibility tags `badlinkname` and `tfogo_checklinkname0`
- all current non-QUIC HomeProxy client and server protocols
- router-facing `direct`, `mixed`, `redirect`, `tproxy`, and `tun` inbounds
- `direct`, `block`, `selector`, and `urltest` outbounds
- UDP, TCP, TLS, HTTPS, hosts, and local DNS transports
- the CLI commands used by HomeProxy: `run`, `check`, `version`, `generate`, and the hidden network-namespace holder

Do not enable in the constrained profile:

- `with_gvisor`
- `with_quic` (therefore no Hysteria, Hysteria2, TUIC, QUIC DNS, or HTTP/3)
- `with_wireguard`
- `with_tailscale`
- `with_acme` (manual server certificates remain supported)
- `with_v2ray_api`
- `with_naive_outbound`

`with_dhcp` is independent and cheap (about 54 KiB gzip in the local experiment). It can remain excluded while HomeProxy has no DHCP DNS transport setting, but is not an important optimization target.

Potential downstream-only build switches:

- `without_api`: exclude the native gRPC service and the `sing-box api` CLI tree together.
- `homeproxy_lite`: select the HomeProxy-compatible registry rather than modifying upstream defaults.

The negative API switch preserves upstream behavior when no custom tag is supplied. The exact tag names are provisional.

## Registry scope

The compatible Lite registry may omit components HomeProxy does not generate or expose:

- Snell inbound/outbound
- Tor outbound (also requires an external `tor` executable and data at runtime)
- bridge outbound
- mDNS and FakeIP DNS transports
- the systemd-resolved DNS transport/service, which is not an OpenWrt integration
- SSM API, which dynamically manages multi-user Shadowsocks servers
- removed-protocol compatibility stubs

mDNS, FakeIP, SSM API, and Snell are built-in implementations and do not require separate local executables. They are candidates because HomeProxy does not configure them, not because they are incomplete. If HomeProxy later adds one of these modes, the registry decision must be revisited.

In the pruned Clash-only graph, the unused registry set saved about 1.60 MiB gzip. Savings are non-additive because Go packages share dependencies; with the native API present, the apparent saving was much smaller.

## Native API versus Clash API

The native API registers the complete gRPC `StartedService`, including protobuf descriptors, HTTP/2, gRPC-Web bridging, daemon lifecycle support, network-quality and STUN tests, notifications, and optional-platform management surfaces. HomeProxy uses only a subset.

Clash API already provides the main embedded-router observation features:

- version, traffic, and memory
- log streaming
- connection snapshots and close controls
- outbound/group discovery and selector changes
- URL tests

A future Lite UI can map those features through the existing same-origin, LuCI-authenticated relay. The core secret must remain server-side and only an explicit read/control endpoint allowlist should be proxied. Native-only STUN, network-quality, and Tailscale tools would be unavailable in Lite and must be hidden rather than allowed to fail at runtime.

Excluding only the runtime API registration is insufficient: the `sing-box api` CLI imports the same daemon/gRPC graph. The runtime service and API CLI must both be excluded to realize the size reduction. Other unused CLI commands provide only a modest direct saving.

## Dependency notes

- ACME is independent of QUIC. It provides automatic server certificate issuance and renewal over normal HTTPS; enabling it added about 370 KiB gzip locally.
- Tailscale practically requires gVisor in this build. Tailscale plus gVisor added about 4.98 MiB gzip locally; Tailscale itself accounted for roughly 4.14 MiB on top of gVisor in that graph.
- HomeProxy currently requires both WireGuard and gVisor feature tags before exposing its WireGuard endpoint UI.
- Hysteria, Hysteria2, and TUIC require QUIC.
- Reality requires uTLS.
- These measurements overlap and must not be summed as independent package costs.

## Implementation boundary if resumed

Keep the work split so each risk is attributable:

1. Add benchmark-only patched variants and reproduce the local numbers with the pinned toolchain.
2. Add the CLI whitelist and optional native API exclusion; retain full protocol registries.
3. Add a Clash API adapter behind the existing HomeProxy API client interface and preserve the same LuCI ACL/secret boundary.
4. Add the compatible Lite registry without removing HomeProxy server support.
5. Package Full and Lite as explicit, mutually exclusive core choices.

Required verification includes Full/Lite configuration generation, `sing-box check` for every fixture, real connectivity for every advertised protocol, Clash observation parity, browser automation, package installation, service restart/rollback, final firmware size, writable-space reserve, and idle/loaded RAM on target hardware.

Until that work is explicitly resumed, the normal core/API design remains authoritative and no UI capability should be removed.
