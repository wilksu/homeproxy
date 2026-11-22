#!/usr/bin/ucode
/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Copyright (C) 2023 ImmortalWrt.org
 */

'use strict';

import { md5 } from 'digest';
import { importNodes, nodeID, subscriptionDocument } from 'node_import';
import { open } from 'fs';
import { connect } from 'ubus';
import { cursor } from 'uci';
import { nodeModel } from 'node_model';

import { parseShareLink } from 'share_links';

import {
	executeCommand, shellQuote, decodeBase64Str, getTime, isEmpty,
	RUN_DIR
} from 'homeproxy';

function uniqueSubscriptionURLs(urls) {
	const seen = {}, result = [];
	for (let raw in urls || []) {
		const clean = replace(raw, /#.*$/, '');
		if (seen[clean])
			continue;
		seen[clean] = true;
		push(result, raw);
	}
	return result;
}

/* UCI config start */
const uciconfig = 'homeproxy';
const configDir = getenv('HP_UCI_CONF_DIR');
if (!configDir || configDir === '/etc/config') die('Use subscription-transaction.sh to update HomeProxy');
const uci = cursor(configDir, getenv('HP_UCI_SAVE_DIR'));
uci.load(uciconfig);

const ucimain = 'config',
      ucinode = 'node',
      ucisubscription = 'subscription';

const allow_insecure = uci.get(uciconfig, ucisubscription, 'allow_insecure') || '0',
      filter_mode = uci.get(uciconfig, ucisubscription, 'filter_nodes') || 'disabled',
      filter_keywords = uci.get(uciconfig, ucisubscription, 'filter_keywords') || [],
      packet_encoding = uci.get(uciconfig, ucisubscription, 'packet_encoding') || 'xudp',
      configured_subscription_urls = uniqueSubscriptionURLs(uci.get(uciconfig, ucisubscription, 'subscription_url') || []),
      user_agent = uci.get(uciconfig, ucisubscription, 'user_agent'),
      via_proxy = uci.get(uciconfig, ucisubscription, 'update_via_proxy') || '0';
const requested_source = (length(ARGV || []) ? ARGV[0] : null) || getenv('HP_SUBSCRIPTION_SOURCE');
const requested_hash = requested_source ? replace(requested_source, /^src_/, '') : null;
const subscription_urls = requested_hash ? filter(configured_subscription_urls, candidate => {
	return md5(replace(candidate, /#.*$/, '')) === requested_hash;
}) : configured_subscription_urls;

const routing_mode = uci.get(uciconfig, ucimain, 'routing_mode') || 'bypass_mainland_china';
let main_node, main_udp_node;
if (routing_mode !== 'custom') {
	main_node = uci.get(uciconfig, ucimain, 'main_node') || 'nil';
	main_udp_node = uci.get(uciconfig, ucimain, 'main_udp_node') || 'nil';
}
/* UCI config end */

/* String helper start */
function filter_check(name, patterns) {
	if (isEmpty(name) || !length(patterns))
		return false;

	for (let pattern in patterns)
		if (match(name, pattern)) return filter_mode !== 'whitelist';
	return filter_mode === 'whitelist';
}
/* String helper end */

/* Common var start */
const node_cache = {},
      node_result = [],
      removed_by_source = {};
const dialOptions = ['node_detour', 'node_bind_interface', 'node_domain_resolver', 'node_domain_strategy'];

const ubus = connect();
const sing_features = ubus.call('luci.homeproxy', 'singbox_get_features', {}) || {};
/* Common var end */

/* Log */
system(`mkdir -p ${RUN_DIR}`);
function log(...args) {
	const logfile = open(`${RUN_DIR}/homeproxy.log`, 'a');
	logfile.write(`${getTime()} [SUBSCRIBE] ${join(' ', args)}\n`);
	logfile.close();
}

/* Keep existing IDs for configurations migrated from subscription_source.
 * Native tags (or unique share-link labels) are stable within a feed. */
function preserveIDs(nodes, previousNodes) {
	const old = {}, incoming = {}, rename = {};
	const identity = node => node.source_tag ? 'tag:' + node.source_tag : 'label:' + node.label;
	for (let cfg in previousNodes) {
		const key = identity(cfg);
		old[key] = key in old ? null : cfg['.name'];
	}
	for (let node in nodes) {
		const key = identity(node);
		incoming[key] = (incoming[key] || 0) + 1;
	}
	for (let node in nodes) {
		const key = identity(node), id = old[key];
		if (id && incoming[key] === 1 && node.node_id !== id) rename[node.node_id] = id;
	}
	for (let node in nodes) {
		node.node_id = rename[node.node_id] || node.node_id;
		if (node.group_nodes) node.group_nodes = map(node.group_nodes, id => rename[id] || id);
		for (let field in ['group_default', 'node_detour'])
			if (rename[node[field]]) node[field] = rename[node[field]];
	}
}

function rememberDialDefaults(node) {
	const defaults = {};
	for (let key in dialOptions)
		if (key in node) defaults[key] = node[key];
	node.source_dial_options = sprintf('%J', defaults);
}

function preserveLocalDialOptions(previous, incoming) {
	let defaults;
	try { defaults = json(previous.source_dial_options); } catch (e) {}
	for (let key in dialOptions) {
		// Older nodes lack provenance. Preserve their effective dial settings
		// on the first refresh, then compare against the saved feed defaults.
		if (type(defaults) !== 'object' ? !previous[key] : previous[key] === defaults[key]) continue;
		if (previous[key]) incoming[key] = previous[key];
		else delete incoming[key];
	}
}

function externalReferences(ids, groupHash) {
	const removing = {};
	for (let id in ids) removing[id] = true;
	const fields = {
		homeproxy: ['main_node','main_udp_node','main_urltest_nodes','main_udp_urltest_nodes','default_outbound'],
		node: ['group_nodes','group_default','node_detour'],
		routing_node: ['node','outbound','urltest_nodes'],
		routing_rule: ['outbound'], dns_server: ['outbound'], dns_rule: ['outbound'], ruleset: ['outbound']
	};
	const references = [];
	for (let sectionType in keys(fields)) uci.foreach(uciconfig, sectionType, cfg => {
		if (removing[cfg['.name']]) return;
		if (cfg['.type'] === 'node' && cfg.grouphash === groupHash) return;
		for (let field in fields[sectionType]) {
			const value = cfg[field];
			for (let id in type(value) === 'array' ? value : [value])
				if (removing[id]) push(references, sprintf('%s.%s -> %s', cfg.label || cfg['.name'], field, id));
		}
	});
	return references;
}

function main() {
	const patterns = filter_mode === 'disabled' ? [] : map(filter_keywords, keyword => regexp(keyword));
	const previous = {};
	uci.foreach(uciconfig, ucinode, cfg => {
		if (!cfg.grouphash) return;
		previous[cfg.grouphash] ??= [];
		push(previous[cfg.grouphash], cfg);
	});
	for (let url in subscription_urls) {
		url = replace(url, /#.*$/, '');
		const groupHash = md5(url);

		node_cache[groupHash] = {};

		const proxyArgs = via_proxy === '1' ? ['--noproxy', '', '--socks5-hostname', '127.0.0.1:' + (uci.get(uciconfig, 'infra', 'mixed_port') || '5330')] : ['--noproxy', '*'];
		const fetched = executeCommand(join(' ', map(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=http,https', '--proto-redir', '=http,https', '--max-time', '30', '--write-out', '\n%{http_code}', '--user-agent', user_agent || 'HomeProxy', ...proxyArgs, url], shellQuote)));
		const status = match(fetched.stdout || '', /\n([0-9]{3})$/)?.[1] || '000';
		if (fetched.truncated) {
			log(sprintf('Subscription %s rejected: download exceeds the 512 KiB output limit; existing nodes are unchanged.', groupHash));
			continue;
		}
		const res = fetched.exitcode === 0 && match(status, /^2[0-9]{2}$/) ? trim(replace(fetched.stdout || '', /\n[0-9]{3}$/, '')) : null;
		if (isEmpty(res)) {
			const detail = replace(trim(fetched.stderr || ''), /https?:\/\/[^ ]+/g, '<subscription-url>');
			log(sprintf('Failed to fetch subscription %s: curl exit %d, HTTP %s%s.', groupHash, fetched.exitcode, status, detail ? ', ' + detail : ''));
			continue;
		}

		let parsed = [];
		try {
			const document = subscriptionDocument(res);
			if (document?.outbounds || document?.endpoints) {
				const ignored = {};
				parsed = importNodes(document, groupHash, field => { ignored[field] = true; });
				if (length(keys(ignored)))
					log('Subscription ' + groupHash + ': skipped unsupported fields: ' + join(', ', sort(keys(ignored))));
			} else {
				let nodes = document ? document.servers || document : split(trim(decodeBase64Str(res) || res), '\n');
				if (type(nodes) !== 'array') die('Unsupported subscription format');
				for (let item in nodes) {
					if (type(item) === 'object' && item.server && item.method) item.nodetype = 'sip008';
					const n = parseShareLink(item, sing_features);
					if (n) push(parsed, n);
				}
				const counts = {};
				for (let n in parsed) counts[n.label] = (counts[n.label] || 0) + 1;
				for (let n in parsed) n.node_id = nodeID(groupHash, counts[n.label] > 1 ? n.label + '\n' + md5(sprintf('%J', n)) : n.label);
			}
		} catch (e) {
			log('Subscription ' + groupHash + ' rejected: ' + e);
			continue;
		}
		const previousNodes = previous[groupHash] || [];
		preserveIDs(parsed, previousNodes);

		const accepted = [];
		for (let node in parsed) {
			if (filter_check(node.label, patterns)) continue;
			if (node_cache[groupHash][node.node_id]) continue;
			if (node.tls === '1' && allow_insecure === '1') node.tls_insecure = '1';
			// Native imports retain their explicit packet encoding.
			if (!node.source_tag && node.type in ['vless', 'vmess']) node.packet_encoding = packet_encoding;
			node.grouphash = groupHash;
			rememberDialDefaults(node);
			node_cache[groupHash][node.node_id] = node;
			push(accepted, node);
		}
		// Filtering must not silently create dangling selector or detour references.
		let broken = false;
		for (let n in accepted)
			for (let ref in [...(n.group_nodes || []), ...(n.node_detour ? [n.node_detour] : [])])
				if (!node_cache[groupHash][ref]) broken = true;
		if (broken) {
			node_cache[groupHash] = {};
			log('Subscription ' + groupHash + ' rejected: filtering removed a referenced node');
			continue;
		}
		const fresh = {};
		for (let n in accepted) fresh[n.node_id] = true;
		const removing = [], removingSet = {};
		for (let cfg in previousNodes) {
			if (!fresh[cfg['.name']]) {
				push(removing, cfg['.name']);
				removingSet[cfg['.name']] = true;
			}
		}
		const references = length(removing) ? externalReferences(removing, groupHash) : [];
		if (length(references)) {
			node_cache[groupHash] = {};
			log(sprintf('Subscription %s rejected: removed nodes are still referenced: %s', groupHash, join('; ', references)));
			continue;
		}
		removed_by_source[groupHash] = removingSet;
		push(node_result, accepted);
		log(sprintf('Subscription %s: parsed %d node/group objects', groupHash, length(accepted)));
	}

	if (isEmpty(node_result) || !length(filter(node_result, n => length(n)))) {
		log('Failed to update subscriptions: no valid node found.');
		return false;
	}

	let added = 0, removed = 0, changed = false;
	const existing = {};
	uci.foreach(uciconfig, ucinode, (cfg) => {
		/* Nodes created by the user */
		if (!cfg.grouphash)
			return null;

		/* Empty object - failed to fetch nodes */
		if (!node_cache[cfg.grouphash] || length(node_cache[cfg.grouphash]) === 0)
			return null;

		if (!node_cache[cfg.grouphash][cfg['.name']]) {
			uci.delete(uciconfig, cfg['.name']);
			removed++;
			changed = true;
			log(sprintf('Removing node: %s.', cfg.label || cfg['.name']));
		} else {
			const fresh = node_cache[cfg.grouphash][cfg['.name']];
			const removedSet = removed_by_source[cfg.grouphash] || {};
			preserveLocalDialOptions(cfg, fresh);
			if (removedSet[fresh.node_detour])
				die(sprintf('Node %s uses an upstream removed by the subscription. Update its upstream and retry.', cfg.label || cfg['.name']));
			for (let key in keys(cfg))
				if (substr(key, 0, 1) !== '.' && !(key in fresh)) {
					uci.delete(uciconfig, cfg['.name'], key);
					changed = true;
				}
			for (let key in keys(fresh))
				if (sprintf('%J', cfg[key]) !== sprintf('%J', fresh[key])) {
					uci.set(uciconfig, cfg['.name'], key, fresh[key]);
					changed = true;
				}

			existing[cfg['.name']] = true;
		}
	});
	for (let nodes in node_result)
		map(nodes, (node) => {
			if (existing[node.node_id])
				return null;

			const nameHash = node.node_id;
			uci.set(uciconfig, nameHash, 'node');
			map(keys(node), (v) => uci.set(uciconfig, nameHash, v, node[v]));

			added++;
			changed = true;
			log(sprintf('Adding node: %s.', node.label));
		});

	if (!isEmpty(main_node) && main_node !== 'nil') {
		const first_server = uci.get_first(uciconfig, ucinode);
		if (first_server) {
			let main_urltest_nodes;
			if (main_node === 'urltest') {
				const prev = uci.get(uciconfig, ucimain, 'main_urltest_nodes') || [];
				main_urltest_nodes = filter(prev, (v) => {
					if (!uci.get(uciconfig, v)) {
						log(sprintf('Node %s is gone, removing from urltest list.', v));
						return false;
					}
					return true;
				});
				if (length(main_urltest_nodes) !== length(prev)) {
					uci.set(uciconfig, ucimain, 'main_urltest_nodes', main_urltest_nodes);
					changed = true;
				}
			}

			if ((main_node === 'urltest') ? !length(main_urltest_nodes) : !uci.get(uciconfig, main_node)) {
				uci.set(uciconfig, ucimain, 'main_node', first_server);
				changed = true;
				log('Main node is gone, switching to the first node.');
			}

			if (!isEmpty(main_udp_node) && main_udp_node !== 'same' && main_udp_node !== 'nil') {
				let main_udp_urltest_nodes;
				if (main_udp_node === 'urltest') {
					const prev = uci.get(uciconfig, ucimain, 'main_udp_urltest_nodes') || [];
					main_udp_urltest_nodes = filter(prev, (v) => {
						if (!uci.get(uciconfig, v)) {
							log(sprintf('Node %s is gone, removing from urltest list.', v));
							return false;
						}
						return true;
					});
					if (length(main_udp_urltest_nodes) !== length(prev)) {
						uci.set(uciconfig, ucimain, 'main_udp_urltest_nodes', main_udp_urltest_nodes);
						changed = true;
					}
				}

				if ((main_udp_node === 'urltest') ? !length(main_udp_urltest_nodes) : !uci.get(uciconfig, main_udp_node)) {
					uci.set(uciconfig, ucimain, 'main_udp_node', first_server);
					changed = true;
					log('Main UDP node is gone, switching to the first node.');
				}
			}
		} else {
			uci.set(uciconfig, ucimain, 'main_node', 'nil');
			uci.set(uciconfig, ucimain, 'main_udp_node', 'nil');
			changed = true;
			log('No available node, disable tproxy.');
		}
	}

	if (changed) {
		const model = nodeModel(uci);
		for (let nodes in node_result)
			for (let node in nodes) model.validate(node.node_id);
		if (!uci.commit(uciconfig)) die('Unable to commit subscription candidate');
		log(sprintf('%s nodes added, %s removed.', added, removed));
		return 'changed';
	}
	log('Subscription configuration unchanged.');
	return 'unchanged';
}

try {
	if (requested_source && isEmpty(subscription_urls)) die('Requested subscription source was not found');
	if (!isEmpty(subscription_urls) && main() === false) exit(1);
} catch (e) {
	log('[FATAL ERROR] Subscription update failed: ' + e);
	exit(1);
}
