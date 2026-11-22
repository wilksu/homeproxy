/* SPDX-License-Identifier: GPL-2.0-only */
/* Helpers shared by both generators. UCI remains the source of truth. */
import { readfile } from 'fs';
import { strToInt } from 'homeproxy';

function apiSecret() {
	const secret = trim(readfile('/etc/homeproxy/api.secret') || '');
	if (!match(secret, /^[a-f0-9]{64}$/))
		die('HomeProxy API secret is missing; run /etc/homeproxy/scripts/prepare.sh.');
	return secret;
}

function apiHost(cfg, lanAddress) {
	const host = cfg.external === '1' ? (cfg.listen || lanAddress) : '127.0.0.1';
	if (!host || host in ['0.0.0.0', '::', '[::]'])
		die('Set a LAN address for external HomeProxy API access.');
	return replace(host, /^\[|\]$/g, '');
}

function apiOrigins(cfg, fallback) {
	if (cfg.external !== '1')
		return null;
	const origins = cfg.allowed_origins || [fallback];
	return type(origins) === 'array' ? origins : [origins];
}

export function clashApi(uci, instance, lanAddress) {
	const cfg = uci.get_all('homeproxy', 'observability') || {};
	if (cfg.enabled === '0')
		return null;
	const clientPort = int(cfg.client_port || '5334');
	const serverPort = int(cfg.server_port || '5335');
	const port = instance === 'client' ? clientPort : serverPort;
	if (!(port >= 1 && port <= 65535))
		die('Invalid HomeProxy API port.');
	if (clientPort === serverPort)
		die('Client and server API ports must differ.');
	let host = apiHost(cfg, lanAddress);
	if (index(host, ':') >= 0)
		host = '[' + host + ']';
	return {
		external_controller: host + ':' + port,
		secret: apiSecret(),
		access_control_allow_origin: apiOrigins(cfg, 'https://metacubex.github.io'),
		access_control_allow_private_network: cfg.external === '1' ? true : null
	};
};

export function nativeApi(uci, instance, lanAddress) {
	const cfg = uci.get_all('homeproxy', 'observability') || {};
	if (cfg.native_api !== '1')
		return null;
	const port = int(cfg['native_' + instance + '_port'] || (instance === 'client' ? '5336' : '5337'));
	if (!(port >= 1 && port <= 65535))
		die('Invalid sing-box gRPC API port.');
	let tls;
	if (cfg.native_tls_cert || cfg.native_tls_key) {
		if (!cfg.native_tls_cert || !cfg.native_tls_key)
			die('The sing-box gRPC API requires both a TLS certificate and a private key.');
		const certificate = readfile(cfg.native_tls_cert), key = readfile(cfg.native_tls_key);
		if (!certificate || !key) die('Unable to read the sing-box gRPC API TLS certificate or private key.');
		// The generated config is private and PEM works inside ujail.
		tls = { enabled: true, certificate: [certificate], key: [key] };
	}
	let dashboard = false;
	if (cfg.external === '1' && cfg.native_dashboard === '1') {
		const compat = json(readfile('/usr/share/homeproxy/compat.json'));
		dashboard = {
			enabled: true,
			path: '/etc/homeproxy/dashboard/' + instance,
			download_url: 'https://github.com/SagerNet/sing-box-dashboard/archive/' + compat.dashboard_commit + '.zip',
			http_client: instance === 'client' ? 'hp-dashboard-http' : 'hp-direct-http'
		};
	}
	return {
		type: 'api', tag: 'homeproxy-grpc',
		listen: apiHost(cfg, lanAddress), listen_port: port,
		secret: apiSecret(),
		access_control_allow_origin: apiOrigins(cfg, 'https://sing-box-dashboard.sagernet.org'),
		access_control_allow_private_network: cfg.external === '1' ? true : null,
		dashboard,
		tls
	};
};

export function natOptions(cfg) {
	return {
		udp_mapping: cfg.udp_mapping || 'endpoint_independent',
		udp_filtering: cfg.udp_filtering || 'endpoint_independent',
		udp_nat_max: strToInt(cfg.udp_nat_max)
	};
};

/* A named HTTP client preserves each rule-set's download detour explicitly. */
export function httpClients(config) {
	config.http_clients = [{ tag: 'hp-direct-http' }];
	const tags = {};
	for (let rule in config.route?.rule_set || []) {
		if (rule.type !== 'remote')
			continue;
		const detour = rule.download_detour || config.route.final || 'direct-out';
		if (!tags[detour]) {
			tags[detour] = 'hp-http-' + length(config.http_clients);
			push(config.http_clients, { tag: tags[detour], detour });
		}
		rule.http_client = tags[detour];
		delete rule.download_detour;
	}
};

/* Translate the old family restriction into an explicit empty DNS response.
 * prefer_* ordering belongs to the global/dial resolver strategy in 1.14. */
export function dnsRule(rules, rule, strategy) {
	if (strategy === 'ipv4_only' || strategy === 'ipv6_only') {
		const matchRule = { ...rule };
		for (let key in ['action', 'server', 'timeout', 'disable_cache', 'rewrite_ttl', 'client_subnet', 'disable_optimistic_cache'])
			delete matchRule[key];
		push(rules, {
			type: 'logical', mode: 'and',
			rules: [matchRule, { query_type: strategy === 'ipv4_only' ? 28 : 1 }],
			action: 'predefined', rcode: 'NOERROR'
		});
	}
	push(rules, rule);
};

export function certProviders(config) {
	for (let inbound in config.inbounds || []) {
		if (!inbound.tls?.acme)
			continue;
		inbound.tls.certificate_provider = {
			type: 'acme', ...inbound.tls.acme, http_client: 'hp-direct-http'
		};
		delete inbound.tls.acme;
	}
};

export function directOverrides(config) {
	for (let outbound in config.outbounds || []) {
		if (outbound.type !== 'direct' || (!outbound.override_address && !outbound.override_port))
			continue;
		if (length(filter(config.outbounds, (o) => o.detour === outbound.tag)))
			die('Direct destination override used by detour cannot be migrated automatically: ' + outbound.tag);
		const overrides = { override_address: outbound.override_address, override_port: outbound.override_port };
		let found = false;
		for (let rule in config.route.rules || []) {
			if (rule.outbound === outbound.tag) {
				for (let key in keys(overrides))
					if (!rule[key]) rule[key] = overrides[key];
				found = true;
			}
		}
		if (config.route.final === outbound.tag) {
			push(config.route.rules, { action: 'route', outbound: outbound.tag, ...overrides });
			found = true;
		}
		if (!found)
			die('Direct destination override requires an explicit routing rule: ' + outbound.tag);
		delete outbound.override_address;
		delete outbound.override_port;
	}
};
