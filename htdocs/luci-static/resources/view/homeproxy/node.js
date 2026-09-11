/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Copyright (C) 2022-2025 ImmortalWrt.org
 */

'use strict';
'require form';
'require fs';
'require uci';
'require ui';
'require view';

'require homeproxy as hp';
'require tools.widgets as widgets';

// Shared by individual deletion and subscription bulk removal.
function nodeReferences(sections, deleted) {
 const removing = new Set(deleted);
 const fields = {
  homeproxy: ['main_node','main_udp_node','main_urltest_nodes','main_udp_urltest_nodes','default_outbound'],
  node: ['group_nodes','group_default','node_detour','local_detour','node_base'],
  routing_node: ['node','outbound','urltest_nodes'],
  routing_rule: ['outbound'], dns_server: ['outbound'], dns_rule: ['outbound'], ruleset: ['outbound']
 };
 const references = [];
 for (const section of sections) {
  if (removing.has(section['.name'])) continue;
  for (const field of fields[section['.type']] || []) {
   const value = section[field];
   for (const id of Array.isArray(value) ? value : [value]) {
    if (removing.has(id)) references.push(`${section.label || section['.name']} · ${field}`);
   }
  }
 }
 return [...new Set(references)];
}

function removeNode(section_id, ev) {
	if (this.map.readonly) return;
	const references = nodeReferences(uci.sections(this.uciconfig || this.map.config), [section_id]);
	if (references.length) {
		ui.addNotification(null, E('p', {}, _('These nodes are still referenced. Update these settings before removing them:') + ' ' + references.join('; ')), 'error');
		return;
	}
	return form.GridSection.prototype.handleRemove.call(this, section_id, ev);
}

function allowInsecureConfirm(ev, _section_id, value) {
	if (value === '1' && !confirm(_('Are you sure to allow insecure?')))
		ev.target.firstElementChild.checked = null;
}

function parseShareLink(uri, features) {
	let config, url, params;

	uri = uri.split('://');
	if (uri[0] && uri[1]) {
		switch (uri[0]) {
		case 'anytls':
			/* https://github.com/anytls/anytls-go/blob/v0.0.8/docs/uri_scheme.md */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* Check if password exists */
			if (!url.username)
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'anytls',
				address: url.hostname,
				port: url.port || '80',
				password: url.username ? decodeURIComponent(url.username) : null,
				tls: '1',
				tls_sni: params.get('sni'),
				tls_insecure: (params.get('insecure') === '1') ? '1' : '0'
			};

			break;
		case 'http':
		case 'https':
			url = new URL('http://' + uri[1]);

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'http',
				address: url.hostname,
				port: url.port || '80',
				username: url.username ? decodeURIComponent(url.username) : null,
				password: url.password ? decodeURIComponent(url.password) : null,
				tls: (uri[0] === 'https') ? '1' : '0'
			};

			break;
		case 'hysteria':
			/* https://github.com/HyNetwork/hysteria/wiki/URI-Scheme */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* WeChat-Video / FakeTCP are unsupported by sing-box currently */
			if (!features.with_quic || (params.get('protocol') && params.get('protocol') !== 'udp'))
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'hysteria',
				address: url.hostname,
				port: url.port || '80',
				hysteria_protocol: params.get('protocol') || 'udp',
				hysteria_auth_type: params.get('auth') ? 'string' : null,
				hysteria_auth_payload: params.get('auth'),
				hysteria_obfs_password: params.get('obfsParam'),
				hysteria_down_mbps: params.get('downmbps'),
				hysteria_up_mbps: params.get('upmbps'),
				tls: '1',
				tls_sni: params.get('peer'),
				tls_alpn: params.get('alpn'),
				tls_insecure: (params.get('insecure') === '1') ? '1' : '0'
			};

			break;
		case 'hysteria2':
		case 'hy2':
			/* https://v2.hysteria.network/docs/developers/URI-Scheme/ */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			if (!features.with_quic)
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'hysteria2',
				address: url.hostname,
				port: url.port || '80',
				password: url.username ? (
					decodeURIComponent(url.username + (url.password ? (':' + url.password) : ''))
				) : null,
				hysteria_obfs_type: params.get('obfs'),
				hysteria_obfs_password: params.get('obfs-password'),
				tls: '1',
				tls_sni: params.get('sni'),
				tls_insecure: params.get('insecure') ? '1' : '0'
			};

			break;
		case 'socks':
		case 'socks4':
		case 'socks4a':
		case 'socks5':
		case 'socks5h':
			url = new URL('http://' + uri[1]);

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'socks',
				address: url.hostname,
				port: url.port || '80',
				username: url.username ? decodeURIComponent(url.username) : null,
				password: url.password ? decodeURIComponent(url.password) : null,
				socks_version: (uri[0].includes('4')) ? '4' : '5'
			};

			break;
		case 'ss':
			try {
				/* "Lovely" Shadowrocket format */
				try {
					let suri = uri[1].split('#'), slabel = '';
					if (suri.length <= 2) {
						if (suri.length === 2)
							slabel = '#' + suri[1];
						uri[1] = hp.decodeBase64Str(suri[0]) + slabel;
					}
				} catch(e) { }

				/* SIP002 format https://shadowsocks.org/guide/sip002.html */
				url = new URL('http://' + uri[1]);

				let userinfo;
				if (url.username && url.password) {
					/* User info encoded with URIComponent */
					userinfo = [url.username, decodeURIComponent(url.password)];
				} else if (url.username) {
					/* User info encoded with base64 */
					userinfo = hp.decodeBase64Str(decodeURIComponent(url.username)).split(':');
					if (userinfo.length > 1)
						userinfo = [userinfo[0], userinfo.slice(1).join(':')]
				}

				if (!hp.shadowsocks_encrypt_methods.includes(userinfo[0]))
					return null;

				let plugin, plugin_opts;
				if (url.search && url.searchParams.get('plugin')) {
					let plugin_info = url.searchParams.get('plugin').split(';');
					plugin = plugin_info[0];
					plugin_opts = (plugin_info.length > 1) ? plugin_info.slice(1).join(';') : null;
				}

				config = {
					label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
					type: 'shadowsocks',
					address: url.hostname,
					port: url.port || '80',
					shadowsocks_encrypt_method: userinfo[0],
					password: userinfo[1],
					shadowsocks_plugin: plugin,
					shadowsocks_plugin_opts: plugin_opts
				};
			} catch(e) {
				/* Legacy format https://github.com/shadowsocks/shadowsocks-org/commit/78ca46cd6859a4e9475953ed34a2d301454f579e */
				uri = uri[1].split('@');
				if (uri.length < 2)
					return null;
				else if (uri.length > 2)
					uri = [ uri.slice(0, -1).join('@'), uri.slice(-1).toString() ];

				config = {
					type: 'shadowsocks',
					address: uri[1].split(':')[0],
					port: uri[1].split(':')[1],
					shadowsocks_encrypt_method: uri[0].split(':')[0],
					password: uri[0].split(':').slice(1).join(':')
				};
			}

			break;
		case 'trojan':
			/* https://p4gefau1t.github.io/trojan-go/developer/url/ */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* Check if password exists */
			if (!url.username)
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'trojan',
				address: url.hostname,
				port: url.port || '80',
				password: decodeURIComponent(url.username),
				transport: params.get('type') !== 'tcp' ? params.get('type') : null,
				tls: '1',
				tls_sni: params.get('sni')
			};
			switch (params.get('type')) {
			case 'grpc':
				config.grpc_servicename = params.get('serviceName');
				break;
			case 'ws':
				config.ws_host = params.get('host') ? decodeURIComponent(params.get('host')) : null;
				config.ws_path = params.get('path') ? decodeURIComponent(params.get('path')) : null;
				if (config.ws_path && config.ws_path.includes('?ed=')) {
					config.websocket_early_data_header = 'Sec-WebSocket-Protocol';
					config.websocket_early_data = config.ws_path.split('?ed=')[1];
					config.ws_path = config.ws_path.split('?ed=')[0];
				}
				break;
			}

			break;
		case 'tuic':
			/* https://github.com/daeuniverse/dae/discussions/182 */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* Check if uuid exists */
			if (!url.username)
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'tuic',
				address: url.hostname,
				port: url.port || '80',
				uuid: url.username,
				password: url.password ? decodeURIComponent(url.password) : null,
				tuic_congestion_control: params.get('congestion_control'),
				tuic_udp_relay_mode: params.get('udp_relay_mode'),
				tls: '1',
				tls_sni: params.get('sni'),
				tls_alpn: params.get('alpn') ? decodeURIComponent(params.get('alpn')).split(',') : null
			};

			break;
		case 'vless':
			/* https://github.com/XTLS/Xray-core/discussions/716 */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* Unsupported protocol */
			if (params.get('type') === 'kcp')
				return null;
			else if (params.get('type') === 'quic' && ((params.get('quicSecurity') && params.get('quicSecurity') !== 'none') || !features.with_quic))
				return null;
			/* Check if uuid and type exist */
			if (!url.username || !params.get('type'))
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'vless',
				address: url.hostname,
				port: url.port || '80',
				uuid: url.username,
				transport: params.get('type') !== 'tcp' ? params.get('type') : null,
				tls: ['tls', 'xtls', 'reality'].includes(params.get('security')) ? '1' : '0',
				tls_sni: params.get('sni'),
				tls_alpn: params.get('alpn') ? decodeURIComponent(params.get('alpn')).split(',') : null,
				tls_reality: (params.get('security') === 'reality') ? '1' : '0',
				tls_reality_public_key: params.get('pbk') ? decodeURIComponent(params.get('pbk')) : null,
				tls_reality_short_id: params.get('sid'),
				tls_utls: features.with_utls ? params.get('fp') : null,
				vless_flow: ['tls', 'reality'].includes(params.get('security')) ? params.get('flow') : null
			};
			switch (params.get('type')) {
			case 'grpc':
				config.grpc_servicename = params.get('serviceName');
				break;
			case 'http':
			case 'tcp':
				if (config.transport === 'http' || params.get('headerType') === 'http') {
					config.http_host = params.get('host') ? decodeURIComponent(params.get('host')).split(',') : null;
					config.http_path = params.get('path') ? decodeURIComponent(params.get('path')) : null;
				}
				break;
			case 'httpupgrade':
				config.httpupgrade_host = params.get('host') ? decodeURIComponent(params.get('host')) : null;
				config.http_path = params.get('path') ? decodeURIComponent(params.get('path')) : null;
				break;
			case 'ws':
				config.ws_host = params.get('host') ? decodeURIComponent(params.get('host')) : null;
				config.ws_path = params.get('path') ? decodeURIComponent(params.get('path')) : null;
				if (config.ws_path && config.ws_path.includes('?ed=')) {
					config.websocket_early_data_header = 'Sec-WebSocket-Protocol';
					config.websocket_early_data = config.ws_path.split('?ed=')[1];
					config.ws_path = config.ws_path.split('?ed=')[0];
				}
				break;
			}

			break;
		case 'vmess':
			/* "Lovely" shadowrocket format */
			if (uri.includes('&'))
				return null;

			/* https://github.com/2dust/v2rayN/wiki/Description-of-VMess-share-link */
			uri = JSON.parse(hp.decodeBase64Str(uri[1]));

			if (uri.v != '2')
				return null;
			/* Unsupported protocols */
			else if (uri.net === 'kcp')
				return null;
			else if (uri.net === 'quic' && ((uri.type && uri.type !== 'none') || !features.with_quic))
				return null;
			/* https://www.v2fly.org/config/protocols/vmess.html#vmess-md5-%E8%AE%A4%E8%AF%81%E4%BF%A1%E6%81%AF-%E6%B7%98%E6%B1%B0%E6%9C%BA%E5%88%B6
			 * else if (uri.aid && parseInt(uri.aid) !== 0)
			 * 	return null;
			 */

			config = {
				label: uri.ps,
				type: 'vmess',
				address: uri.add,
				port: uri.port,
				uuid: uri.id,
				vmess_alterid: uri.aid,
				vmess_encrypt: uri.scy || 'auto',
				transport: (uri.net !== 'tcp') ? uri.net : null,
				tls: uri.tls === 'tls' ? '1' : '0',
				tls_sni: uri.sni || uri.host,
				tls_alpn: uri.alpn ? uri.alpn.split(',') : null,
				tls_utls: features.with_utls ? uri.fp : null
			};
			switch (uri.net) {
			case 'grpc':
				config.grpc_servicename = uri.path;
				break;
			case 'h2':
			case 'tcp':
				if (uri.net === 'h2' || uri.type === 'http') {
					config.transport = 'http';
					config.http_host = uri.host ? uri.host.split(',') : null;
					config.http_path = uri.path;
				}
				break;
			case 'httpupgrade':
				config.httpupgrade_host = uri.host;
				config.http_path = uri.path;
				break;
			case 'ws':
				config.ws_host = uri.host;
				config.ws_path = uri.path;
				if (config.ws_path && config.ws_path.includes('?ed=')) {
					config.websocket_early_data_header = 'Sec-WebSocket-Protocol';
					config.websocket_early_data = config.ws_path.split('?ed=')[1];
					config.ws_path = config.ws_path.split('?ed=')[0];
				}
				break;
			}

			break;
		}
	}

	if (config) {
		if (!config.address || !config.port)
			return null;
		else if (!config.label)
			config.label = config.address + ':' + config.port;

		config.address = config.address.replace(/\[|\]/g, '');
	}

	return config;
}

function buildNodeLabels(config) {
	const subscriptions = (uci.get(config, 'subscription', 'subscription_url') || []).map(raw => {
		const clean = raw.replace(/#.*$/, '');
		let title = '';
		try {
			const url = new URL(raw);
			title = url.hash ? decodeURIComponent(url.hash.slice(1)) : url.hostname;
		} catch (e) { }
		return { clean, hash: hp.calcStringMD5(clean), title };
	});
	const candidates = {}, counts = {};
	uci.sections(config, 'node', n => {
		let sourceURL = n.source_id ? uci.get(config, n.source_id, 'url') : '';
		const source = subscriptions.find(s => sourceURL ? s.clean === sourceURL : n.grouphash === s.hash);
		const value = (n.label || n['.name']) + (source?.title ? ' — ' + source.title : '');
		candidates[n['.name']] = value;
		counts[value] = (counts[value] || 0) + 1;
	});
	for (const id in candidates)
		if (counts[candidates[id]] > 1)
			candidates[id] += ' · ' + id.slice(-6);
	return candidates;
}

function renderNodeSettings(section, data, features, main_node, routing_mode, nodeLabels) {
	let s = section, o;
	s.handleRemove = removeNode;
	s.rowcolors = true;
	s.sortable = true;
	s.nodescriptions = true;
	s.modaltitle = L.bind(hp.loadModalTitle, this, _('Node'), _('Add a node'), data[0]);
	s.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);

	if (routing_mode !== 'custom') {
		o = s.option(form.Button, '_apply', _('Apply'));
		o.editable = true;
		o.modalonly = false;
		o.inputstyle = 'apply';
		o.inputtitle = function(section_id) {
			if (main_node == section_id) {
				this.readonly = true;
				return _('Applied');
			} else {
				this.readonly = false;
				return _('Apply');
			}
		}
		o.onclick = function(ev, section_id) {
			uci.set(data[0], 'config', 'main_node', section_id);

			return this.map.save(null, true).then(() => {
				ui.changes.apply(true);
			});
		}
	}

	o = s.option(form.Value, 'label', _('Label'));
	o.load = L.bind(hp.loadDefaultLabel, this, data[0]);
	// Display labels may repeat; internal node IDs are the identity.
	o.modalonly = true;

	const nodeName = id => {
		const n=uci.get(data[0],id);if(!n)return _('Missing node (%s)').format(id || '—');
		return nodeLabels[id] || n.label || id;
	};
	function nodeValidation(sid) {
		const current=this.section;
		const get=(id,key)=>{
			if(id===sid){const option=current.children.find(o=>o.option===key);const value=option?.formvalue(sid);if(value!==null && value!==undefined)return value;}
			return uci.get(data[0],id,key);
		};
		function effective(id,path=[]){
			if(path.includes(id))throw new Error(_('Circular node dependency: %s').format([...path,id].map(nodeName).join(' → ')));
			if(id!==sid && !uci.get(data[0],id))throw new Error(_('Missing node (%s)').format(id));
			let result={type:get(id,'type'),detour:get(id,'node_detour'),members:get(id,'group_nodes') || [],default:get(id,'group_default')};
			if(get(id,'node_mode')==='reference'){
				const base=get(id,'node_base');if(!base)throw new Error(_('Select a base node.'));
				result=effective(base,[...path,id]);
				if(['selector','urltest','tailscale','wireguard'].includes(result.type))throw new Error(_('Choose a proxy node as the base, not a group or endpoint.'));
			}
			const override=get(id,'local_detour');if(override)result={...result,detour:override==='_direct'?null:override};
			return result;
		}
		function visit(id,path=[]){
			if(path.includes(id))throw new Error(_('Circular node dependency: %s').format([...path,id].map(nodeName).join(' → ')));
			const n=effective(id);
			if(['selector','urltest'].includes(n.type)){
				if(!n.members.length)throw new Error(_('Group must contain at least one member.'));
				if(n.default && !n.members.includes(n.default))throw new Error(_('Default must be a group member.'));
			}
			for(const dep of [...n.members,...(n.detour?[n.detour]:[])])visit(dep,[...path,id]);
		}
		try{visit(sid);return true;}catch(e){return e.message;}
	}
	o=s.option(form.ListValue,'node_mode',_('Creation method'));
	o.value('manual',_('Configure directly'));o.value('reference',_('Reference an existing node'));o.default='manual';o.rmempty=false;o.modalonly=true;
	o.renderWidget=function(sid,index,value){
		if(uci.get(data[0],sid,'grouphash')){this.keylist=['manual'];this.vallist=[_('Configure directly')];}
		else {this.keylist=['manual','reference'];this.vallist=[_('Configure directly'),_('Reference an existing node')];}
		return form.ListValue.prototype.renderWidget.call(this,sid,index,value);
	};
	o.onchange=function(ev,sid,mode){
		const base=this.section.children.find(f=>f.option==='node_base')?.formvalue(sid);
		const info=document.getElementById('hp-base-info-'+sid);if(info)info.textContent=baseInfo(base);
		const upstream=document.getElementById('hp-original-upstream-'+sid);
		if(upstream)upstream.textContent=mode==='reference'?inheritedUpstream(base):uci.get(data[0],sid,'node_detour')?nodeName(uci.get(data[0],sid,'node_detour')):_('Connect directly');
	};
	o=s.option(form.ListValue,'node_base',_('Base node'),_('Inherit server, authentication, TLS and transport settings. Local overrides are kept separately.'));
	o.depends('node_mode','reference');o.rmempty=false;o.modalonly=true;
	o.load=function(sid){this.keylist=[];this.vallist=[];this.value('',_('Select a base node.'));uci.sections(data[0],'node',n=>{if(n['.name']!==sid && !['selector','urltest','tailscale','wireguard'].includes(n.type))this.value(n['.name'],nodeName(n['.name']));});return this.super('load',sid);};
	o.validate=nodeValidation;
	o.onchange=(ev,sid,id)=>{const target=document.getElementById('hp-base-info-'+sid);if(target)target.textContent=baseInfo(id);const upstream=document.getElementById('hp-original-upstream-'+sid);if(upstream)upstream.textContent=inheritedUpstream(id);};
	function inheritedUpstream(id,seen=[]){
		if(!id)return _('Select a base node.');
		if(seen.includes(id))return _('Circular node dependency: %s').format(nodeName(id));
		const n=uci.get(data[0],id);if(!n)return _('Missing node (%s)').format(id);
		if(n.local_detour)return n.local_detour==='_direct'?_('Connect directly'):nodeName(n.local_detour);
		if(n.node_mode==='reference')return inheritedUpstream(n.node_base,[...seen,id]);
		return n.node_detour?nodeName(n.node_detour):_('Connect directly');
	}
	function baseInfo(id,seen=[]){
		if(!id)return _('Select a base node.');
		if(seen.includes(id))return _('Circular node dependency: %s').format(nodeName(id));
		const n=uci.get(data[0],id);if(!n)return _('Missing node (%s)').format(id);
		if(n.node_mode==='reference')return baseInfo(n.node_base,[...seen,id]);
		return (n.type || '—')+' · '+(n.address || '—')+(n.port?':'+n.port:'');
	}
	o=s.option(form.DummyValue,'_base_info',_('Inherited configuration'));
	o.depends('node_mode','reference');o.modalonly=true;
	o.description=_('Protocol-specific fields follow the base node. Edit that node to change them; this entry only overrides how it is reached.');
	o.renderWidget=(sid)=>E('span',{id:'hp-base-info-'+sid},baseInfo(uci.get(data[0],sid,'node_base')));
	o=s.option(form.ListValue,'local_detour',_('Upstream outbound'),_('Connect to this proxy through the selected outbound. An empty override inherits the original setting; direct connection clears an inherited upstream.'));
	o.value('',_('Inherit original setting'));o.value('_direct',_('Connect directly'));
	o.load=function(sid){this.keylist=[];this.vallist=[];this.value('',_('Inherit original setting'));this.value('_direct',_('Connect directly'));uci.sections(data[0],'node',n=>{if(n['.name']!==sid)this.value(n['.name'],nodeName(n['.name']));});return this.super('load',sid);};
	o.depends('node_mode','reference');o.depends({node_mode:'manual',type:/^(?!selector$|urltest$|tailscale$|wireguard$).+/});o.modalonly=true;o.validate=nodeValidation;o.retain=true;
	o=s.option(form.DummyValue,'_upstream_original',_('Original upstream'));
	o.depends('node_mode','reference');o.depends({node_mode:'manual',type:/^(?!selector$|urltest$|tailscale$|wireguard$).+/});o.modalonly=true;
	o.renderWidget=sid=>{const n=uci.get(data[0],sid) || {};return E('span',{id:'hp-original-upstream-'+sid},n.node_mode==='reference'?inheritedUpstream(n.node_base):n.node_detour?nodeName(n.node_detour):_('Connect directly'));};
	o=s.option(widgets.DeviceSelect,'local_bind_interface',_('Override interface'),_('Used for a direct connection to the proxy server. Leave empty to inherit. Dial fields such as interface binding are ignored when an upstream is set.'));
	o.multiple=false;o.noaliases=true;o.modalonly=true;o.retain=true;o.depends('node_mode','reference');o.depends({node_mode:'manual',type:/^(?!selector$|urltest$|tailscale$|wireguard$).+/});
	o=s.option(form.ListValue,'local_domain_resolver',_('Override server address resolver'),_('Custom DNS servers are available only in custom routing mode. An unavailable resolver prevents applying the configuration.'));
	o.value('',_('Inherit original setting'));o.value('_default',_('Use routing default'));o.value('default-dns',_('Default DNS (issued by WAN)'));o.value('system-dns',_('System DNS'));
	if(routing_mode==='custom')uci.sections(data[0],'dns_server',n=>{if(n.enabled==='1')o.value(n['.name'],n.label || n['.name']);});
	o.modalonly=true;o.retain=true;o.depends('node_mode','reference');o.depends({node_mode:'manual',type:/^(?!selector$|urltest$|tailscale$|wireguard$).+/});
	o=s.option(form.ListValue,'local_domain_strategy',_('Override address strategy'));
	o.value('',_('Inherit original setting'));o.value('_default',_('Use routing default'));for(const key in hp.dns_strategy)if(key)o.value(key,hp.dns_strategy[key]);
	o.modalonly=true;o.retain=true;o.depends('node_mode','reference');o.depends({node_mode:'manual',type:/^(?!selector$|urltest$|tailscale$|wireguard$).+/});
	o = s.option(form.ListValue, 'type', _('Type'));
	o.textvalue=function(sid){return uci.get(data[0],sid,'node_mode')==='reference'?_('Reference'):form.ListValue.prototype.textvalue.call(this,sid);};
	o.value('direct', _('Direct'));
	o.value('anytls', _('AnyTLS'));
	o.value('http', _('HTTP'));
	if (features.with_quic) {
		o.value('hysteria', _('Hysteria'));
		o.value('hysteria2', _('Hysteria2'));
	}
	o.value('shadowsocks', _('Shadowsocks'));
	o.value('shadowtls', _('ShadowTLS'));
	o.value('socks', _('Socks'));
	o.value('ssh', _('SSH'));
	o.value('trojan', _('Trojan'));
	if (features.with_quic)
		o.value('tuic', _('Tuic'));
	if (features.with_wireguard && features.with_gvisor)
		o.value('wireguard', _('WireGuard'));
	if (features.with_tailscale) o.value('tailscale', _('Tailscale'));
	o.value('selector', _('Selector group'));
	o.value('urltest', _('Automatic selection group'));
	o.value('vless', _('VLESS'));
	o.value('vmess', _('VMess'));
	o.rmempty = false;

	o = s.option(form.Value, 'address', _('Address'));
	o.datatype = 'host';
	o.depends({type:/^(?!direct$|tailscale$|selector$|urltest$).+/});
	o.rmempty = false;

	o = s.option(form.Value, 'port', _('Port'));
	o.datatype = 'port';
	o.depends({type:/^(?!direct$|tailscale$|selector$|urltest$).+/});
	o.rmempty = false;

	o = s.option(form.Value, 'username', _('Username'));
	o.depends('type', 'http');
	o.depends('type', 'socks');
	o.depends('type', 'ssh');
	o.modalonly = true;

	o = s.option(form.Value, 'password', _('Password'));
	o.password = true;
	o.depends('type', 'anytls');
	o.depends('type', 'http');
	o.depends('type', 'hysteria2');
	o.depends('type', 'shadowsocks');
	o.depends('type', 'ssh');
	o.depends('type', 'trojan');
	o.depends('type', 'tuic');
	o.depends({'type': 'shadowtls', 'shadowtls_version': '2'});
	o.depends({'type': 'shadowtls', 'shadowtls_version': '3'});
	o.depends({'type': 'socks', 'socks_version': '5'});
	o.validate = function(section_id, value) {
		if (section_id) {
			let type = this.section.formvalue(section_id, 'type');
			let required_type = [ 'anytls', 'shadowsocks', 'shadowtls', 'trojan' ];

			if (required_type.includes(type)) {
				if (type === 'shadowsocks') {
					let encmode = this.section.formvalue(section_id, 'shadowsocks_encrypt_method');
					if (encmode === 'none')
						return true;
				}
				if (!value)
					return _('Expecting: %s').format(_('non-empty value'));
			}
		}

		return true;
	}
	o.modalonly = true;

	/* Direct config */
	o = s.option(form.ListValue, 'proxy_protocol', _('Proxy protocol'),
		_('Write proxy protocol in the connection header.'));
	o.value('', _('Disable'));
	o.value('1', _('v1'));
	o.value('2', _('v2'));
	o.depends('type', 'direct');
	o.modalonly = true;


	// Both imported and manually created groups use the same node editor.
	const groupLabel = id => {
		if (!id) return _('No members');
		const n=uci.get(data[0],id);
		if(!n)return _('Missing node (%s)').format(id);
		return nodeName(id);
	};
	const membersOption=s.option(form.DynamicList,'group_nodes',_('Group members'),
		_('Select existing nodes or groups. Nested groups are supported; self references and dependency cycles are not allowed.'));
	membersOption.depends('type','selector');membersOption.depends('type','urltest');membersOption.modalonly=true;
	membersOption.load=function(sid){
		delete this.keylist;delete this.vallist;
		uci.sections(data[0],'node',n=>{if(n['.name']!==sid)this.value(n['.name'],groupLabel(n['.name']));});
		return this.super('load',sid);
	};
	const defaultOption=s.option(form.ListValue,'group_default',_('Default group member'),
		_('Initial selection when the core starts. Runtime switching is available in Dashboard; the first member is used when unset.'));
	defaultOption.depends('type','selector');defaultOption.modalonly=true;
	function choices(sid,members,update,target=defaultOption){
		const current=update?target.formvalue(sid):uci.get(data[0],sid,'group_default');
		target.keylist=[];target.vallist=[];
		target.value('',_('First member'));
		for(const id of members)target.value(id,groupLabel(id));
		if(current && !members.includes(current))target.value(current,_('Not in this group (%s)').format(groupLabel(current)));
		if(update){
			const select=document.getElementById('widget.'+target.cbid(sid));
			if(select){select.replaceChildren(...target.keylist.map((v,i)=>E('option',{value:v},target.vallist[i])));select.value=current || '';}
		}
	}
	defaultOption.renderWidget=function(sid,index,value){choices(sid,uci.get(data[0],sid,'group_nodes') || [],false,this);return form.ListValue.prototype.renderWidget.call(this,sid,index,value);};
	defaultOption.validate=(sid,v)=>!v || (membersOption.formvalue(sid) || []).includes(v) || _('Default must be a group member.');
	membersOption.onchange=(ev,sid,values)=>choices(sid,Array.isArray(values)?values:membersOption.formvalue(sid) || [],true);
	for(const [field,label,hint,placeholder] of [
	 ['url',_('Test URL'),_('HTTP URL requested through each member to compare latency.'),'https://www.gstatic.com/generate_204'],
	 ['interval',_('Test interval (seconds)'),_('Interval between automatic latency checks. Empty uses the core default.'),'180'],
	 ['tolerance',_('Tolerance (milliseconds)'),_('Latency difference tolerated before switching to a faster member. Empty uses the core default.'),'50'],
	 ['idle_timeout',_('Idle timeout (seconds)'),_('Pause periodic checks after the group is idle. Empty uses the core default.'),'1800']
	]){
	 o=s.option(form.Value,'group_'+field,label,hint);o.depends('type','urltest');o.modalonly=true;o.placeholder=placeholder;if(field!=='url')o.datatype='uinteger';
	}
	o=s.option(form.Flag,'group_interrupt_exist_connections',_('Interrupt existing connections on switch'),
		_('When enabled, switching members interrupts existing connections as well as affecting new connections.'));
	o.depends('type','selector');o.depends('type','urltest');o.modalonly=true;

	/* Tailscale endpoint fields, pinned to sing-box 1.14.0. */
	for (const [field,label,hint] of [
	 ['auth_key',_('Tailscale auth key'),_('Optional for first login. Without a key, obtain the login URL from core logs or the Dashboard Tailscale tools. Existing state is reused.')],
	 ['hostname',_('Tailscale hostname'),_('Name advertised to the tailnet. Empty uses the system hostname.')],
	 ['control_url',_('Tailscale control URL'),_('Empty uses the official coordination server. Set an HTTPS URL for another compatible control server.')],
	 ['exit_node',_('Tailscale exit node'),_('Name or IP of the exit node. Without an exit node this endpoint provides tailnet access, not a general Internet proxy.')],
	 ['state_directory',_('Tailscale state directory'),_('Empty uses a private persistent directory per node under /etc/homeproxy/tailscale/. Keep it to preserve device identity across restarts.')],
	 ['taildrop_directory',_('Taildrop directory'),_('Empty uses a Taildrop subdirectory of this node’s state directory. Received files consume router storage; choose external storage for large files.')],
	 ['system_interface_name',_('Tailscale interface name'),_('Optional name for the system TUN interface. Avoid names already used by HomeProxy or other services.')]
	]) {
	 o=s.option(form.Value,'tailscale_'+field,label,hint);o.depends('type','tailscale');o.modalonly=true;
	 if(field==='auth_key')o.password=true;
	 if(field==='control_url')o.validate=(sid,value)=>!value || /^https:\/\/[^\s]+$/.test(value) || _('Use an HTTPS URL.');
	 if(field.endsWith('directory'))o.validate=(sid,value)=>!value || (value.startsWith('/') && !/[\r\n]/.test(value)) || _('Use an absolute directory path.');
	}
	for (const [field,label,hint] of [
	 ['ephemeral',_('Ephemeral Tailscale device'),_('Register a temporary device rather than a permanent tailnet member.')],
	 ['accept_routes',_('Accept tailnet routes'),_('Accept subnet routes advertised by other tailnet devices.')],
	 ['exit_node_allow_lan_access',_('Allow LAN access with exit node'),_('Allow locally accessible subnets to bypass the exit node. Availability also depends on advertised routes.')],
	 ['advertise_exit_node',_('Advertise as exit node'),_('Offer this device as an exit node. Approval and access policy are managed in the Tailscale administration console.')],
	 ['system_interface',_('Create Tailscale system interface'),_('Create an additional system TUN interface. This is separate from HomeProxy traffic interception and requires kmod-tun.')],
	 ['ssh_server',_('Enable Tailscale SSH'),_('Serve SSH on tailnet port 22 using local system accounts and Tailscale SSH access policies.')],
	 ['ssh_disable_pty',_('Disable SSH PTY'),_('Refuse terminal allocation for Tailscale SSH.')],
	 ['ssh_disable_sftp',_('Disable SSH SFTP'),_('Refuse SFTP over Tailscale SSH.')],
	 ['ssh_disable_forwarding',_('Disable SSH forwarding'),_('Refuse TCP, Unix-socket and agent forwarding over Tailscale SSH.')]
	]) {o=s.option(form.Flag,'tailscale_'+field,label,hint);o.default='0';o.modalonly=true;o.depends(field.startsWith('ssh_disable')?{type:'tailscale',tailscale_ssh_server:'1'}:{type:'tailscale'});}
	for(const [field,label,datatype] of [
	 ['advertise_routes',_('Advertised tailnet subnets'),'cidr'],['advertise_tags',_('Advertised Tailscale tags'),'string'],['relay_server_static_endpoints',_('Relay static endpoints'),'ipaddrport(1)']
	]) {o=s.option(form.DynamicList,'tailscale_'+field,label);o.depends('type','tailscale');o.modalonly=true;o.datatype=datatype;}
	for(const [field,label,hint,datatype] of [
	 ['listen_port',_('Tailscale UDP port'),_('Empty or 0 selects an automatic peer-to-peer UDP port.'),'range(0,65535)'],
	 ['relay_server_port',_('Tailscale relay port'),_('Optional UDP port for peer relay connections. Leave empty to retain the default.'),'range(0,65535)'],
	 ['system_interface_mtu',_('Tailscale interface MTU'),_('Empty uses the Tailscale default MTU.'),'uinteger'],
	 ['udp_timeout',_('Tailscale UDP idle timeout'),_('Seconds. Empty uses 300 seconds.'),'uinteger']
	]) {o=s.option(form.Value,'tailscale_'+field,label,hint);o.depends('type','tailscale');o.modalonly=true;o.datatype=datatype;}

	/* Hysteria2 1.14 options */
	o = s.option(form.Flag, 'hysteria_disable_chrome_parrot', _('Disable Chrome QUIC handshake'),
		_('Enable for Hysteria2 servers with Ed25519 certificates or to retain the older handshake behavior.'));
	o.depends('type', 'hysteria2');
	o.modalonly = true;
	o = s.option(form.ListValue, 'hysteria_bbr_profile', _('Hysteria2 BBR profile'));
	for (let profile of ['standard', 'conservative', 'aggressive']) o.value(profile);
	o.depends('type', 'hysteria2');
	o.modalonly = true;
	o = s.option(form.Value, 'hysteria_hop_interval_max', _('Maximum hop interval (seconds)'));
	o.datatype = 'uinteger';
	o.depends('type', 'hysteria2');
	o.modalonly = true;
	/* AnyTLS config start */
	o = s.option(form.Value, 'anytls_idle_session_check_interval', _('Idle session check interval'),
		_('Interval checking for idle sessions, in seconds.'));
	o.datatype = 'uinteger';
	o.placeholder = '30';
	o.depends('type', 'anytls');
	o.modalonly = true;

	o = s.option(form.Value, 'anytls_idle_session_timeout', _('Idle session check timeout'),
		_('In the check, close sessions that have been idle for longer than this, in seconds.'));
	o.datatype = 'uinteger';
	o.placeholder = '30';
	o.depends('type', 'anytls');
	o.modalonly = true;

	o = s.option(form.Value, 'anytls_min_idle_session', _('Minimum idle sessions'),
		_('In the check, at least the first <code>n</code> idle sessions are kept open.'));
	o.datatype = 'uinteger';
	o.placeholder = '0';
	o.depends('type', 'anytls');
	o.modalonly = true;
	/* AnyTLS config end */

	/* Hysteria (2) config start */
	o = s.option(form.DynamicList, 'hysteria_hopping_port', _('Hopping port'));
	o.depends('type', 'hysteria');
	o.depends('type', 'hysteria2');
	o.validate = hp.validatePortRange;
	o.modalonly = true;

	o = s.option(form.Value, 'hysteria_hop_interval', _('Hop interval'),
		_('Port hopping interval in seconds.'));
	o.datatype = 'uinteger';
	o.placeholder = '30';
	o.depends({'type': 'hysteria', 'hysteria_hopping_port': /[\s\S]/});
	o.depends({'type': 'hysteria2', 'hysteria_hopping_port': /[\s\S]/});
	o.modalonly = true;

	o = s.option(form.ListValue, 'hysteria_protocol', _('Protocol'));
	o.value('udp');
	/* WeChat-Video / FakeTCP are unsupported by sing-box currently
	 * o.value('wechat-video');
	 * o.value('faketcp');
	 */
	o.default = 'udp';
	o.depends('type', 'hysteria');
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.ListValue, 'hysteria_auth_type', _('Authentication type'));
	o.value('', _('Disable'));
	o.value('base64', _('Base64'));
	o.value('string', _('String'));
	o.depends('type', 'hysteria');
	o.modalonly = true;

	o = s.option(form.Value, 'hysteria_auth_payload', _('Authentication payload'));
	o.password = true
	o.depends({'type': 'hysteria', 'hysteria_auth_type': /[\s\S]/});
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.ListValue, 'hysteria_obfs_type', _('Obfuscate type'));
	o.value('', _('Disable'));
	o.value('salamander', _('Salamander'));
	o.value('gecko', _('Gecko'));
	o.depends('type', 'hysteria2');
	o.modalonly = true;

	for (let [field, label] of [['hysteria_obfs_min_packet_size', _('Minimum obfuscation packet size')], ['hysteria_obfs_max_packet_size', _('Maximum obfuscation packet size')]]) {
		o = s.option(form.Value, field, label);
		o.datatype = 'uinteger';
		o.depends({type: 'hysteria2', hysteria_obfs_type: 'gecko'});
		o.modalonly = true;
	}

	o = s.option(form.Value, 'hysteria_obfs_password', _('Obfuscate password'));
	o.password = true;
	o.depends('type', 'hysteria');
	o.depends({'type': 'hysteria2', 'hysteria_obfs_type': /[\s\S]/});
	o.modalonly = true;

	o = s.option(form.Value, 'hysteria_down_mbps', _('Max download speed'),
		_('Max download speed in Mbps.'));
	o.datatype = 'uinteger';
	o.depends('type', 'hysteria');
	o.depends('type', 'hysteria2');
	o.modalonly = true;

	o = s.option(form.Value, 'hysteria_up_mbps', _('Max upload speed'),
		_('Max upload speed in Mbps.'));
	o.datatype = 'uinteger';
	o.depends('type', 'hysteria');
	o.depends('type', 'hysteria2');
	o.modalonly = true;

	o = s.option(form.Value, 'hysteria_recv_window_conn', _('QUIC stream receive window'),
		_('The QUIC stream-level flow control window for receiving data.'));
	o.datatype = 'uinteger';
	o.depends('type', 'hysteria');
	o.modalonly = true;

	o = s.option(form.Value, 'hysteria_revc_window', _('QUIC connection receive window'),
		_('The QUIC connection-level flow control window for receiving data.'));
	o.datatype = 'uinteger';
	o.depends('type', 'hysteria');
	o.modalonly = true;

	o = s.option(form.Flag, 'hysteria_disable_mtu_discovery', _('Disable Path MTU discovery'),
		_('Disables Path MTU Discovery (RFC 8899). Packets will then be at most 1252 (IPv4) / 1232 (IPv6) bytes in size.'));
	o.depends('type', 'hysteria');
	o.modalonly = true;
	/* Hysteria (2) config end */

	/* Shadowsocks config start */
	o = s.option(form.ListValue, 'shadowsocks_encrypt_method', _('Encrypt method'));
	for (let i of hp.shadowsocks_encrypt_methods)
		o.value(i);
	/* Stream ciphers */
	o.value('aes-128-ctr');
	o.value('aes-192-ctr');
	o.value('aes-256-ctr');
	o.value('aes-128-cfb');
	o.value('aes-192-cfb');
	o.value('aes-256-cfb');
	o.value('chacha20');
	o.value('chacha20-ietf');
	o.value('rc4-md5');
	o.default = 'aes-128-gcm';
	o.depends('type', 'shadowsocks');
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.ListValue, 'shadowsocks_plugin', _('Plugin'));
	o.value('', _('none'));
	o.value('obfs-local');
	o.value('v2ray-plugin');
	o.depends('type', 'shadowsocks');
	o.modalonly = true;

	o = s.option(form.Value, 'shadowsocks_plugin_opts', _('Plugin opts'));
	o.depends('shadowsocks_plugin', 'obfs-local');
	o.depends('shadowsocks_plugin', 'v2ray-plugin');
	o.modalonly = true;
	/* Shadowsocks config end */

	/* ShadowTLS config */
	o = s.option(form.ListValue, 'shadowtls_version', _('ShadowTLS version'));
	o.value('1', _('v1'));
	o.value('2', _('v2'));
	o.value('3', _('v3'));
	o.default = '1';
	o.depends('type', 'shadowtls');
	o.rmempty = false;
	o.modalonly = true;

	/* Socks config */
	o = s.option(form.ListValue, 'socks_version', _('Socks version'));
	o.value('4', _('Socks4'));
	o.value('4a', _('Socks4A'));
	o.value('5', _('Socks5'));
	o.default = '5';
	o.depends('type', 'socks');
	o.rmempty = false;
	o.modalonly = true;

	/* SSH config start */
	o = s.option(form.Value, 'ssh_client_version', _('Client version'),
		_('Random version will be used if empty.'));
	o.depends('type', 'ssh');
	o.modalonly = true;

	o = s.option(form.DynamicList, 'ssh_host_key', _('Host key'),
		_('Accept any if empty.'));
	o.depends('type', 'ssh');
	o.modalonly = true;

	o = s.option(form.DynamicList, 'ssh_host_key_algo', _('Host key algorithms'))
	o.depends('type', 'ssh');
	o.modalonly = true;

	o = s.option(form.DynamicList, 'ssh_priv_key', _('Private key'));
	o.password = true;
	o.depends('type', 'ssh');
	o.modalonly = true;

	o = s.option(form.Value, 'ssh_priv_key_pp', _('Private key passphrase'));
	o.password = true;
	o.depends('type', 'ssh');
	o.modalonly = true;
	/* SSH config end */

	/* TUIC config start */
	o = s.option(form.Value, 'uuid', _('UUID'));
	o.password = true;
	o.depends('type', 'tuic');
	o.depends('type', 'vless');
	o.depends('type', 'vmess');
	o.validate = hp.validateUUID;
	o.modalonly = true;

	o = s.option(form.ListValue, 'tuic_congestion_control', _('Congestion control algorithm'),
		_('QUIC congestion control algorithm.'));
	o.value('cubic', _('CUBIC'));
	o.value('new_reno', _('New Reno'));
	o.value('bbr', _('BBR'));
	o.default = 'cubic';
	o.depends('type', 'tuic');
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.ListValue, 'tuic_udp_relay_mode', _('UDP relay mode'),
		_('UDP packet relay mode.'));
	o.value('', _('Default'));
	o.value('native', _('Native'));
	o.value('quic', _('QUIC'));
	o.depends('type', 'tuic');
	o.modalonly = true;

	o = s.option(form.Flag, 'tuic_udp_over_stream', _('UDP over stream'),
		_('This is the TUIC port of the UDP over TCP protocol, designed to provide a QUIC stream based UDP relay mode that TUIC does not provide.'));
	o.depends({'type': 'tuic','tuic_udp_relay_mode': ''});
	o.modalonly = true;

	o = s.option(form.Flag, 'tuic_enable_zero_rtt', _('Enable 0-RTT handshake'),
		_('Enable 0-RTT QUIC connection handshake on the client side. This is not impacting much on the performance, as the protocol is fully multiplexed.<br/>' +
			'Disabling this is highly recommended, as it is vulnerable to replay attacks.'));
	o.depends('type', 'tuic');
	o.modalonly = true;

	o = s.option(form.Value, 'tuic_heartbeat', _('Heartbeat interval'),
		_('Interval for sending heartbeat packets for keeping the connection alive (in seconds).'));
	o.datatype = 'uinteger';
	o.default = '10';
	o.depends('type', 'tuic');
	o.modalonly = true;
	/* Tuic config end */

	/* VMess / VLESS config start */
	o = s.option(form.ListValue, 'vless_flow', _('Flow'));
	o.value('', _('None'));
	o.value('xtls-rprx-vision');
	o.depends('type', 'vless');
	o.modalonly = true;

	o = s.option(form.Value, 'vmess_alterid', _('Alter ID'),
		_('Legacy protocol support (VMess MD5 Authentication) is provided for compatibility purposes only, use of alterId > 1 is not recommended.'));
	o.datatype = 'uinteger';
	o.depends('type', 'vmess');
	o.modalonly = true;

	o = s.option(form.ListValue, 'vmess_encrypt', _('Encrypt method'));
	o.value('auto');
	o.value('none');
	o.value('zero');
	o.value('aes-128-gcm');
	o.value('chacha20-poly1305');
	o.default = 'auto';
	o.depends('type', 'vmess');
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Flag, 'vmess_global_padding', _('Global padding'),
		_('Protocol parameter. Will waste traffic randomly if enabled (enabled by default in v2ray and cannot be disabled).'));
	o.default = o.enabled;
	o.depends('type', 'vmess');
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Flag, 'vmess_authenticated_length', _('Authenticated length'),
		_('Protocol parameter. Enable length block encryption.'));
	o.depends('type', 'vmess');
	o.modalonly = true;
	/* VMess config end */

	/* Transport config start */
	o = s.option(form.ListValue, 'transport', _('Transport'),
		_('No TCP transport, plain HTTP is merged into the HTTP transport.'));
	o.value('', _('None'));
	o.value('grpc', _('gRPC'));
	o.value('http', _('HTTP'));
	o.value('httpupgrade', _('HTTPUpgrade'));
	o.value('quic', _('QUIC'));
	o.value('ws', _('WebSocket'));
	o.depends('type', 'trojan');
	o.depends('type', 'vless');
	o.depends('type', 'vmess');
	o.onchange = function(ev, section_id, value) {
		let desc = this.map.findElement('id', 'cbid.homeproxy.%s.transport'.format(section_id)).nextElementSibling;
		if (value === 'http')
			desc.innerHTML = _('TLS is not enforced. If TLS is not configured, plain HTTP 1.1 is used.');
		else if (value === 'quic')
			desc.innerHTML = _('No additional encryption support: It\'s basically duplicate encryption.');
		else
			desc.innerHTML = _('No TCP transport, plain HTTP is merged into the HTTP transport.');

		let tls = this.map.findElement('id', 'cbid.homeproxy.%s.tls'.format(section_id)).firstElementChild;
		if ((value === 'http' && tls.checked) || (value === 'grpc' && !features.with_grpc)) {
			this.map.findElement('id', 'cbid.homeproxy.%s.http_idle_timeout'.format(section_id)).nextElementSibling.innerHTML =
				_('Specifies the period of time (in seconds) after which a health check will be performed using a ping frame if no frames have been received on the connection.<br/>' +
					'Please note that a ping response is considered a received frame, so if there is no other traffic on the connection, the health check will be executed every interval.');

			this.map.findElement('id', 'cbid.homeproxy.%s.http_ping_timeout'.format(section_id)).nextElementSibling.innerHTML =
				_('Specifies the timeout duration (in seconds) after sending a PING frame, within which a response must be received.<br/>' +
					'If a response to the PING frame is not received within the specified timeout duration, the connection will be closed.');
		} else if (value === 'grpc' && features.with_grpc) {
			this.map.findElement('id', 'cbid.homeproxy.%s.http_idle_timeout'.format(section_id)).nextElementSibling.innerHTML =
				_('If the transport doesn\'t see any activity after a duration of this time (in seconds), it pings the client to check if the connection is still active.');

			this.map.findElement('id', 'cbid.homeproxy.%s.http_ping_timeout'.format(section_id)).nextElementSibling.innerHTML =
				_('The timeout (in seconds) that after performing a keepalive check, the client will wait for activity. If no activity is detected, the connection will be closed.');
		}
	}
	o.modalonly = true;

	/* gRPC config start */
	o = s.option(form.Value, 'grpc_servicename', _('gRPC service name'));
	o.depends('transport', 'grpc');
	o.modalonly = true;

	if (features.with_grpc) {
		o = s.option(form.Flag, 'grpc_permit_without_stream', _('gRPC permit without stream'),
			_('If enabled, the client transport sends keepalive pings even with no active connections.'));
		o.depends('transport', 'grpc');
		o.modalonly = true;
	}
	/* gRPC config end */

	/* HTTP(Upgrade) config start */
	o = s.option(form.DynamicList, 'http_host', _('Host'));
	o.datatype = 'hostname';
	o.depends('transport', 'http');
	o.modalonly = true;

	o = s.option(form.Value, 'httpupgrade_host', _('Host'));
	o.datatype = 'hostname';
	o.depends('transport', 'httpupgrade');
	o.modalonly = true;

	o = s.option(form.Value, 'http_path', _('Path'));
	o.depends('transport', 'http');
	o.depends('transport', 'httpupgrade');
	o.modalonly = true;

	o = s.option(form.Value, 'http_method', _('Method'));
	o.value('GET', _('GET'));
	o.value('PUT', _('PUT'));
	o.depends('transport', 'http');
	o.modalonly = true;

	o = s.option(form.Value, 'http_idle_timeout', _('Idle timeout'),
		_('Specifies the period of time (in seconds) after which a health check will be performed using a ping frame if no frames have been received on the connection.<br/>' +
			'Please note that a ping response is considered a received frame, so if there is no other traffic on the connection, the health check will be executed every interval.'));
	o.datatype = 'uinteger';
	o.depends('transport', 'grpc');
	o.depends({'transport': 'http', 'tls': '1'});
	o.modalonly = true;

	o = s.option(form.Value, 'http_ping_timeout', _('Ping timeout'),
		_('Specifies the timeout duration (in seconds) after sending a PING frame, within which a response must be received.<br/>' +
			'If a response to the PING frame is not received within the specified timeout duration, the connection will be closed.'));
	o.datatype = 'uinteger';
	o.depends('transport', 'grpc');
	o.depends({'transport': 'http', 'tls': '1'});
	o.modalonly = true;
	/* HTTP config end */

	/* WebSocket config start */
	o = s.option(form.Value, 'ws_host', _('Host'));
	o.depends('transport', 'ws');
	o.modalonly = true;

	o = s.option(form.Value, 'ws_path', _('Path'));
	o.depends('transport', 'ws');
	o.modalonly = true;

	o = s.option(form.Value, 'websocket_early_data', _('Early data'),
		_('Allowed payload size is in the request.'));
	o.datatype = 'uinteger';
	o.value('2048');
	o.depends('transport', 'ws');
	o.modalonly = true;

	o = s.option(form.Value, 'websocket_early_data_header', _('Early data header name'));
	o.value('Sec-WebSocket-Protocol');
	o.depends('transport', 'ws');
	o.modalonly = true;
	/* WebSocket config end */

	o = s.option(form.ListValue, 'packet_encoding', _('Packet encoding'));
	o.value('', _('none'));
	o.value('packetaddr', _('packet addr (v2ray-core v5+)'));
	o.value('xudp', _('Xudp (Xray-core)'));
	o.depends('type', 'vless');
	o.depends('type', 'vmess');
	o.modalonly = true;
	/* Transport config end */

	/* Wireguard config start */
	o = s.option(form.DynamicList, 'wireguard_local_address', _('Local address'),
		_('List of IP (v4 or v6) addresses prefixes to be assigned to the interface.'));
	o.datatype = 'cidr';
	o.depends('type', 'wireguard');
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Value, 'wireguard_private_key', _('Private key'),
		_('WireGuard requires base64-encoded private keys.'));
	o.password = true;
	o.depends('type', 'wireguard');
	o.validate = L.bind(hp.validateBase64Key, this, 44);
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Value, 'wireguard_peer_public_key', _('Peer pubkic key'),
		_('WireGuard peer public key.'));
	o.depends('type', 'wireguard');
	o.validate = L.bind(hp.validateBase64Key, this, 44);
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Value, 'wireguard_pre_shared_key', _('Pre-shared key'),
		_('WireGuard pre-shared key.'));
	o.password = true;
	o.depends('type', 'wireguard');
	o.validate = L.bind(hp.validateBase64Key, this, 44);
	o.modalonly = true;

	o = s.option(form.DynamicList, 'wireguard_reserved', _('Reserved field bytes'));
	o.datatype = 'integer';
	o.depends('type', 'wireguard');
	o.modalonly = true;

	o = s.option(form.Value, 'wireguard_mtu', _('MTU'));
	o.datatype = 'range(0,9000)';
	o.placeholder = '1408';
	o.depends('type', 'wireguard');
	o.modalonly = true;

	o = s.option(form.Value, 'wireguard_persistent_keepalive_interval', _('Persistent keepalive interval'),
		_('In seconds. Disabled by default.'));
	o.datatype = 'uinteger';
	o.depends('type', 'wireguard');
	o.modalonly = true;
	/* Wireguard config end */

	/* Mux config start */
	o = s.option(form.Flag, 'multiplex', _('Multiplex'));
	o.depends('type', 'shadowsocks');
	o.depends('type', 'trojan');
	o.depends('type', 'vless');
	o.depends('type', 'vmess');
	o.modalonly = true;

	o = s.option(form.ListValue, 'multiplex_protocol', _('Protocol'),
		_('Multiplex protocol.'));
	o.value('h2mux');
	o.value('smux');
	o.value('yamux');
	o.default = 'h2mux';
	o.depends('multiplex', '1');
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Value, 'multiplex_max_connections', _('Maximum connections'));
	o.datatype = 'uinteger';
	o.depends('multiplex', '1');
	o.modalonly = true;

	o = s.option(form.Value, 'multiplex_min_streams', _('Minimum streams'),
		_('Minimum multiplexed streams in a connection before opening a new connection.'));
	o.datatype = 'uinteger';
	o.depends('multiplex', '1');
	o.modalonly = true;

	o = s.option(form.Value, 'multiplex_max_streams', _('Maximum streams'),
		_('Maximum multiplexed streams in a connection before opening a new connection.<br/>' +
			'Conflict with <code>%s</code> and <code>%s</code>.').format(
				_('Maximum connections'), _('Minimum streams')));
	o.datatype = 'uinteger';
	o.depends({'multiplex': '1', 'multiplex_max_connections': '', 'multiplex_min_streams': ''});
	o.modalonly = true;

	o = s.option(form.Flag, 'multiplex_padding', _('Enable padding'));
	o.depends('multiplex', '1');
	o.modalonly = true;

	o = s.option(form.Flag, 'multiplex_brutal', _('Enable TCP Brutal'),
		_('Enable TCP Brutal congestion control algorithm'));
	o.depends('multiplex', '1');
	o.modalonly = true;

	o = s.option(form.Value, 'multiplex_brutal_down', _('Download bandwidth'),
		_('Download bandwidth in Mbps.'));
	o.datatype = 'uinteger';
	o.depends('multiplex_brutal', '1');
	o.modalonly = true;

	o = s.option(form.Value, 'multiplex_brutal_up', _('Upload bandwidth'),
		_('Upload bandwidth in Mbps.'));
	o.datatype = 'uinteger';
	o.depends('multiplex_brutal', '1');
	o.modalonly = true;
	/* Mux config end */

	/* TLS config start */
	o = s.option(form.Flag, 'tls', _('TLS'));
	o.depends('type', 'anytls');
	o.depends('type', 'http');
	o.depends('type', 'hysteria');
	o.depends('type', 'hysteria2');
	o.depends('type', 'shadowtls');
	o.depends('type', 'trojan');
	o.depends('type', 'tuic');
	o.depends('type', 'vless');
	o.depends('type', 'vmess');
	o.validate = function(section_id, _value) {
		if (section_id) {
			let type = this.map.lookupOption('type', section_id)[0].formvalue(section_id);
			let tls = this.map.findElement('id', 'cbid.homeproxy.%s.tls'.format(section_id)).firstElementChild;

			if (['anytls', 'hysteria', 'hysteria2', 'shadowtls', 'tuic'].includes(type)) {
				tls.checked = true;
				tls.disabled = true;
			} else {
				tls.disabled = null;
			}
		}

		return true;
	}
	o.modalonly = true;

	o = s.option(form.Value, 'tls_sni', _('TLS SNI'),
		_('Used to verify the hostname on the returned certificates unless insecure is given.'));
	o.depends('tls', '1');
	o.modalonly = true;

	o = s.option(form.DynamicList, 'tls_alpn', _('TLS ALPN'),
		_('List of supported application level protocols, in order of preference.'));
	o.depends('tls', '1');
	o.modalonly = true;

	o = s.option(form.Flag, 'tls_insecure', _('Allow insecure'),
		_('Allow insecure connection at TLS client.') +
		'<br/>' +
		_('This is <strong>DANGEROUS</strong>, your traffic is almost like <strong>PLAIN TEXT</strong>! Use at your own risk!'));
	o.depends('tls', '1');
	o.onchange = allowInsecureConfirm;
	o.modalonly = true;

	o = s.option(form.Value, 'tls_handshake_timeout', _('TLS handshake timeout (seconds)'));
	o.datatype = 'uinteger';
	o.depends('tls', '1');
	o = s.option(form.DynamicList, 'tls_certificate_public_key_sha256', _('Pinned certificate public key SHA256'));
	o.depends('tls', '1');
	o = s.option(form.ListValue, 'tls_min_version', _('Minimum TLS version'),
		_('The minimum TLS version that is acceptable.'));
	o.value('', _('default'));
	for (let i of hp.tls_versions)
		o.value(i);
	o.depends('tls', '1');
	o.modalonly = true;

	o = s.option(form.ListValue, 'tls_max_version', _('Maximum TLS version'),
		_('The maximum TLS version that is acceptable.'));
	o.value('', _('default'));
	for (let i of hp.tls_versions)
		o.value(i);
	o.depends('tls', '1');
	o.modalonly = true;

	o = s.option(hp.CBIStaticList, 'tls_cipher_suites', _('Cipher suites'),
		_('The elliptic curves that will be used in an ECDHE handshake, in preference order. If empty, the default will be used.'));
	for (let i of hp.tls_cipher_suites)
		o.value(i);
	o.depends('tls', '1');
	o.optional = true;
	o.modalonly = true;

	o = s.option(form.Flag, 'tls_self_sign', _('Append self-signed certificate'),
		_('If you have the root certificate, use this option instead of allowing insecure.'));
	o.depends('tls_insecure', '0');
	o.modalonly = true;

	o = s.option(form.Value, 'tls_cert_path', _('Certificate path'),
		_('The path to the server certificate, in PEM format.'));
	o.value('/etc/homeproxy/certs/client_ca.pem');
	o.depends('tls_self_sign', '1');
	o.validate = hp.validateCertificatePath;
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Button, '_upload_cert', _('Upload certificate'),
		_('<strong>Save your configuration before uploading files!</strong>'));
	o.inputstyle = 'action';
	o.inputtitle = _('Upload...');
	o.depends({'tls_self_sign': '1', 'tls_cert_path': '/etc/homeproxy/certs/client_ca.pem'});
	o.onclick = L.bind(hp.uploadCertificate, this, _('certificate'), 'client_ca');
	o.modalonly = true;

	o = s.option(form.Flag, 'tls_ech', _('Enable ECH'),
		_('ECH (Encrypted Client Hello) is a TLS extension that allows a client to encrypt the first part of its ClientHello message.'));
	o.depends('tls', '1');
	o.modalonly = true;

	o = s.option(form.Value, 'tls_ech_config_path', _('ECH config path'),
		_('The path to the ECH config, in PEM format. If empty, load from DNS will be attempted.'));
	o.value('/etc/homeproxy/certs/client_ech_conf.pem');
	o.depends('tls_ech', '1');
	o.modalonly = true;

	o = s.option(form.Button, '_upload_ech_config', _('Upload ECH config'),
		_('<strong>Save your configuration before uploading files!</strong>'));
	o.inputstyle = 'action';
	o.inputtitle = _('Upload...');
	o.depends({'tls_ech': '1', 'tls_ech_config_path': '/etc/homeproxy/certs/client_ech_conf.pem'});
	o.onclick = L.bind(hp.uploadCertificate, this, _('ECH config'), 'client_ech_conf');
	o.modalonly = true;

	if (features.with_utls) {
		o = s.option(form.ListValue, 'tls_utls', _('uTLS fingerprint'),
			_('uTLS is a fork of "crypto/tls", which provides ClientHello fingerprinting resistance.'));
		o.value('', _('Disable'));
		o.value('360');
		o.value('android');
		o.value('chrome');
		o.value('edge');
		o.value('firefox');
		o.value('ios');
		o.value('qq');
		o.value('random');
		o.value('randomized');
		o.value('safari');
		o.depends({'tls': '1', 'type': /^((?!hysteria2?|tuic$).)+$/});
		o.validate = function(section_id, value) {
			if (section_id) {
				let tls_reality = this.map.findElement('id', 'cbid.homeproxy.%s.tls_reality'.format(section_id)).firstElementChild;
				if (tls_reality.checked && !value)
					return _('Expecting: %s').format(_('non-empty value'));

				let vless_flow = this.map.lookupOption('vless_flow', section_id)[0].formvalue(section_id);
				if ((tls_reality.checked || vless_flow) && ['360', 'android'].includes(value))
					return _('Unsupported fingerprint!');
			}

			return true;
		}
		o.modalonly = true;

		o = s.option(form.Flag, 'tls_reality', _('REALITY'));
		o.depends({'tls': '1', 'type': 'anytls'});
		o.depends({'tls': '1', 'type': 'vless'});
		o.modalonly = true;

		o = s.option(form.Value, 'tls_reality_public_key', _('REALITY public key'));
		o.password = true;
		o.depends('tls_reality', '1');
		o.rmempty = false;
		o.modalonly = true;

		o = s.option(form.Value, 'tls_reality_short_id', _('REALITY short ID'));
		o.password = true;
		o.depends('tls_reality', '1');
		o.modalonly = true;
	}
	/* TLS config end */

	/* Extra settings start */
	o = s.option(form.Flag, 'tcp_fast_open', _('TCP fast open'));
	o.modalonly = true;

	o = s.option(form.Flag, 'tcp_multi_path', _('MultiPath TCP'));
	o.modalonly = true;

	o = s.option(form.Flag, 'udp_fragment', _('UDP Fragment'),
		_('Enable UDP fragmentation.'));
	o.modalonly = true;

	o = s.option(form.Flag, 'udp_over_tcp', _('UDP over TCP'),
		_('Enable the SUoT protocol, requires server support. Conflict with multiplex.'));
	o.depends('type', 'socks');
	o.depends({'type': 'shadowsocks', 'multiplex': '0'});
	o.modalonly = true;

	o = s.option(form.ListValue, 'udp_over_tcp_version', _('SUoT version'));
	o.value('1', _('v1'));
	o.value('2', _('v2'));
	o.default = '2';
	o.depends('udp_over_tcp', '1');
	o.modalonly = true;
	/* Extra settings end */
	// Direct configuration starts with protocol fields. Dial overrides are advanced.
	o=s.option(form.Flag,'_dial_advanced',_('Advanced connection settings'));
	o.modalonly=true;o.default='0';o.depends({node_mode:'manual',type:/^(?!selector$|urltest$|tailscale$|wireguard$).+/});
	o.cfgvalue=sid=>['local_detour','local_bind_interface','local_domain_resolver','local_domain_strategy'].some(k=>uci.get(data[0],sid,k))?'1':'0';
	o.write=()=>{};o.remove=()=>{};
	for(const field of s.children) if(field.option.startsWith('local_') || field.option==='_upstream_original') {
		for(const dep of field.deps || [])if(dep.node_mode==='manual')dep._dial_advanced='1';
	}
	const first=['_apply','label','node_mode','type','node_base','_base_info'];
	const last=['_dial_advanced','local_detour','_upstream_original','local_bind_interface','local_domain_resolver','local_domain_strategy'];
	const byName=new Map(s.children.map(field=>[field.option,field]));
	s.children=[...first.map(k=>byName.get(k)).filter(Boolean),...s.children.filter(field=>!first.includes(field.option) && !last.includes(field.option)),...last.map(k=>byName.get(k)).filter(Boolean)];
	// References expose only inheritance and override controls, not duplicate credentials.
	for(const field of s.children){
		if(!['type','_apply'].includes(field.option))field.modalonly=true;
		if(!['label','node_mode','node_base','_base_info','_upstream_original','_apply','_dial_advanced'].includes(field.option) && !field.option.startsWith('local_')){
			if(field.deps?.length)for(const dep of field.deps)dep.node_mode='manual';else field.depends('node_mode','manual');
			field.retain=true;
			if(['tcp_fast_open','tcp_multi_path','udp_fragment'].includes(field.option))for(const dep of field.deps)dep.type=/^(?!selector$|urltest$).+/;
		}
	}
	const groupMembers=s.children.find(o=>o.option==='group_nodes');groupMembers.validate=nodeValidation;
	o=s.option(form.DummyValue,'_node_summary',_('Node / group details'));
	o.modalonly=false;
	o.cfgvalue=function(sid){
		const n=uci.get(data[0],sid) || {};
		if(n.node_mode==='reference')return _('Reference: %s').format(nodeName(n.node_base))+(n.local_detour && n.local_detour!=='_direct'?' · '+_('Via %s').format(nodeName(n.local_detour)):'');
		if(['selector','urltest'].includes(n.type)){
			const members=n.group_nodes || [];
			const selected=n.type==='selector'?_('Default: %s').format(groupLabel(n.group_default || members[0])):_('Automatic latency selection');
			return _('%s members').format(members.length)+' · '+selected+' — '+members.map(id=>uci.get(data[0],id,'label') || id).join(', ');
		}
		if(n.type==='tailscale')return n.tailscale_exit_node?_('Exit node: %s').format(n.tailscale_exit_node):_('Tailnet access');
		if(n.type==='direct')return _('Direct connection');
		return (n.address || '—')+(n.port?':'+n.port:'')+(n.tls==='1'?' · TLS':'')+(n.transport?' · '+n.transport:'');
	};
	return s;
}

return view.extend({
	load() {
		return Promise.all([
			uci.load('homeproxy'),
			hp.getBuiltinFeatures()
		]);
	},

	render(data) {
		let m, s, o, ss, so;
		let main_node = uci.get(data[0], 'config', 'main_node');
		let routing_mode = uci.get(data[0], 'config', 'routing_mode');
		let features = data[1];
		let nodeLabels = buildNodeLabels(data[0]);

		/* Cache subscription information, it will be called multiple times */
		let subinfo = [];
		for (let suburl of (uci.get(data[0], 'subscription', 'subscription_url') || [])) {
			const url = new URL(suburl);
			const urlhash = hp.calcStringMD5(suburl.replace(/#.*$/, ''));
			const title = url.hash ? decodeURIComponent(url.hash.slice(1)) : url.hostname;
			let sourceID;uci.sections(data[0],'subscription_source',s=>{if(s.url===suburl.replace(/#.*$/,''))sourceID=s['.name'];});
			subinfo.push({ 'hash': urlhash, 'title': title, 'id':sourceID });
		}
		const subscriptionTitleCounts = {};
		for (const info of subinfo)
			subscriptionTitleCounts[info.title] = (subscriptionTitleCounts[info.title] || 0) + 1;
		for (const info of subinfo)
			if (subscriptionTitleCounts[info.title] > 1)
				info.title += ' · ' + (info.id || info.hash).slice(-6);

		m = new form.Map('homeproxy', _('Edit nodes'));

		s = m.section(form.NamedSection, 'subscription', 'homeproxy');

		/* Node settings start */
		/* User nodes start */
		s.tab('node', _('Nodes'));
		o = s.taboption('node', form.SectionValue, '_node', form.GridSection, 'node');
		ss = renderNodeSettings(o.subsection, data, features, main_node, routing_mode, nodeLabels);
		ss.addremove = true;
		ss.filter = function(section_id) {
			for (let info of subinfo)
				if ((info.hash === uci.get(data[0], section_id, 'grouphash') || info.id && info.id === uci.get(data[0],section_id,'source_id')))
					return false;

			return true;
		}
		/* Import subscription links start */
		/* Thanks to luci-app-shadowsocks-libev */
		ss.handleLinkImport = function() {
			let textarea = new ui.Textarea();
			ui.showModal(_('Import share links'), [
				E('p', _('Supports sing-box JSON nodes and groups, SIP008, and proxy share-link subscriptions. DNS and routing rules are not imported.')),
				textarea.render(),
				E('div', { class: 'right' }, [
					E('button', {
						class: 'btn',
						click: ui.hideModal
					}, [ _('Cancel') ]),
					'',
					E('button', {
						class: 'btn cbi-button-action',
						click: ui.createHandlerFn(this, () => {
							let input_links = textarea.getValue().trim().split('\n');
							if (input_links && input_links[0]) {
								/* Remove duplicate lines */
								input_links = input_links.reduce((pre, cur) =>
									(!pre.includes(cur) && pre.push(cur), pre), []);

								let allow_insecure = uci.get(data[0], 'subscription', 'allow_insecure');
								let packet_encoding = uci.get(data[0], 'subscription', 'packet_encoding');
								let imported_node = 0;
								input_links.forEach((l) => {
									let config = parseShareLink(l, features);
									if (config) {
										if (config.tls === '1' && allow_insecure === '1')
											config.tls_insecure = '1'
										if (['vless', 'vmess'].includes(config.type))
											config.packet_encoding = packet_encoding

										let sid = uci.add(data[0], 'node');
										Object.keys(config).forEach((k) => {
											uci.set(data[0], sid, k, config[k]);
										});
										imported_node++;
									}
								});

								if (imported_node === 0)
									ui.addNotification(null, E('p', _('No valid share link found.')));
								else
									ui.addNotification(null, E('p', _('Successfully imported %s nodes of total %s.').format(
										imported_node, input_links.length)));

								return uci.save()
									.then(L.bind(this.map.load, this.map))
									.then(L.bind(this.map.reset, this.map))
									.then(L.ui.hideModal)
									.catch(() => {});
							} else {
								return ui.hideModal();
							}
						})
					}, [ _('Import') ])
				])
			])
		}
		ss.renderSectionAdd = function(/* ... */) {
			let el = form.GridSection.prototype.renderSectionAdd.apply(this, arguments),
				nameEl = el.querySelector('.cbi-section-create-name');

			ui.addValidator(nameEl, 'uciname', true, (v) => {
				let button = el.querySelector('.cbi-section-create > .cbi-button-add');
				let uciconfig = this.uciconfig || this.map.config;

				if (!v) {
					button.disabled = true;
					return true;
				} else if (uci.get(uciconfig, v)) {
					button.disabled = true;
					return _('Expecting: %s').format(_('unique UCI identifier'));
				} else {
					button.disabled = null;
					return true;
				}
			}, 'blur', 'keyup');

			el.appendChild(E('button', {
				'class': 'cbi-button cbi-button-add',
				'title': _('Import share links'),
				'click': ui.createHandlerFn(this, 'handleLinkImport')
			}, [ _('Import share links') ]));

			return el;
		}
		/* Import subscription links end */
		/* User nodes end */

		/* Subscription nodes start */
		for (const info of subinfo) {
			const tab = 'sub_' + info.hash;
			s.tab(tab, _('Sub (%s)').format(info.title));
			o = s.taboption(tab, form.Button, '_update_' + info.hash, _('Update nodes from subscriptions'));
			o.inputstyle = 'apply';
			o.inputtitle = function() {
				if (this.map.readonly) { this.readonly = true; return _('Read-only access'); }
				return _('Update this subscription');
			};
			o.onclick = function() {
				if (this.map.readonly) return;
				return fs.exec_direct('/etc/homeproxy/scripts/update_subscriptions.uc', [info.id || 'src_' + info.hash]).then(() => location.reload()).catch(err => {
					ui.addNotification(null, E('p', _('An error occurred during updating subscriptions: %s').format(err)));
				});
			};
			o = s.taboption(tab, form.SectionValue, '_sub_' + info.hash, form.GridSection, 'node');
			ss = renderNodeSettings(o.subsection, data, features, main_node, routing_mode, nodeLabels);
			ss.filter = function(section_id) {
				return ((uci.get(data[0], section_id, 'grouphash') === info.hash || info.id && uci.get(data[0],section_id,'source_id') === info.id));
			}
		}
		/* Subscription nodes end */
		/* Node settings end */

		/* Subscriptions settings start */
		s.tab('subscription', _('Subscriptions'));

		o = s.taboption('subscription', form.Flag, 'auto_update', _('Auto update'),
			_('Auto update subscriptions and geodata.'));
		o.rmempty = false;

		o = s.taboption('subscription', form.ListValue, 'auto_update_time', _('Update time'));
		for (let i = 0; i < 24; i++)
			o.value(i, i + ':00');
		o.default = '2';
		o.depends('auto_update', '1');

		o = s.taboption('subscription', form.Flag, 'update_via_proxy', _('Update via proxy'),
			_('Update subscriptions via proxy.'));
		o.rmempty = false;

		o = s.taboption('subscription', form.DynamicList, 'subscription_url', _('Subscription URL-s'),
			_('Supports sing-box JSON nodes and groups, SIP008, and proxy share-link subscriptions. DNS and routing rules are not imported.'));
		o.write = function(section, values) {
			const clean=v=>v.replace(/#.*$/,'');
			const old=(uci.get(data[0],section,'subscription_url') || []).map(clean), next=(values || []).map(clean);
			const removed=old.filter(v=>!next.includes(v)),added=next.filter(v=>!old.includes(v));
			// A single URL replacement retains its source identity (e.g. token rotation).
			if(removed.length===1 && added.length===1)uci.sections(data[0],'subscription_source',s=>{if(s.url===removed[0])uci.set(data[0],s['.name'],'url',added[0]);});
			uci.set(data[0],section,'subscription_url',values);
		};

		o.validate = function(section_id, value) {
			if (section_id && value) {
				try {
					let url = new URL(value);
					if (!url.hostname)
						return _('Expecting: %s').format(_('valid URL'));
				}
				catch(e) {
					return _('Expecting: %s').format(_('valid URL'));
				}
			}

			return true;
		}

		o = s.taboption('subscription', form.ListValue, 'filter_nodes', _('Filter nodes'),
			_('Drop/keep specific nodes from subscriptions.'));
		o.value('disabled', _('Disable'));
		o.value('blacklist', _('Blacklist mode'));
		o.value('whitelist', _('Whitelist mode'));
		o.default = 'disabled';
		o.rmempty = false;

		o = s.taboption('subscription', form.DynamicList, 'filter_keywords', _('Filter keywords'),
			_('Drop/keep nodes that contain the specific keywords. <a target="_blank" href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions">Regex</a> is supported.'));
		o.depends({'filter_nodes': 'disabled', '!reverse': true});
		o.rmempty = false;

		o = s.taboption('subscription', form.Value, 'user_agent', _('User-Agent'));
		o.placeholder = 'Wget/1.21 (HomeProxy, like v2rayN)';

		o = s.taboption('subscription', form.Flag, 'allow_insecure', _('Allow insecure'),
			_('Allow insecure connection by default when add nodes from subscriptions.') +
			'<br/>' +
			_('This is <strong>DANGEROUS</strong>, your traffic is almost like <strong>PLAIN TEXT</strong>! Use at your own risk!'));
		o.rmempty = false;
		o.onchange = allowInsecureConfirm;

		o = s.taboption('subscription', form.ListValue, 'packet_encoding', _('Default packet encoding'));
		o.value('', _('none'));
		o.value('packetaddr', _('packet addr (v2ray-core v5+)'));
		o.value('xudp', _('Xudp (Xray-core)'));

		o = s.taboption('subscription', form.Button, '_save_subscriptions', _('Save subscriptions settings'),
			_('NOTE: Save current settings before updating subscriptions.'));
		o.inputstyle = 'apply';
		o.inputtitle = _('Save current settings');
		o.onclick = function() {
			return this.map.save(null, true).then(() => ui.changes.apply(true)).then(() => location.reload());
		}

		o = s.taboption('subscription', form.Button, '_update_subscriptions', _('Update nodes from subscriptions'));
		o.inputstyle = 'apply';
		o.inputtitle = function(section_id) {
			if (this.map.readonly) { this.readonly = true; return _('Read-only access'); }
			let sublist = uci.get(data[0], section_id, 'subscription_url') || [];
			if (sublist.length > 0) {
				return _('Update %s subscriptions').format(sublist.length);
			} else {
				this.readonly = true;
				return _('No subscription available')
			}
		}
		o.onclick = function() {
			if (this.map.readonly) return;
			return fs.exec_direct('/etc/homeproxy/scripts/update_subscriptions.uc').then((res) => {
				return location.reload();
			}).catch((err) => {
				ui.addNotification(null, E('p', _('An error occurred during updating subscriptions: %s').format(err)));
				return this.map.reset();
			});
		}

		o = s.taboption('subscription', form.Button, '_remove_subscriptions', _('Remove all nodes from subscriptions'));
		o.inputstyle = 'reset';
		o.inputtitle = function() {
			if (this.map.readonly) { this.readonly = true; return _('Read-only access'); }
			let subnodes = [];
			uci.sections(data[0], 'node', (res) => {
				if (res.grouphash)
					subnodes = subnodes.concat(res['.name'])
			});

			if (subnodes.length > 0) {
				return _('Remove %s nodes').format(subnodes.length);
			} else {
				this.readonly = true;
				return _('No subscription node');
			}
		}
		o.onclick = function() {
			if (this.map.readonly) return;
			let subnodes = [];
			uci.sections(data[0], 'node', (res) => {
				if (res.grouphash)
					subnodes = subnodes.concat(res['.name'])
			});

			const references = nodeReferences(uci.sections(data[0]), subnodes);
			if (references.length) {
				ui.addNotification(null, E('p', {}, _('These nodes are still referenced. Update these settings before removing them:') + ' ' + references.join('; ')), 'error');
				return;
			}
			for (const id of subnodes) uci.remove(data[0], id);

			this.inputtitle = _('%s nodes removed').format(subnodes.length);
			this.readonly = true;

			return this.map.save(null, true);
		}
		/* Subscriptions settings end */

		return m.render();
	}
});
