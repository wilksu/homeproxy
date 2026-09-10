#!/bin/sh
# Direct-only fixture for UI/API development. Does not install firewall rules.
set -eu
umask 077
mkdir -p /var/run/homeproxy
ucode -e '
import { readfile, writefile } from "fs";
const secret = trim(readfile("/etc/homeproxy/api.secret"));
writefile("/var/run/homeproxy/sing-box-c.json", sprintf("%.J", {
 log: { level: "warn", output: "/var/run/homeproxy/sing-box-c.log", timestamp: true },
 inbounds: [{ type: "mixed", tag: "mixed-in", listen: "0.0.0.0", listen_port: 5330 }],
 outbounds: [{ type: "direct", tag: "direct-out" }],
 route: { final: "direct-out" },
 http_clients: [{ tag: "hp-direct-http" }],
 services: [{type: "api", tag: "homeproxy-api", listen: "0.0.0.0", listen_port: 5334, secret,
 dashboard: false}]
}));'
/usr/bin/sing-box check -c /var/run/homeproxy/sing-box-c.json
ubus call service set '{"name":"homeproxy","instances":{"sing-box-c":{"command":["/usr/bin/sing-box","run","-c","/var/run/homeproxy/sing-box-c.json"],"respawn":[3600,5,5],"stderr":true}}}'
echo 'HomeProxy development: direct-only API fixture started (no transparent proxy).'
