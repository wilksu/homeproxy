/* SPDX-License-Identifier: GPL-2.0-only */
import { readfile, mkstemp, access } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';

function quote(s) { return "'" + replace(s, "'", "'\\''") + "'"; }
function execute(args, timeout) {
 const out = mkstemp(), err = mkstemp();
 const code = system(join(' ', map(args, quote)) + ' >&' + out.fileno() + ' 2>&' + err.fileno(), timeout || 6500);
 out.seek(0); err.seek(0);
 const result = { code, stdout: out.read(16384) || '', stderr: err.read(4096) || '' };
 out.close(); err.close();
 return result;
};
export function runtime(instance) {
 if (!(instance in ['client', 'server'])) return { error: 'Invalid instance' };
 const compat = json(readfile('/usr/share/homeproxy/compat.json'));
 const version = execute(['/usr/bin/sing-box', 'version'], 3000);
 const actual = match(version.stdout, /^sing-box version ([^\n]+)/)?.[1];
 const filename = '/var/run/homeproxy/sing-box-' + (instance === 'client' ? 'c' : 's') + '.json';
 let config;
 try { config = json(readfile(filename)); } catch (e) {}
 const api = filter(config?.services || [], (s) => s.type === 'api')[0];
 const uci = cursor(), names = {};
 for (let kind in ['node', 'routing_node', 'ruleset', 'dns_server', 'routing_rule', 'dns_rule', 'server'])
  uci.foreach('homeproxy', kind, (s) => { names[s['.name']] = s.label || s['.name']; });
 let sources = {};
 try { sources = json(readfile(replace(filename, /\.json$/, '.sources'))) || {}; } catch (e) {}
 const service = connect().call('service', 'list', { name: 'homeproxy' });
 const outboundTags = map(config?.outbounds || [], (o) => o.tag);
 const udpOutbound = 'main-udp-out' in outboundTags ? 'main-udp-out' :
  'main-out' in outboundTags ? 'main-out' : config?.route?.final;
 return {
  expected: compat.core_version, version: actual || 'unavailable', compatible: actual === compat.core_version,
  build: version.stdout, running: service?.homeproxy?.instances?.[instance === 'client' ? 'sing-box-c' : 'sing-box-s']?.running || false,
  api: api ? { enabled: true, listen: api.listen, port: api.listen_port, tls: !!api.tls?.enabled, dashboard: !!api.dashboard?.enabled } : { enabled: false },
  api_version: compat.api_version, dashboard_installed: access('/usr/share/homeproxy/dashboard/index.html'),
  dashboard_version: trim(readfile('/usr/share/homeproxy/dashboard/VERSION') || ''),
  udp_outbound: udpOutbound,
  names, sources
 };
};

function targetParts(target) {
 if (type(target) !== 'string' || length(target) > 2048 || match(target, /[[:cntrl:][:space:]]/)) return null;
 if (!match(target, /^https?:\/\//)) target = 'https://' + target;
 const m = match(target, /^(https?):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+)(:([0-9]{1,5}))?([\/?#].*)?$/);
 if (!m || (m[4] && (int(m[4]) < 1 || int(m[4]) > 65535))) return null;
 return { url: target, host: substr(m[2], 0, 1) === '[' ? substr(m[2], 1, length(m[2]) - 2) : m[2], port: int(m[4] || (m[1] === 'https' ? 443 : 80)) };
};

/* One bounded stage per RPC. The page can cancel remaining stages immediately,
 * without occupying rpcd for a long multi-stage job. */
export function diagnose(stage, target, instance) {
 const t = targetParts(target);
 if (!t || instance !== 'client') return { status: 'error', message: 'Enter an HTTP(S) URL or hostname. Diagnostics run on the client instance.' };
 let config;
 try { config = json(readfile('/var/run/homeproxy/sing-box-c.json')); } catch (e) {}
 if (stage === 'system') {
  const state = runtime('client');
  const wan = connect().call('network.interface.wan', 'status', {});
  const route = execute(['/sbin/ip', 'route', 'show', 'default']);
  return { status: !state.compatible || !state.running ? 'fail' : !wan?.up || !trim(route.stdout) ? 'warning' : 'pass', evidence: 'observed', message: 'Core, WAN and default route', details: { version: state.version, expected: state.expected, running: state.running, wan_up: wan?.up || false, default_route: route.stdout } };
 }
 if (stage === 'config') {
  if (!config) return { status: 'fail', message: 'No generated client configuration' };
  const check = execute(['/usr/bin/sing-box', 'check', '-c', '/var/run/homeproxy/sing-box-c.json']);
  // Core messages can contain values from the configuration. Keep raw output local.
  return { status: check.code === 0 ? 'pass' : 'fail', evidence: 'observed', message: check.code === 0 ? 'Generated configuration accepted' : 'Configuration rejected; inspect the local HomeProxy log', details: { exit_code: check.code } };
 }
 const dnsStage = match(stage || '', /^dns_(system|core)_(A|AAAA|HTTPS)$/);
 if (dnsStage) {
  if (!access('/usr/bin/dig')) return { status: 'unsupported', message: 'Install bind-dig to query DNS record types' };
  const dns = filter(config?.inbounds || [], (i) => i.tag === 'dns-in')[0];
  if (dnsStage[1] === 'core' && !dns) return { status: 'skip', message: 'No core DNS listener' };
  const args = ['/usr/bin/dig', '+time=2', '+tries=1', '+noall', '+answer', '+comments', '+stats', '@127.0.0.1', '-p', '' + (dnsStage[1] === 'core' ? dns.listen_port : 53), t.host, dnsStage[2] === 'HTTPS' ? 'TYPE65' : dnsStage[2]];
  const result = execute(args, 3500);
  const rcode = match(result.stdout, /status: ([A-Z0-9]+)/)?.[1];
  return { status: result.code === 0 && rcode === 'NOERROR' ? 'pass' : 'fail', evidence: 'observed', message: dnsStage[1] + ' DNS ' + dnsStage[2] + ': ' + (rcode || 'timeout/error'), details: { rcode, duration_ms: int(match(result.stdout, /Query time: ([0-9]+)/)?.[1]), output: result.stdout || result.stderr, note: dnsStage[2] === 'HTTPS' ? 'HTTPS is DNS record type 65; a configured rejection is not a DoH transport failure.' : null } };
 }
 if (stage === 'router_http' || stage === 'proxy_http') {
  const mixed = filter(config?.inbounds || [], (i) => i.tag === 'mixed-in')[0];
  if (stage === 'proxy_http' && !mixed) return { status: 'skip', message: 'No mixed proxy listener' };
  const args = ['/usr/bin/curl', '--silent', '--show-error', '--output', '/dev/null', '--connect-timeout', '3', '--max-time', '5', '--max-redirs', '0', '--proto', '=http,https', '--write-out', '%{http_code}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}'];
  if (stage === 'proxy_http') push(args, '--noproxy', '', '--proxy', 'socks5h://127.0.0.1:' + mixed.listen_port);
  else push(args, '--noproxy', '*');
  push(args, '--url', t.url);
  const result = execute(args, 6000), values = split(trim(result.stdout), '|');
  const code = int(values[0]), status = result.code === 0 && code > 0 ? (code < 400 ? 'pass' : 'warning') : 'fail';
  const failures = { '5': 'Proxy name resolution failed', '6': 'Host resolution failed', '7': 'Connection failed', '28': 'Timeout; the last completed timing bounds the failure', '35': 'TLS handshake failed', '60': 'TLS certificate verification failed' };
  return { status, evidence: 'observed', message: result.code ? failures['' + result.code] || 'HTTP transport failed' : 'HTTP ' + code, details: { exit_code: result.code, http_status: code, dns_seconds: values[1], connect_seconds: values[2], tls_seconds: values[3], first_byte_seconds: values[4], total_seconds: values[5], note: stage === 'router_http' ? 'Router-originated traffic follows current firewall policy; this is not proof of a direct WAN path.' : 'Explicit SOCKS5 path; this does not verify LAN transparent interception.' } };
 }
 if (stage === 'routing') {
  const rules = execute(['/sbin/ip', 'rule', 'show']);
  const nft = execute(['/usr/sbin/nft', 'list', 'chain', 'inet', 'fw4', 'homeproxy_redirect']);
  return { status: 'info', evidence: 'configuration', message: 'Routing context; actual rule matches are available in API connections/logs', details: { policy_rules: rules.stdout, redirect_chain: nft.stdout, dns: map(config?.dns?.servers || [], (d) => ({ tag: d.tag, type: d.type, server: d.server, detour: d.detour, domain_resolver: d.domain_resolver })), default_outbound: config?.route?.final, note: 'No LAN device probe was performed. Aggregate counters cannot identify one request.' } };
 }
 return { status: 'error', message: 'Unknown diagnostic stage' };
};

export function apiSecret() {
 return { secret: trim(readfile('/etc/homeproxy/api.secret') || '') };
};
