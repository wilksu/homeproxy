/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Copyright (C) 2022-2025 ImmortalWrt.org
 */

'use strict';
'require form';
'require network';
'require poll';
'require rpc';
'require uci';
'require validation';
'require view';

'require homeproxy as hp';
'require tools.firewall as fwtool';
'require tools.widgets as widgets';

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

const callReadDomainList = rpc.declare({
	object: 'luci.homeproxy',
	method: 'acllist_read',
	params: ['type'],
	expect: { '': {} }
});

const callWriteDomainList = rpc.declare({
	object: 'luci.homeproxy',
	method: 'acllist_write',
	params: ['type', 'content'],
	expect: { '': {} }
});

function getServiceStatus() {
	return L.resolveDefault(callServiceList('homeproxy'), {}).then((res) => {
		let isRunning = false;
		try {
			isRunning = res['homeproxy']['instances']['sing-box-c']['running'];
		} catch (e) { }
		return isRunning;
	});
}

function renderStatus(isRunning, version) {
	let spanTemp = '<em><span style="color:%s"><strong>%s (sing-box v%s) %s</strong></span></em>';
	let renderHTML;
	if (isRunning)
		renderHTML = spanTemp.format('green', _('HomeProxy'), version, _('RUNNING'));
	else
		renderHTML = spanTemp.format('red', _('HomeProxy'), version, _('NOT RUNNING'));

	return renderHTML;
}

let stubValidator = {
	factory: validation,
	apply(type, value, args) {
		if (value != null)
			this.value = value;

		return validation.types[type].apply(this, args);
	},
	assert(condition) {
		return !!condition;
	}
};

return view.extend({
	load() {
		return Promise.all([
			uci.load('homeproxy'),
			hp.getBuiltinFeatures(),
			network.getHostHints()
		]);
	},

	render(data) {
		let m, s, o, ss, so;

		let features = data[1],
		    hosts = data[2]?.hosts;

		/* Cache all configured proxy nodes, they will be called multiple times */
		let proxy_nodes = {};
		uci.sections(data[0], 'node', (res) => {
			const isReference=res.node_mode==='reference';
			let inherited=res, seen=new Set();
			while(inherited.node_mode==='reference' && !seen.has(inherited['.name'])){seen.add(inherited['.name']);const base=uci.get(data[0],inherited.node_base);if(!base)break;inherited=base;}
			if(isReference)res={...inherited,'.name':res['.name'],label:res.label,type:inherited.type || _('Reference')};
			let nodeaddr = ((res.type === 'direct') ? res.override_address : res.address) || '',
			    nodeport = ((res.type === 'direct') ? res.override_port : res.port) || '';

			proxy_nodes[res['.name']] =
				String.format('[%s] %s', isReference ? _('Reference')+' · '+res.type : res.type, res.label || ((stubValidator.apply('ip6addr', nodeaddr) ?
					String.format('[%s]', nodeaddr) : nodeaddr) + ':' + nodeport));
			if(res.label && nodeaddr)proxy_nodes[res['.name']]+=' ('+nodeaddr+(nodeport?':'+nodeport:'')+')';
			if(res.grouphash) {
				const source=(uci.get(data[0],'subscription','subscription_url') || []).find(url=>hp.calcStringMD5(url.replace(/#.*$/,''))===res.grouphash);
				if(source){const url=new URL(source);proxy_nodes[res['.name']]+=' — '+(url.hash?decodeURIComponent(url.hash.slice(1)):url.hostname);}
			}

		});
		/* Keep common labels readable, but make truly identical choices unique. */
		const proxy_label_counts = {};
		for (const id in proxy_nodes)
			proxy_label_counts[proxy_nodes[id]] = (proxy_label_counts[proxy_nodes[id]] || 0) + 1;
		for (const id in proxy_nodes)
			if (proxy_label_counts[proxy_nodes[id]] > 1)
				proxy_nodes[id] += ' · ' + id.slice(-6);

		m = new form.Map('homeproxy', _('HomeProxy'),
			_('The modern ImmortalWrt proxy platform for ARM64/AMD64.'));

		// Rebuilding a map disposes old widget instances before removing their DOM.
		// Defer dependency events from those widgets until the new form is bound.
		const checkDepends = m.checkDepends, renderContents = m.renderContents;
		m.checkDepends = function(...args) {
			if (!this.rebuilding) return checkDepends.apply(this, args);
		};
		m.renderContents = function(...args) {
			this.rebuilding = true;
			return Promise.resolve().then(() => renderContents.apply(this, args)).finally(() => {
				this.rebuilding = false;
				this.checkDepends();
			});
		};

		s = m.section(form.TypedSection);
		s.render = function () {
			poll.add(function () {
				return L.resolveDefault(getServiceStatus()).then((res) => {
					let view = document.getElementById('service_status');
					view.innerHTML = renderStatus(res, features.version);
				});
			});

			return E('div', { class: 'cbi-section', id: 'status_bar' }, [
					E('p', { id: 'service_status' }, _('Collecting data...'))
			]);
		}

		s = m.section(form.NamedSection, 'config', 'homeproxy');

		s.tab('routing', _('Routing Settings'));

		o = s.taboption('routing', form.ListValue, 'main_node', _('Main node'));
		o.value('nil', _('Disable'));
		o.value('urltest', _('URLTest'));
		for (let i in proxy_nodes)
			o.value(i, proxy_nodes[i]);
		o.default = 'nil';
		o.depends({'routing_mode': /^custom$/, '!reverse': true});
		o.rmempty = false;

		o = s.taboption('routing', hp.CBIStaticList, 'main_urltest_nodes', _('URLTest nodes'),
			_('List of nodes to test.'));
		for (let i in proxy_nodes)
			o.value(i, proxy_nodes[i]);
		o.depends('main_node', 'urltest');
		o.rmempty = false;

		o = s.taboption('routing', form.Value, 'main_urltest_interval', _('Test interval'),
			_('The test interval in seconds.'));
		o.datatype = 'uinteger';
		o.placeholder = '180';
		o.depends('main_node', 'urltest');

		o = s.taboption('routing', form.Value, 'main_urltest_tolerance', _('Test tolerance'),
			_('The test tolerance in milliseconds.'));
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.depends('main_node', 'urltest');

		o = s.taboption('routing', form.ListValue, 'main_udp_node', _('Main UDP node'));
		o.value('nil', _('Disable'));
		o.value('same', _('Same as main node'));
		o.value('urltest', _('URLTest'));
		for (let i in proxy_nodes)
			o.value(i, proxy_nodes[i]);
		o.default = 'nil';
		o.depends({'routing_mode': /^(?!custom$).+$/, 'proxy_mode': /^((?!redirect$).)+$/});
		o.rmempty = false;

		o = s.taboption('routing', hp.CBIStaticList, 'main_udp_urltest_nodes', _('URLTest nodes'),
			_('List of nodes to test.'));
		for (let i in proxy_nodes)
			o.value(i, proxy_nodes[i]);
		o.depends('main_udp_node', 'urltest');
		o.rmempty = false;

		o = s.taboption('routing', form.Value, 'main_udp_urltest_interval', _('Test interval'),
			_('The test interval in seconds.'));
		o.datatype = 'uinteger';
		o.placeholder = '180';
		o.depends('main_udp_node', 'urltest');

		o = s.taboption('routing', form.Value, 'main_udp_urltest_tolerance', _('Test tolerance'),
			_('The test tolerance in milliseconds.'));
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.depends('main_udp_node', 'urltest');

		o = s.taboption('routing', form.Value, 'dns_server', _('DNS server'),
			_('Support UDP, TCP, DoH, DoQ, DoT. TCP protocol will be used if not specified.'));
		o.value('wan', _('WAN DNS (read from interface)'));
		o.value('https://cloudflare-dns.com/dns-query', _('Cloudflare DoH'));
		o.value('https://dns.alidns.com/dns-query', _('AliDNS DoH'));
		o.value('1.1.1.1', _('CloudFlare Public DNS (1.1.1.1)'));
		o.value('208.67.222.222', _('Cisco Public DNS (208.67.222.222)'));
		o.value('8.8.8.8', _('Google Public DNS (8.8.8.8)'));
		o.value('', '---');
		o.value('223.5.5.5', _('Aliyun Public DNS (223.5.5.5)'));
		o.value('119.29.29.29', _('Tencent Public DNS (119.29.29.29)'));
		o.value('117.50.10.10', _('ThreatBook Public DNS (117.50.10.10)'));
		o.default = '8.8.8.8';
		o.rmempty = false;
		o.depends({'routing_mode': /^custom$/, '!reverse': true});
		o.validate = function(section_id, value) {
			if (section_id && !['wan'].includes(value)) {
				if (!value)
					return _('Expecting: %s').format(_('non-empty value'));

				let ipv6_support = this.section.formvalue(section_id, 'ipv6_support');
				try {
					let url = new URL(value.replace(/^.*:\/\//, 'http://'));
					if (stubValidator.apply('hostname', url.hostname))
						return true;
					else if (stubValidator.apply('ip4addr', url.hostname))
						return true;
					else if ((ipv6_support === '1') && stubValidator.apply('ip6addr', url.hostname.match(/^\[(.+)\]$/)?.[1]))
						return true;
					else
						return _('Expecting: %s').format(_('valid DNS server address'));
				} catch(e) {}

				if (!stubValidator.apply((ipv6_support === '1') ? 'ipaddr' : 'ip4addr', value))
					return _('Expecting: %s').format(_('valid DNS server address'));
			}

			return true;
		}

		o = s.taboption('routing', form.Value, 'china_dns_server', _('China DNS server'),
			_('The dns server for resolving China domains. Support UDP, TCP, DoH, DoQ, DoT.'));
		o.value('wan', _('WAN DNS (read from interface)'));
		o.value('https://cloudflare-dns.com/dns-query', _('Cloudflare DoH'));
		o.value('https://dns.alidns.com/dns-query', _('AliDNS DoH'));
		o.value('223.5.5.5', _('Aliyun Public DNS (223.5.5.5)'));
		o.value('210.2.4.8', _('CNNIC Public DNS (210.2.4.8)'));
		o.value('119.29.29.29', _('Tencent Public DNS (119.29.29.29)'));
		o.value('117.50.10.10', _('ThreatBook Public DNS (117.50.10.10)'));
		o.depends('routing_mode', 'bypass_mainland_china');
		o.default = '223.5.5.5';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (section_id && !['wan'].includes(value)) {
				if (!value)
					return _('Expecting: %s').format(_('non-empty value'));

				try {
					let url = new URL(value.replace(/^.*:\/\//, 'http://'));
					if (stubValidator.apply('hostname', url.hostname))
						return true;
					else if (stubValidator.apply('ip4addr', url.hostname))
						return true;
					else if (stubValidator.apply('ip6addr', url.hostname.match(/^\[(.+)\]$/)?.[1]))
						return true;
					else
						return _('Expecting: %s').format(_('valid DNS server address'));
				} catch(e) {}

				if (!stubValidator.apply('ipaddr', value))
					return _('Expecting: %s').format(_('valid DNS server address'));
			}

			return true;
		}

		o = s.taboption('routing', form.ListValue, 'routing_mode', _('Routing mode'));
		o.value('gfwlist', _('GFWList'));
		o.value('bypass_mainland_china', _('Bypass mainland China'));
		o.value('proxy_mainland_china', _('Only proxy mainland China'));
		o.value('custom', _('Custom routing'));
		o.value('global', _('Global'));
		o.default = 'bypass_mainland_china';
		o.rmempty = false;
		o.onchange = function(ev, section_id, value) {
			if (section_id && value === 'custom')
				this.map.save(null, true);
		}

		o = s.taboption('routing', form.Value, 'routing_port', _('Routing ports'),
			_('Specify target ports to be proxied. Multiple ports must be separated by commas.'));
		o.value('', _('All ports'));
		o.value('common', _('Common ports only (bypass P2P traffic)'));
		o.validate = function(section_id, value) {
			if (section_id && value && value !== 'common') {

				let ports = [];
				for (let i of value.split(',')) {
					if (!stubValidator.apply('port', i) && !stubValidator.apply('portrange', i))
						return _('Expecting: %s').format(_('valid port value'));
					if (ports.includes(i))
						return _('Port %s alrealy exists!').format(i);
					ports = ports.concat(i);
				}
			}

			return true;
		}

		o = s.taboption('routing', form.ListValue, 'proxy_mode', _('Proxy mode'));
		o.value('redirect', _('Redirect TCP'));
		if (features.hp_has_tproxy)
			o.value('redirect_tproxy', _('Redirect TCP + TProxy UDP'));
		if (features.hp_has_ip_full && features.hp_has_tun) {
			o.value('redirect_tun', _('Redirect TCP + Tun UDP'));
			o.value('tun', _('Tun TCP/UDP'));
		} else {
			o.description = _('To enable Tun support, you need to install <code>ip-full</code> and <code>kmod-tun</code>');
		}
		o.default = 'redirect_tproxy';
		o.rmempty = false;

		o = s.taboption('routing', form.Flag, 'ipv6_support', _('IPv6 support'));
		o.default = o.enabled;
		o.rmempty = false;


		/* Custom routing settings start */
		/* Routing settings start */
		// Keep one form layout while binding these values to the routing section.
		const routingStart = s.children.length;
		so = s.taboption('routing', form.ListValue, 'tcpip_stack', _('TCP/IP stack'),
			_('TCP/IP stack.'));
		if (features.with_gvisor) {
			so.value('mixed', _('Mixed'));
			so.value('gvisor', _('gVisor'));
		}
		so.value('system', _('System'));
		so.default = 'system';
		so.depends('homeproxy.config.proxy_mode', 'redirect_tun');
		so.depends('homeproxy.config.proxy_mode', 'tun');
		so.rmempty = false;
		so.description = _('System uses the operating system network stack; mixed and gVisor require the corresponding core support.');

		for (let field of ['udp_mapping', 'udp_filtering']) {
			so = s.taboption('routing', form.ListValue, field, field === 'udp_mapping' ? _('UDP NAT mapping') : _('UDP NAT filtering'),
				field === 'udp_mapping'
					? _('Controls UDP mappings in the core, not the router firewall NAT. Endpoint independent reuses one mapping for all destinations; address dependent separates destinations by IP; address and port dependent separates them by IP and port. The default is endpoint independent.')
					: _('Controls which replies the core accepts for a UDP mapping. Endpoint independent accepts any remote endpoint; address dependent accepts IPs already contacted; address and port dependent accepts only IP and port pairs already contacted. This does not enable UDP support on a proxy node.'));

			so.value('endpoint_independent', _('Endpoint independent'));
			so.value('address_dependent', _('Address dependent'));
			so.value('address_and_port_dependent', _('Address and port dependent'));
			so.default = 'endpoint_independent';
		}
		so = s.taboption('routing', form.Value, 'udp_nat_max', _('Maximum UDP sessions'),
			_('Maximum UDP NAT sessions maintained by the core. When full, the least recently used session is closed. Empty or 0 lets sing-box choose a limit based on system memory; this does not change the router connection-tracking limit.'));
		so.datatype = 'uinteger';
		so.placeholder = _('Automatic');

		so = s.taboption('routing', form.Value, 'udp_timeout', _('UDP NAT expiration time'),
			_('Idle time in seconds before a UDP NAT session expires. Empty uses the core default of 300 seconds. This is not a connection-test timeout.'));
		so.datatype = 'uinteger';
		so.placeholder = '300';
		so.depends('homeproxy.config.proxy_mode', 'redirect_tproxy');
		so.depends('homeproxy.config.proxy_mode', 'redirect_tun');
		so.depends('homeproxy.config.proxy_mode', 'tun');

		so = s.taboption('routing', form.Flag, 'bypass_cn_traffic', _('Bypass CN traffic'),
			_('Bypass mainland China traffic via firewall rules by default.'));
		so.rmempty = false;

		so = s.taboption('routing', form.ListValue, 'domain_strategy', _('Domain strategy'),
			_('If set, the requested domain name will be resolved to IP before routing.'));
		so.retain = true;
		so.depends('homeproxy.config.routing_mode', 'custom');
		for (let i in hp.dns_strategy)
			so.value(i, hp.dns_strategy[i]);


		so = s.taboption('routing', form.ListValue, 'default_outbound', _('Default outbound'),
			_('Default outbound for connections not matched by any routing rules.'));
		so.retain = true;
		so.depends('homeproxy.config.routing_mode', 'custom');
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('nil', _('Disable (the service)'));
			this.value('direct-out', _('Direct'));
			this.value('block-out', _('Block'));
			for (const id in proxy_nodes) this.value(id, proxy_nodes[id]);
			uci.sections(data[0], 'routing_node', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.default = 'nil';
		so.rmempty = false;

		so = s.taboption('routing', form.ListValue, 'default_outbound_dns', _('Default outbound DNS'),
			_('Default DNS server for resolving domain name in the server address.'));
		so.retain = true;
		so.depends('homeproxy.config.routing_mode', 'custom');
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('default-dns', _('Default DNS (issued by WAN)'));
			this.value('system-dns', _('System DNS'));
			uci.sections(data[0], 'dns_server', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.default = 'default-dns';
		so.rmempty = false;
		for (const field of s.children.slice(routingStart)) {
			field.ucisection = 'routing'; field.retain = true;
			if (['udp_mapping','udp_filtering','udp_nat_max','udp_timeout'].includes(field.option)) {
				field.deps=[];
				for(const mode of ['redirect_tproxy','redirect_tun','tun']) {
					field.depends({proxy_mode:mode,routing_mode:'custom'});
					field.depends({proxy_mode:mode,routing_mode:/^(?!custom$).+$/,main_udp_node:/^(?!nil$).+/});
				}
			} else if (field.option !== 'tcpip_stack') {
				if (field.deps?.length) for (const dep of field.deps) dep['homeproxy.config.routing_mode'] = 'custom';
				else field.depends('routing_mode', 'custom');
			}
			if(field.option==='udp_timeout')field.cfgvalue=()=>uci.get(data[0],'routing','udp_timeout') || uci.get(data[0],'infra','udp_timeout') || '300';
		}
		/* Routing settings end */



		/* Routing rules start */
		s.tab('routing_rule', _('Routing Rules'));
		o = s.taboption('routing_rule', form.SectionValue, '_routing_rule', form.GridSection, 'routing_rule');
		o.retain = true;
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('Routing rule'), _('Add a routing rule'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss);

		ss.tab('field_other', _('Other fields'));
		ss.tab('field_host', _('Host/IP fields'));
		ss.tab('field_port', _('Port fields'));
		ss.tab('fields_process', _('Process fields'));

		so = ss.taboption('field_other', form.Value, 'label', _('Label'));
		so.load = L.bind(hp.loadDefaultLabel, this, data[0]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'routing_rule', 'label');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.taboption('field_other', form.ListValue, 'mode', _('Mode'),
			_('The default rule uses the following matching logic:<br/>' +
			'<code>(domain || domain_suffix || domain_keyword || domain_regex || ip_cidr || ip_is_private)</code> &&<br/>' +
			'<code>(port || port_range)</code> &&<br/>' +
			'<code>(source_ip_cidr || source_ip_is_private)</code> &&<br/>' +
			'<code>(source_port || source_port_range)</code> &&<br/>' +
			'<code>other fields</code>.<br/>' +
			'Only rule sets with one default rule without inversion use merged matching. Other rule sets match independently.'));
		so.value('default', _('Default'));
		so.default = 'default';
		so.rmempty = false;
		so.readonly = true;

		so = ss.taboption('field_other', form.ListValue, 'ip_version', _('IP version'),
			_('4 or 6. Not limited if empty.'));
		so.value('4', _('IPv4'));
		so.value('6', _('IPv6'));
		so.value('', _('Both'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.MultiValue, 'protocol', _('Protocol'),
			_('Sniffed protocol, see <a target="_blank" href="https://sing-box.sagernet.org/configuration/route/sniff/">Sniff</a> for details.'));
		so.value('bittorrent', _('BitTorrent'));
		so.value('dns', _('DNS'));
		so.value('dtls', _('DTLS'));
		so.value('http', _('HTTP'));
		so.value('quic', _('QUIC'));
		so.value('rdp', _('RDP'));
		so.value('ssh', _('SSH'));
		so.value('stun', _('STUN'));
		so.value('tls', _('TLS'));

		so = ss.taboption('field_other', form.Value, 'client', _('Client'),
			_('Sniffed client type (QUIC client type or SSH client name).'));
		so.value('chromium', _('Chromium / Cronet'));
		so.value('firefox', _('Firefox / uquic firefox'));
		so.value('quic-go', _('quic-go / uquic chrome'));
		so.value('safari', _('Safari / Apple Network API'));
		so.depends('protocol', 'quic');
		so.depends('protocol', 'ssh');
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'network', _('Network'));
		so.value('tcp', _('TCP'));
		so.value('udp', _('UDP'));
		so.value('', _('Both'));

		so = ss.taboption('field_other', form.DynamicList, 'user', _('User'),
			_('Match user name.'));
		so.modalonly = true;

		so = ss.taboption('field_other', hp.CBIStaticList, 'rule_set', _('Rule set'),
			_('Match rule set.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			uci.sections(data[0], 'ruleset', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'rule_set_ip_cidr_match_source', _('Rule set IP CIDR as source IP'),
			_('Make IP CIDR in rule set used to match the source IP.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'invert', _('Invert'),
			_('Invert match result.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'action', _('Action'));
		so.value('route', _('Route'));
		so.value('route-options', _('Route options'));
		so.value('reject', _('Reject'));
		so.value('resolve', _('Resolve'));
		so.default = 'route';
		so.rmempty = false;
		so.editable = true;

		so = ss.taboption('field_other', form.ListValue, 'outbound', _('Outbound'),
			_('Tag of the target outbound.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('direct-out', _('Direct'));
			for (const id in proxy_nodes) this.value(id, proxy_nodes[id]);
			uci.sections(data[0], 'routing_node', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.rmempty = false;
		so.depends('action', 'route');
		so.editable = true;

		so = ss.taboption('field_other', form.Value, 'override_address', _('Override address'),
			_('Override the connection destination address.'));
		so.datatype = 'ipaddr';
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'override_port', _('Override port'),
			_('Override the connection destination port.'));
		so.datatype = 'port';
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'udp_disable_domain_unmapping', _('Disable UDP domain unmapping'),
			_('If enabled, for UDP proxy requests addressed to a domain, the original packet address will be sent in the response instead of the mapped domain.'));
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'udp_connect', _('connect UDP connections'),
			_('If enabled, attempts to connect UDP connection to the destination instead of listen.'));
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'udp_timeout', _('UDP timeout'),
			_('Timeout for UDP connections.<br/>Setting a larger value than the UDP timeout in inbounds will have no effect.'));
		so.datatype = 'uinteger';
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'tls_record_fragment', _('TLS record fragment'),
			_('Fragment TLS handshake into multiple TLS records.'));
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'tls_fragment', _('TLS fragment'),
			_('Fragment TLS handshakes. Due to poor performance, try <code>%s</code> first.').format(
				_('TLS record fragment')));
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'tls_fragment_fallback_delay', _('Fragment fallback delay'),
			_('The fallback value in milliseconds used when TLS segmentation cannot automatically determine the wait time.'));
		so.datatype = 'uinteger';
		so.placeholder = '500';
		so.depends('tls_fragment', '1');
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'resolve_server', _('DNS server'),
			_('Specifies DNS server tag to use instead of selecting through DNS routing.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('', _('Default'));
			this.value('default-dns', _('Default DNS (issued by WAN)'));
			this.value('system-dns', _('System DNS'));
			uci.sections(data[0], 'dns_server', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.depends('action', 'resolve');
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'reject_method', _('Method'));
		so.value('default', _('Reply with TCP RST / ICMP port unreachable'));
		so.value('drop', _('Drop packets'));
		so.depends('action', 'reject');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'reject_no_drop', _('Don\'t drop packets'),
			_('<code>%s</code> will be temporarily overwritten to <code>%s</code> after 50 triggers in 30s if not enabled.').format(
			_('Method'), _('Drop packets')));
		so.depends('reject_method', 'default');
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'resolve_strategy', _('Resolve strategy'),
			_('Domain strategy for resolving the domain names.'));
		for (let i in hp.dns_strategy)
			so.value(i, hp.dns_strategy[i]);
		so.depends('action', 'resolve');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'resolve_disable_cache', _('Disable DNS cache'),
			_('Disable DNS cache in this query.'));
		so.depends('action', 'resolve');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'resolve_rewrite_ttl', _('Rewrite TTL'),
			_('Rewrite TTL in DNS responses.'));
		so.datatype = 'uinteger';
		so.depends('action', 'resolve');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'resolve_client_subnet', _('EDNS Client subnet'),
			_('Append a <code>edns0-subnet</code> OPT extra record with the specified IP prefix to every query by default.<br/>' +
			'If value is an IP address instead of prefix, <code>/32</code> or <code>/128</code> will be appended automatically.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.depends('action', 'resolve');
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain', _('Domain name'),
			_('Match full domain.'));
		so.datatype = 'hostname';
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_suffix', _('Domain suffix'),
			_('Match domain suffix.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_keyword', _('Domain keyword'),
			_('Match domain using keyword.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_regex', _('Domain regex'),
			_('Match domain using regular expression.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'source_ip_cidr', _('Source IP CIDR'),
			_('Match source IP CIDR.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.modalonly = true;

		so = ss.taboption('field_host', form.Flag, 'source_ip_is_private', _('Match private source IP'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'ip_cidr', _('IP CIDR'),
			_('Match IP CIDR.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.modalonly = true;

		so = ss.taboption('field_host', form.Flag, 'ip_is_private', _('Match private IP'));
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'source_port', _('Source port'),
			_('Match source port.'));
		so.datatype = 'port';
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'source_port_range', _('Source port range'),
			_('Match source port range. Format as START:/:END/START:END.'));
		so.validate = hp.validatePortRange;
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'port', _('Port'),
			_('Match port.'));
		so.datatype = 'port';
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'port_range', _('Port range'),
			_('Match port range. Format as START:/:END/START:END.'));
		so.validate = hp.validatePortRange;
		so.modalonly = true;

		so = ss.taboption('fields_process', form.DynamicList, 'process_name', _('Process name'),
			_('Match process name.'));
		so.modalonly = true;

		so = ss.taboption('fields_process', form.DynamicList, 'process_path', _('Process path'),
			_('Match process path.'));
		so.modalonly = true;

		so = ss.taboption('fields_process', form.DynamicList, 'process_path_regex', _('Process path (regex)'),
			_('Match process path using regular expression.'));
		so.modalonly = true;
		/* Routing rules end */

		/* DNS settings start */
		s.tab('dns', _('DNS Settings'));
		o = s.taboption('dns', form.SectionValue, '_dns', form.NamedSection, 'dns', 'homeproxy');
		o.retain = true;
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		so = ss.option(form.ListValue, 'default_strategy', _('Default DNS strategy'),
			_('The DNS strategy for resolving the domain name in the address.'));
		for (let i in hp.dns_strategy)
			so.value(i, hp.dns_strategy[i]);

		so = ss.option(form.ListValue, 'default_server', _('Default DNS server'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('default-dns', _('Default DNS (issued by WAN)'));
			this.value('system-dns', _('System DNS'));
			uci.sections(data[0], 'dns_server', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.default = 'default-dns';
		so.rmempty = false;

		so = ss.option(form.Flag, 'disable_cache', _('Disable DNS cache'));

		so = ss.option(form.Flag, 'disable_cache_expire', _('Disable cache expire'));
		so.depends('disable_cache', '0');

		so = ss.option(form.Flag, 'optimistic', _('Optimistic DNS cache'),
			_('Return expired cached answers while refreshing them in the background.'));
		so.depends('disable_cache', '0');
		so = ss.option(form.Value, 'timeout', _('DNS query timeout (seconds)'));
		so.datatype = 'uinteger';

		so = ss.option(form.Value, 'client_subnet', _('EDNS Client subnet'),
			_('Append a <code>edns0-subnet</code> OPT extra record with the specified IP prefix to every query by default.<br/>' +
			'If value is an IP address instead of prefix, <code>/32</code> or <code>/128</code> will be appended automatically.'));
		so.datatype = 'or(cidr, ipaddr)';

		so = ss.option(form.Flag, 'cache_file_store_dns', _('Persist DNS cache'),
			_('Store complete DNS responses until their TTL expires. Runtime storage is cleared on router reboot.'));

		/* DNS settings end */

		/* DNS servers start */
		s.tab('dns_server', _('DNS Servers'));
		o = s.taboption('dns_server', form.SectionValue, '_dns_server', form.GridSection, 'dns_server');
		o.retain = true;
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('DNS server'), _('Add a DNS server'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss);

		so = ss.option(form.Value, 'label', _('Label'));
		so.load = L.bind(hp.loadDefaultLabel, this, data[0]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'dns_server', 'label');
		so.modalonly = true;

		so = ss.option(form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.option(form.ListValue, 'type', _('Type'));
		so.value('udp', _('UDP'));
		so.value('tcp', _('TCP'));
		so.value('tls', _('TLS'));
		so.value('https', _('HTTPS'));
		so.value('h3', _('HTTP/3'));
		so.value('quic', _('QUIC'));
		so.default = 'udp';
		so.rmempty = false;

		so = ss.option(form.Value, 'server', _('Address'),
			_('The address of the dns server.'));
		so.datatype = 'or(hostname, ipaddr)';
		so.rmempty = false;

		so = ss.option(form.Value, 'server_port', _('Port'),
			_('The port of the DNS server.'));
		so.placeholder = 'auto';
		so.datatype = 'port';

		so = ss.option(form.Value, 'path', _('Path'),
			_('The path of the DNS server.'));
		so.placeholder = '/dns-query';
		so.depends('type', 'https');
		so.depends('type', 'h3');
		so.modalonly = true;

		so = ss.option(form.DynamicList, 'headers', _('Headers'),
			_('Additional headers to be sent to the DNS server.'));
		so.depends('type', 'https');
		so.depends('type', 'h3');
		so.modalonly = true;

		so = ss.option(form.Value, 'tls_sni', _('TLS SNI'),
			_('Used to verify the hostname on the returned certificates.'));
		so.depends('type', 'tls');
		so.depends('type', 'https');
		so.depends('type', 'h3');
		so.depends('type', 'quic');
		so.modalonly = true;

		so = ss.option(form.ListValue, 'address_resolver', _('Address resolver'),
			_('Tag of a another server to resolve the domain name in the address. Required if address contains domain.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('', _('None'));
			this.value('default-dns', _('Default DNS (issued by WAN)'));
			this.value('system-dns', _('System DNS'));
			uci.sections(data[0], 'dns_server', (res) => {
				if (res['.name'] !== section_id && res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.validate = function(section_id, value) {
			if (section_id && value) {
				let conflict = false;
				uci.sections(data[0], 'dns_server', (res) => {
					if (res['.name'] !== section_id)
						if (res.address_resolver === section_id && res['.name'] == value)
							conflict = true;
				});
				if (conflict)
					return _('Recursive resolver detected!');
			}

			return true;
		}
		so.modalonly = true;

		so = ss.option(form.ListValue, 'address_strategy', _('Address strategy'),
			_('The domain strategy for resolving the domain name in the address.'));
		for (let i in hp.dns_strategy)
			so.value(i, hp.dns_strategy[i]);
		so.depends({'address_resolver': '', '!reverse': true});
		so.modalonly = true;

		so = ss.option(form.ListValue, 'outbound', _('Outbound'),
			_('Tag of an outbound for connecting to the dns server.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('direct-out', _('Direct'));
			for (const id in proxy_nodes) this.value(id, proxy_nodes[id]);
			uci.sections(data[0], 'routing_node', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.default = 'direct-out';
		so.rmempty = false;
		so.editable = true;
		/* DNS servers end */

		/* DNS rules start */
		s.tab('dns_rule', _('DNS Rules'));
		o = s.taboption('dns_rule', form.SectionValue, '_dns_rule', form.GridSection, 'dns_rule');
		o.retain = true;
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('DNS rule'), _('Add a DNS rule'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss);

		ss.tab('field_other', _('Other fields'));
		ss.tab('field_host', _('Host/IP fields'));
		ss.tab('field_port', _('Port fields'));
		ss.tab('fields_process', _('Process fields'));

		so = ss.taboption('field_other', form.Value, 'label', _('Label'));
		so.load = L.bind(hp.loadDefaultLabel, this, data[0]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'dns_rule', 'label');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.taboption('field_other', form.ListValue, 'mode', _('Mode'),
			_('The default rule uses the following matching logic:<br/>' +
			'<code>(domain || domain_suffix || domain_keyword || domain_regex)</code> &&<br/>' +
			'<code>(port || port_range)</code> &&<br/>' +
			'<code>(source_ip_cidr || source_ip_is_private)</code> &&<br/>' +
			'<code>(source_port || source_port_range)</code> &&<br/>' +
			'<code>other fields</code>.<br/>' +
			'Only rule sets with one default rule without inversion use merged matching. Other rule sets match independently.'));
		so.value('default', _('Default'));
		so.default = 'default';
		so.rmempty = false;
		so.readonly = true;
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'ip_version', _('IP version'));
		so.value('4', _('IPv4'));
		so.value('6', _('IPv6'));
		so.value('', _('Both'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'query_type', _('Query type'),
			_('Match query type.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'network', _('Network'));
		so.value('tcp', _('TCP'));
		so.value('udp', _('UDP'));
		so.value('', _('Both'));

		so = ss.taboption('field_other', form.MultiValue, 'protocol', _('Protocol'),
			_('Sniffed protocol, see <a target="_blank" href="https://sing-box.sagernet.org/configuration/route/sniff/">Sniff</a> for details.'));
		so.value('bittorrent', _('BitTorrent'));
		so.value('dtls', _('DTLS'));
		so.value('http', _('HTTP'));
		so.value('quic', _('QUIC'));
		so.value('rdp', _('RDP'));
		so.value('ssh', _('SSH'));
		so.value('stun', _('STUN'));
		so.value('tls', _('TLS'));

		so = ss.taboption('field_other', form.DynamicList, 'user', _('User'),
			_('Match user name.'));
		so.modalonly = true;

		so = ss.taboption('field_other', hp.CBIStaticList, 'rule_set', _('Rule set'),
			_('Match rule set.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			uci.sections(data[0], 'ruleset', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.modalonly = true;

		so = ss.taboption('field_other', hp.CBIStaticList, 'rule_set_exclude', _('Excluded rule sets'),
			_('Also require that none of these rule sets match. Combined with the other conditions using AND.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			uci.sections(data[0], 'ruleset', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'rule_set_ip_cidr_match_source', _('Rule set IP CIDR as source IP'),
			_('Make IP CIDR in rule sets match the source IP.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'match_response', _('Match DNS response'),
			_('Evaluate a DNS response before matching IP filters or IP rule sets.'));
		so.modalonly = true;
		so = ss.taboption('field_other', form.Value, 'evaluate_server', _('Evaluation DNS server'),
			_('UCI DNS server section or default-dns/system-dns. Defaults to this rule’s DNS server.'));
		so.depends('match_response', '1');
		so.modalonly = true;
		so = ss.taboption('field_other', form.Value, 'timeout', _('DNS query timeout (seconds)'));
		so.datatype = 'uinteger';
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'invert', _('Invert'),
			_('Invert match result.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'action', _('Action'));
		so.value('route', _('Route'));
		so.value('route-options', _('Route options'));
		so.value('reject', _('Reject'));
		so.value('predefined', _('Predefined'));
		so.value('respond', _('Return evaluated response'));
		so.default = 'route';
		so.rmempty = false;
		so.editable = true;

		so = ss.taboption('field_other', form.ListValue, 'server', _('Server'),
			_('Tag of the target dns server.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('default-dns', _('Default DNS (issued by WAN)'));
			this.value('system-dns', _('System DNS'));
			uci.sections(data[0], 'dns_server', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.rmempty = false;
		so.editable = true;
		so.depends('action', 'route');

		so = ss.taboption('field_other', form.ListValue, 'domain_strategy', _('Domain strategy'),
			_('Restrict DNS answers to one address family. Ordering preferences belong to the resolver settings.'));
		so.value('', _('Both'));
		so.value('ipv4_only', _('IPv4 only'));
		so.value('ipv6_only', _('IPv6 only'));
		so.depends('action', 'route');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'dns_disable_cache', _('Disable dns cache'),
			_('Disable cache and save cache in this query.'));
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'rewrite_ttl', _('Rewrite TTL'),
			_('Rewrite TTL in DNS responses.'));
		so.datatype = 'uinteger';
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'client_subnet', _('EDNS Client subnet'),
			_('Append a <code>edns0-subnet</code> OPT extra record with the specified IP prefix to every query by default.<br/>' +
			'If value is an IP address instead of prefix, <code>/32</code> or <code>/128</code> will be appended automatically.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.depends('action', 'route');
		so.depends('action', 'route-options');
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'reject_method', _('Method'));
		so.value('default', _('Reply with REFUSED'));
		so.value('drop', _('Drop requests'));
		so.default = 'default';
		so.depends('action', 'reject');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'reject_no_drop', _('Don\'t drop requests'),
			_('<code>%s</code> will be temporarily overwritten to <code>%s</code> after 50 triggers in 30s if not enabled.').format(
				_('Method'), _('Drop requests')));
		so.depends('reject_method', 'default');
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'predefined_rcode', _('RCode'),
			_('The response code.'));
		so.value('NOERROR');
		so.value('FORMERR');
		so.value('SERVFAIL');
		so.value('NXDOMAIN');
		so.value('NOTIMP');
		so.value('REFUSED');
		so.default = 'NOERROR';
		so.depends('action', 'predefined');
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'predefined_answer', _('Answer'),
			_('List of text DNS record to respond as answers.'));
		so.depends('action', 'predefined');
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'predefined_ns', _('NS'),
			_('List of text DNS record to respond as name servers.'));
		so.depends('action', 'predefined');
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'predefined_extra', _('Extra records'),
			_('List of text DNS record to respond as extra records.'));
		so.depends('action', 'predefined');
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain', _('Domain name'),
			_('Match full domain.'));
		so.datatype = 'hostname';
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_suffix', _('Domain suffix'),
			_('Match domain suffix.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_keyword', _('Domain keyword'),
			_('Match domain using keyword.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_regex', _('Domain regex'),
			_('Match domain using regular expression.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'source_ip_cidr', _('Source IP CIDR'),
			_('Match source IP CIDR.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.modalonly = true;

		so = ss.taboption('field_host', form.Flag, 'source_ip_is_private', _('Match private source IP'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'ip_cidr', _('IP CIDR'),
			_('Match IP CIDR with query response. Current rule will be skipped if not match.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.modalonly = true;

		so = ss.taboption('field_host', form.Flag, 'ip_is_private', _('Match private IP'),
			_('Match private IP with query response.'));
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'source_port', _('Source port'),
			_('Match source port.'));
		so.datatype = 'port';
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'source_port_range', _('Source port range'),
			_('Match source port range. Format as START:/:END/START:END.'));
		so.validate = hp.validatePortRange;
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'port', _('Port'),
			_('Match port.'));
		so.datatype = 'port';
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'port_range', _('Port range'),
			_('Match port range. Format as START:/:END/START:END.'));
		so.validate = hp.validatePortRange;
		so.modalonly = true;

		so = ss.taboption('fields_process', form.DynamicList, 'process_name', _('Process name'),
			_('Match process name.'));
		so.modalonly = true;

		so = ss.taboption('fields_process', form.DynamicList, 'process_path', _('Process path'),
			_('Match process path.'));
		so.modalonly = true;

		so = ss.taboption('fields_process', form.DynamicList, 'process_path_regex', _('Process path (regex)'),
			_('Match process path using regular expression.'));
		so.modalonly = true;
		/* DNS rules end */
		/* Custom routing settings end */

		/* Rule set settings start */
		s.tab('ruleset', _('Rule Set'));
		o = s.taboption('ruleset', form.SectionValue, '_ruleset', form.GridSection, 'ruleset');
		o.retain = true;
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('Rule set'), _('Add a rule set'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss);

		so = ss.option(form.Value, 'label', _('Label'));
		so.load = L.bind(hp.loadDefaultLabel, this, data[0]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'ruleset', 'label');
		so.modalonly = true;

		so = ss.option(form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.option(form.ListValue, 'type', _('Type'));
		so.value('local', _('Local'));
		so.value('remote', _('Remote'));
		so.default = 'remote';
		so.rmempty = false;

		so = ss.option(form.ListValue, 'format', _('Format'));
		so.value('binary', _('Binary file'));
		so.value('source', _('Source file'));
		so.default = 'binary';
		so.rmempty = false;

		so = ss.option(form.Value, 'path', _('Path'));
		so.datatype = 'file';
		so.placeholder = '/etc/homeproxy/ruleset/example.json';
		so.rmempty = false;
		so.depends('type', 'local');
		so.modalonly = true;

		so = ss.option(form.Value, 'url', _('Rule set URL'));
		so.validate = function(section_id, value) {
			if (section_id) {
				if (!value)
					return _('Expecting: %s').format(_('non-empty value'));

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
		so.rmempty = false;
		so.depends('type', 'remote');
		so.modalonly = true;

		so = ss.option(form.ListValue, 'outbound', _('Outbound'),
			_('Tag of the outbound to download rule set.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('', _('Default'));
			this.value('direct-out', _('Direct'));
			for (const id in proxy_nodes) this.value(id, proxy_nodes[id]);
			uci.sections(data[0], 'routing_node', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.depends('type', 'remote');

		so = ss.option(form.Value, 'update_interval', _('Update interval'),
			_('Update interval of rule set.'));
		so.placeholder = '1d';
		so.depends('type', 'remote');
		/* Rule set settings end */

		/* ACL settings start */
		s.tab('control', _('Access Control'));

		o = s.taboption('control', form.SectionValue, '_control', form.NamedSection, 'control', 'homeproxy');
		ss = o.subsection;

		/* Interface control start */
		ss.tab('interface', _('Interface Control'));

		so = ss.taboption('interface', widgets.DeviceSelect, 'listen_interfaces', _('Listen interfaces'),
			_('Only process traffic from specific interfaces. Leave empty for all.'));
		so.multiple = true;
		so.noaliases = true;

		so = ss.taboption('interface', widgets.DeviceSelect, 'bind_interface', _('Bind interface'),
			_('Bind outbound traffic to specific interface. Leave empty to auto detect.'));
		so.multiple = false;
		so.noaliases = true;
		/* Interface control end */

		/* LAN IP policy start */
		ss.tab('lan_ip_policy', _('LAN IP Policy'));

		so = ss.taboption('lan_ip_policy', form.ListValue, 'lan_proxy_mode', _('Proxy filter mode'));
		so.value('disabled', _('Disable'));
		so.value('listed_only', _('Proxy listed only'));
		so.value('except_listed', _('Proxy all except listed'));
		so.default = 'disabled';
		so.rmempty = false;

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_direct_ipv4_ips', _('Direct IPv4 IP-s'), null, 'ipv4', hosts, true);
		so.depends('lan_proxy_mode', 'except_listed');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_direct_ipv6_ips', _('Direct IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends({'lan_proxy_mode': 'except_listed', 'homeproxy.config.ipv6_support': '1'});

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_direct_mac_addrs', _('Direct MAC-s'), null, hosts);
		so.depends('lan_proxy_mode', 'except_listed');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_proxy_ipv4_ips', _('Proxy IPv4 IP-s'), null, 'ipv4', hosts, true);
		so.depends('lan_proxy_mode', 'listed_only');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_proxy_ipv6_ips', _('Proxy IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends({'lan_proxy_mode': 'listed_only', 'homeproxy.config.ipv6_support': '1'});

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_proxy_mac_addrs', _('Proxy MAC-s'), null, hosts);
		so.depends('lan_proxy_mode', 'listed_only');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_gaming_mode_ipv4_ips', _('Gaming mode IPv4 IP-s'), null, 'ipv4', hosts, true);

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_gaming_mode_ipv6_ips', _('Gaming mode IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends('homeproxy.config.ipv6_support', '1');

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_gaming_mode_mac_addrs', _('Gaming mode MAC-s'), null, hosts);

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_global_proxy_ipv4_ips', _('Global proxy IPv4 IP-s'), null, 'ipv4', hosts, true);
		so.depends({'homeproxy.config.routing_mode': /^custom$/, '!reverse': true});

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_global_proxy_ipv6_ips', _('Global proxy IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends({'homeproxy.config.routing_mode': /^(?!custom$).+$/, 'homeproxy.config.ipv6_support': '1'});

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_global_proxy_mac_addrs', _('Global proxy MAC-s'), null, hosts);
		so.depends({'homeproxy.config.routing_mode': /^custom$/, '!reverse': true});
		/* LAN IP policy end */

		/* WAN IP policy start */
		ss.tab('wan_ip_policy', _('WAN IP Policy'));

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_proxy_ipv4_ips', _('Proxy IPv4 IP-s'));
		so.datatype = 'or(ip4addr, cidr4)';

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_proxy_ipv6_ips', _('Proxy IPv6 IP-s'));
		so.datatype = 'or(ip6addr, cidr6)';
		so.depends('homeproxy.config.ipv6_support', '1');

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_direct_ipv4_ips', _('Direct IPv4 IP-s'));
		so.datatype = 'or(ip4addr, cidr4)';

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_direct_ipv6_ips', _('Direct IPv6 IP-s'));
		so.datatype = 'or(ip6addr, cidr6)';
		so.depends('homeproxy.config.ipv6_support', '1');
		/* WAN IP policy end */

		/* Proxy domain list start */
		ss.tab('proxy_domain_list', _('Proxy Domain List'));

		so = ss.taboption('proxy_domain_list', form.TextValue, '_proxy_domain_list');
		so.rows = 10;
		so.monospace = true;
		so.datatype = 'hostname';
		so.depends({'homeproxy.config.routing_mode': /^custom$/, '!reverse': true});
		so.load = function(/* ... */) {
			return L.resolveDefault(callReadDomainList('proxy_list')).then((res) => {
				return res.content;
			}, {});
		}
		so.write = function(_section_id, value) {
			return callWriteDomainList('proxy_list', value);
		}
		so.remove = function(/* ... */) {
			let routing_mode = this.section.formvalue('config', 'routing_mode');
			if (routing_mode !== 'custom')
				return callWriteDomainList('proxy_list', '');
			return true;
		}
		so.validate = function(section_id, value) {
			if (section_id && value)
				for (let i of value.split('\n'))
					if (i && !stubValidator.apply('hostname', i))
						return _('Expecting: %s').format(_('valid hostname'));

			return true;
		}
		/* Proxy domain list end */

		/* Direct domain list start */
		ss.tab('direct_domain_list', _('Direct Domain List'));

		so = ss.taboption('direct_domain_list', form.TextValue, '_direct_domain_list');
		so.rows = 10;
		so.monospace = true;
		so.datatype = 'hostname';
		so.depends({'homeproxy.config.routing_mode': /^custom$/, '!reverse': true});
		so.load = function(/* ... */) {
			return L.resolveDefault(callReadDomainList('direct_list')).then((res) => {
				return res.content;
			}, {});
		}
		so.write = function(_section_id, value) {
			return callWriteDomainList('direct_list', value);
		}
		so.remove = function(/* ... */) {
			let routing_mode = this.section.formvalue('config', 'routing_mode');
			if (routing_mode !== 'custom')
				return callWriteDomainList('direct_list', '');
			return true;
		}
		so.validate = function(section_id, value) {
			if (section_id && value)
				for (let i of value.split('\n'))
					if (i && !stubValidator.apply('hostname', i))
						return _('Expecting: %s').format(_('valid hostname'));

			return true;
		}
		/* Direct domain list end */
		/* ACL settings end */

		return m.render();
	}
});
