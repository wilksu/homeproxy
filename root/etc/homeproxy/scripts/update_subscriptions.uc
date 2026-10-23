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
const requested_arg = length(ARGV || []) ? ARGV[0] : null;
if (!getenv('HP_SUBSCRIPTION_STAGED'))
	exit(system(['/bin/sh', '/etc/homeproxy/scripts/subscription-transaction.sh', ...(requested_arg ? [requested_arg] : [])]));
const uci = cursor(getenv('HP_UCI_CONF_DIR'), getenv('HP_UCI_SAVE_DIR'));

const uciconfig = 'homeproxy';
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
const requested_source = getenv('HP_SUBSCRIPTION_SOURCE');
const subscription_urls = requested_source ? filter(configured_subscription_urls, candidate => {
	const clean = replace(candidate, /#.*$/, '');
	let id;
	uci.foreach(uciconfig, 'subscription_source', source => { if (source.url === clean) id = source['.name']; });
	return (id || 'src_' + md5(clean)) === requested_source;
}) : configured_subscription_urls;

const routing_mode = uci.get(uciconfig, ucimain, 'routing_mode') || 'bypass_mainland_china';
let main_node, main_udp_node;
if (routing_mode !== 'custom') {
	main_node = uci.get(uciconfig, ucimain, 'main_node') || 'nil';
	main_udp_node = uci.get(uciconfig, ucimain, 'main_udp_node') || 'nil';
}
/* UCI config end */

/* String helper start */
function filter_check(name) {
	if (isEmpty(name) || filter_mode === 'disabled' || isEmpty(filter_keywords))
		return false;

	let ret = false;
	for (let i in filter_keywords) {
		const patten = regexp(i);
		if (match(name, patten))
			ret = true;
	}
	if (filter_mode === 'whitelist')
		ret = !ret;

	return ret;
}
/* String helper end */

/* Common var start */
const node_cache = {},
      node_result = [];

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

if (requested_source && isEmpty(subscription_urls)) {
	log(sprintf('Requested subscription source %s was not found.', requested_source));
	exit(1);
}

function externalReferences(ids, sourceID, groupHash) {
	const removing = {};
	for (let id in ids) removing[id] = true;
	const fields = {
		homeproxy: ['main_node','main_udp_node','main_urltest_nodes','main_udp_urltest_nodes','default_outbound'],
		node: ['group_nodes','group_default','node_detour','local_detour','node_base'],
		routing_node: ['node','outbound','urltest_nodes'],
		routing_rule: ['outbound'], dns_server: ['outbound'], dns_rule: ['outbound'], ruleset: ['outbound']
	};
	const references = [];
	for (let sectionType in keys(fields)) uci.foreach(uciconfig, sectionType, cfg => {
		if (removing[cfg['.name']]) return;
		const sameSource = cfg['.type'] === 'node' && (cfg.source_id === sourceID || (!cfg.source_id && cfg.grouphash === groupHash));
		const checkedFields = sameSource ? ['local_detour'] : fields[sectionType];
		for (let field in checkedFields) {
			const value = cfg[field];
			for (let id in type(value) === 'array' ? value : [value])
				if (removing[id]) push(references, sprintf('%s.%s -> %s', cfg.label || cfg['.name'], field, id));
		}
	});
	return references;
}

function main() {

	for (let url in subscription_urls) {
		url = replace(url, /#.*$/, '');
		const groupHash = md5(url);
		let sourceID;
		uci.foreach(uciconfig,'subscription_source',s=>{if(s.url===url)sourceID=s['.name'];});
		if(!sourceID){sourceID='src_'+groupHash;while(uci.get(uciconfig,sourceID))sourceID='src_'+md5(sourceID);uci.set(uciconfig,sourceID,'subscription_source');uci.set(uciconfig,sourceID,'url',url);}

		node_cache[groupHash] = {};
		node_cache[sourceID] = node_cache[groupHash];

		const proxyArgs = via_proxy === '1' ? ['--noproxy', '', '--socks5-hostname', '127.0.0.1:' + (uci.get(uciconfig, 'infra', 'mixed_port') || '5330')] : ['--noproxy', '*'];
		const fetched = executeCommand(join(' ', map(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=http,https', '--proto-redir', '=http,https', '--max-time', '30', '--write-out', '\n%{http_code}', '--user-agent', user_agent || 'HomeProxy', ...proxyArgs, url], shellQuote)));
		const status = match(fetched.stdout || '', /\n([0-9]{3})$/)?.[1] || '000';
		if (fetched.truncated) {
			log(sprintf('Subscription %s rejected: download exceeds the 512 KiB output limit; existing nodes are unchanged.', sourceID));
			continue;
		}
		const res = fetched.exitcode === 0 && match(status, /^2[0-9]{2}$/) ? trim(replace(fetched.stdout || '', /\n[0-9]{3}$/, '')) : null;
		if (isEmpty(res)) {
			const detail = replace(trim(fetched.stderr || ''), /https?:\/\/[^ ]+/g, '<subscription-url>');
			log(sprintf('Failed to fetch subscription %s: curl exit %d, HTTP %s%s.', sourceID, fetched.exitcode, status, detail ? ', ' + detail : ''));
			continue;
		}

		let parsed=[];
		try {
			const document = subscriptionDocument(res);
			if(document?.outbounds || document?.endpoints) parsed=importNodes(document,sourceID);
			else {
				let nodes=document ? document.servers || document : split(trim(decodeBase64Str(res) || res),'\n');
				if(type(nodes)!=='array')die('Unsupported subscription format');
				for(let item in nodes){if(type(item)==='object' && item.server && item.method)item.nodetype='sip008';const n=parseShareLink(item, sing_features);if(n)push(parsed,n);}
				const counts={};for(let n in parsed)counts[n.label]=(counts[n.label] || 0)+1;
				for(let n in parsed)n.node_id=nodeID(sourceID,counts[n.label]>1 ? n.label+'\n'+md5(sprintf('%J',n)) : n.label);
			}
		} catch(e) { log('Subscription '+sourceID+' rejected: '+e); continue; }
		const accepted=[];
		for(let node in parsed){
			if(filter_check(node.label))continue;
			if(node_cache[groupHash][node.node_id])continue;
			if(node.tls==='1' && allow_insecure==='1')node.tls_insecure='1';
			// Native imports retain their explicit packet encoding.
			if(!node.source_tag && node.type in ['vless','vmess'])node.packet_encoding=packet_encoding;
			node.grouphash=groupHash;node.source_id=sourceID;
			node_cache[groupHash][node.node_id]=node;push(accepted,node);
		}
		// Filtering must not silently create dangling selector or detour references.
		let broken=false;
		for(let n in accepted)for(let ref in [...(n.group_nodes || []),...(n.node_detour?[n.node_detour]:[])])if(!node_cache[groupHash][ref])broken=true;
		if(broken){node_cache[groupHash]={};node_cache[sourceID]=node_cache[groupHash];log('Subscription '+sourceID+' rejected: filtering removed a referenced node');continue;}
		const fresh={};for(let n in accepted)fresh[n.node_id]=true;
		const removing=[];
		uci.foreach(uciconfig, ucinode, cfg=>{
			if((cfg.source_id===sourceID || (!cfg.source_id && cfg.grouphash===groupHash)) && !fresh[cfg['.name']])push(removing,cfg['.name']);
		});
		const references=externalReferences(removing,sourceID,groupHash);
		if(length(references)){
			node_cache[groupHash]={};node_cache[sourceID]=node_cache[groupHash];
			log(sprintf('Subscription %s rejected: removed nodes are still referenced: %s',sourceID,join('; ',references)));
			continue;
		}
		node_cache[sourceID]=node_cache[groupHash];
		push(node_result,accepted);
		log(sprintf('Subscription %s: parsed %d node/group objects',sourceID,length(accepted)));

	}

	if (isEmpty(node_result) || !length(filter(node_result,n=>length(n)))) {
		log('Failed to update subscriptions: no valid node found.');

		return false;
	}

	let added = 0, removed = 0;
	uci.foreach(uciconfig, ucinode, (cfg) => {
		/* Nodes created by the user */
		if (!cfg.grouphash)
			return null;

		/* Empty object - failed to fetch nodes */
		if (!node_cache[cfg.source_id || cfg.grouphash] || length(node_cache[cfg.source_id || cfg.grouphash]) === 0)
			return null;

		if (!node_cache[cfg.source_id || cfg.grouphash] || !node_cache[cfg.source_id || cfg.grouphash][cfg['.name']]) {
			uci.delete(uciconfig, cfg['.name']);
			removed++;

			log(sprintf('Removing node: %s.', cfg.label || cfg['name']));
		} else {
			const fresh=node_cache[cfg.source_id || cfg.grouphash][cfg['.name']];
			for(let key in ['local_detour','local_bind_interface','local_domain_resolver','local_domain_strategy'])if(cfg[key])fresh[key]=cfg[key];
			for(let key in keys(cfg))if(substr(key,0,1)!=='.' && !(key in fresh))uci.delete(uciconfig,cfg['.name'],key);
			for(let key in keys(fresh))uci.set(uciconfig,cfg['.name'],key,fresh[key]);

			node_cache[cfg.source_id || cfg.grouphash][cfg['.name']].isExisting = true;
		}
	});
	for (let nodes in node_result)
		map(nodes, (node) => {
			if (node.isExisting)
				return null;

			const nameHash = node.node_id;
			uci.set(uciconfig, nameHash, 'node');
			map(keys(node), (v) => uci.set(uciconfig, nameHash, v, node[v]));

			added++;
			log(sprintf('Adding node: %s.', node.label));
		});

	if (!isEmpty(main_node) && main_node !== 'nil') {
		const first_server = uci.get_first(uciconfig, ucinode);
		if (first_server) {
			let main_urltest_nodes;
			if (main_node === 'urltest') {
				main_urltest_nodes = filter(uci.get(uciconfig, ucimain, 'main_urltest_nodes') || [], (v) => {
					if (!uci.get(uciconfig, v)) {
						log(sprintf('Node %s is gone, removing from urltest list.', v));
						return false;
					}
					return true;
				});
				uci.set(uciconfig, ucimain, 'main_urltest_nodes', main_urltest_nodes);
			}

			if ((main_node === 'urltest') ? !length(main_urltest_nodes) : !uci.get(uciconfig, main_node)) {
				uci.set(uciconfig, ucimain, 'main_node', first_server);

				log('Main node is gone, switching to the first node.');
			}

			if (!isEmpty(main_udp_node) && main_udp_node !== 'same' && main_udp_node !== 'nil') {
				let main_udp_urltest_nodes;
				if (main_udp_node === 'urltest') {
					main_udp_urltest_nodes = filter(uci.get(uciconfig, ucimain, 'main_udp_urltest_nodes') || [], (v) => {
						if (!uci.get(uciconfig, v)) {
							log(sprintf('Node %s is gone, removing from urltest list.', v));
							return false;
						}
						return true;
					});
					uci.set(uciconfig, ucimain, 'main_udp_urltest_nodes', main_udp_urltest_nodes);
				}

				if ((main_udp_node === 'urltest') ? !length(main_udp_urltest_nodes) : !uci.get(uciconfig, main_udp_node)) {
					uci.set(uciconfig, ucimain, 'main_udp_node', first_server);

					log('Main UDP node is gone, switching to the first node.');
				}
			}
		} else {
			uci.set(uciconfig, ucimain, 'main_node', 'nil');
			uci.set(uciconfig, ucimain, 'main_udp_node', 'nil');

			log('No available node, disable tproxy.');
		}
	}

	uci.commit(uciconfig);
	log(sprintf('%s nodes added, %s removed.', added, removed));
	log('Subscription candidate prepared; awaiting validation.');
}

if (!isEmpty(subscription_urls))
	try { if (call(main) === false) exit(1); }
	catch(e) { log('[FATAL ERROR] Subscription update failed: '+e); exit(1); }
