/* SPDX-License-Identifier: GPL-2.0-only */
/* Helpers shared by both generators. UCI remains the source of truth. */
import { readfile, writefile, access } from 'fs';
import { strToInt } from 'homeproxy';

export function apiService(uci, instance, lanAddress) {
	const cfg = uci.get_all('homeproxy', 'observability') || {};
	const external = cfg.external === '1';
	const secret = trim(readfile('/etc/homeproxy/api.secret') || '');
	if (!match(secret, /^[a-f0-9]{64}$/))
		die('HomeProxy API secret is missing; run /etc/homeproxy/scripts/prepare.sh.');
	const port = int(cfg[instance + '_port'] || (instance === 'client' ? '5334' : '5335'));
	if (port < 1 || port > 65535)
		die('Invalid HomeProxy API port.');
	if (int(cfg.client_port || '5334') === int(cfg.server_port || '5335'))
		die('Client and server API ports must differ.');
	if (external && !!cfg.tls_cert !== !!cfg.tls_key)
		die('API TLS requires both a certificate and a private key.');
	let tls;
	if (external && cfg.tls_cert) {
		const certificate = readfile(cfg.tls_cert), key = readfile(cfg.tls_key);
		if (!certificate || !key) die('Unable to read API TLS certificate or private key.');
		/* The generated configuration is private and owned by sing-box. Inline
		 * PEM also works in ujail when the source key is root-only. */
		tls = { enabled: true, certificate: [certificate], key: [key] };
	}
	return {
		type: 'api', tag: 'homeproxy-api',
		listen: external ? cfg.listen || lanAddress || '127.0.0.1' : '127.0.0.1',
		listen_port: port,
		secret,
		access_control_allow_origin: external ? cfg.allowed_origins || [] : [],
		dashboard: false,
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
 * prefer_* ordering belongs to the global/dial resolver strategy in 1.14.
 * Keep a source identifier outside the strict core JSON for diagnostics. */
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

/* Only metadata is written here: never copy configuration values or credentials. */
export function sourceMap(config, uci, filename, hints) {
	const paths = {}, tags = {};
	for (let path in keys(hints || {})) {
		const section = hints[path];
		paths[path] = { section, label: uci.get('homeproxy', section, 'label') || section };
	}
	for (let collection in ['inbounds', 'outbounds', 'endpoints', 'dns.servers', 'route.rule_set']) {
		const parts = split(collection, '.');
		const items = length(parts) === 1 ? config[parts[0]] : config[parts[0]]?.[parts[1]];
		for (let i = 0; i < length(items || []); i++) {
			const tag = items[i].tag, section = match(tag || '', /^cfg-(.+)-(out|in|dns|rule)$/)?.[1];
			if (!section) continue;
			const value = { section, label: uci.get('homeproxy', section, 'label') || section };
			paths[collection + '[' + i + ']'] = value;
			tags[tag] = value;
		}
	}
	if (!writefile(filename, sprintf('%.J\n', { schema: 1, paths, tags })))
		die('Unable to write HomeProxy configuration source map.');
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
