#!/bin/sh
# Direct-only fixture for UI/API development. Does not install firewall rules.
set -eu
umask 077
ucode -e '
import { connect } from "ubus";
const services = connect().call("service", "list", { name: "homeproxy" });
if (type(services) !== "object") die("Unable to read HomeProxy service state.");
if (length(keys(services.homeproxy?.instances || {})))
 die("Stop the existing HomeProxy instances before starting the development fixture.");
'
mkdir -p /var/run/homeproxy
ucode -e '
import { readfile, writefile } from "fs";
const secret = trim(readfile("/etc/homeproxy/api.secret"));
writefile("/var/run/homeproxy/sing-box-c.json", sprintf("%.J", {
 log: { level: "warn", output: "/var/run/homeproxy/sing-box-c.log", timestamp: true },
 inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 5330 }],
 outbounds: [
  { type: "direct", tag: "direct-out" },
  { type: "direct", tag: "direct-alt" },
  { type: "selector", tag: "test-selector", outbounds: ["direct-out", "direct-alt"] }
 ],
 route: { final: "test-selector" },
 http_clients: [{ tag: "hp-direct-http" }],
 experimental: { clash_api: { external_controller: "127.0.0.1:5334", secret } }
}));'
/usr/bin/sing-box check -c /var/run/homeproxy/sing-box-c.json
ubus call service set '{"name":"homeproxy","instances":{"sing-box-c":{"command":["/usr/bin/sing-box","run","-c","/var/run/homeproxy/sing-box-c.json"],"respawn":[3600,5,5],"stderr":true}}}'
echo 'HomeProxy development: direct-only API fixture started (no transparent proxy).'
