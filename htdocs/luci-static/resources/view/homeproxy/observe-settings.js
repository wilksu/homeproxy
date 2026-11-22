/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
'require baseclass';
'require form';
'require uci';
'require ui';
'require rpc';
const getSecret = rpc.declare({ object: 'luci.homeproxy', method: 'api_secret', expect: { '': {} } });
const launchDashboard = rpc.declare({ object: 'luci.homeproxy', method: 'dashboard_launch', params: ['instance'], expect: { '': {} } });

function browserAPIURL(address) {
	const url = new URL(address);
	const host = window.location.hostname;
	// Keep access through a local port forward on the browser's loopback.
	if (['localhost', '127.0.0.1', '[::1]'].includes(host))
		url.hostname = host;
	return url;
}

async function openDashboard(instance) {
	const tab = window.open('', '_blank');
	if (tab) tab.opener = null;
	try {
		const result = await launchDashboard(instance);
		if (!result?.url || !result?.secret)
			throw new Error(result?.error || _('Unable to open the sing-box Dashboard.'));
		const url = browserAPIURL(result.url);
		url.hash = new URLSearchParams({ secret: result.secret }).toString();
		const target = tab || window;
		if (window.location.protocol === 'https:' && url.protocol === 'http:') {
			target.location.replace(url.href);
			return;
		}
		// The Dashboard service worker handles GET navigations in its scope.
		// An empty POST loads the launcher even in an existing browser profile.
		const form = target.document.createElement('form');
		form.method = 'post';
		form.action = url.href;
		target.document.body.appendChild(form);
		form.submit();
	} catch (error) {
		tab?.close();
		throw error;
	}
}

return baseclass.extend({
	async open(runtime, instance = 'client') {
		await uci.load('homeproxy');
		const created = !uci.get('homeproxy', 'observability');
		if (created) {
			uci.add('homeproxy', 'homeproxy', 'observability');
			uci.set('homeproxy', 'observability', 'enabled', '1');
			uci.set('homeproxy', 'observability', 'external', '0');
			uci.set('homeproxy', 'observability', 'client_port', '5334');
			uci.set('homeproxy', 'observability', 'server_port', '5335');
		}
		const m = new form.Map('homeproxy', null, _('Local monitoring uses an internal Clash API automatically. Applying connection settings restarts HomeProxy.'));
		const s = m.section(form.NamedSection, 'observability', 'homeproxy');
		let o = s.option(form.Flag, 'native_api', _('Enable sing-box gRPC API'),
			_('Allows the official sing-box clients and Dashboard to connect directly with the API secret.'));
		o.default = '0'; o.rmempty = false;
		o = s.option(form.DummyValue, '_native_endpoint', _('sing-box gRPC address'));
		o.depends('native_api', '1');
		o.renderWidget = () => E('div', {}, [
			runtime?.running && runtime.grpc_url
				? E('input', { class: 'cbi-input-text', readonly: true, value: browserAPIURL(runtime.grpc_url).origin, 'aria-label': _('sing-box gRPC address') })
				: E('p', {}, _('The address appears after applying settings and starting this instance.')),
			runtime?.running && runtime.grpc_dashboard ? E('button', {
				type: 'button', class: 'btn cbi-button cbi-button-action',
				click: ui.createHandlerFn(this, () => openDashboard(instance))
			}, _('Open sing-box Dashboard')) : null
		]);
		o = s.option(form.Flag, 'external', _('Allow LAN API access'),
			_('Enabled APIs listen on the LAN address. The default listen address is 127.0.0.1.'));
		o.default = '0'; o.rmempty = false;
		o = s.option(form.Flag, 'native_dashboard', _('Serve the official Dashboard locally'),
			_('Open the Dashboard directly from LuCI using this instance’s connection settings.'));
		o.default = '0'; o.rmempty = false; o.retain = true;
		o.depends({ native_api: '1', external: '1' });
		o = s.option(form.Value, 'listen', _('LAN listen address'), _('Leave empty to use the LAN IPv4 address. This does not open WAN firewall access.'));
		o.datatype = 'ipaddr'; o.depends('external', '1'); o.retain = true;
		o = s.option(form.DynamicList, 'allowed_origins', _('Allowed Dashboard origins'),
			_('Enter trusted Dashboard origins. The default origins are MetaCubeXD for Clash and the official sing-box Dashboard for gRPC.'));
		o.depends('external', '1'); o.retain = true;
		o.validate = (sid, v) => !v || /^https?:\/\/[^/?#\s]+$/.test(v) || _('Enter an HTTP(S) origin without a path.');
		o = s.option(form.DummyValue, '_secret', _('Connection secret')); o.depends('external', '1'); o.depends('native_api', '1');
		o.renderWidget = () => {
			const input = E('input', { class: 'cbi-input-text', readonly: true, hidden: true, 'aria-label': _('API secret') });
			const reveal = E('button', { type: 'button', class: 'btn cbi-button cbi-button-action', click: ui.createHandlerFn(this, async () => {
				const result = await getSecret(); input.value = result.secret || ''; input.hidden = false;
			}) }, _('Show secret'));
			return E('div', {}, [reveal, input]);
		};
		o = s.option(form.Flag, '_advanced', _('Advanced connection settings'));
		o.depends('external', '1'); o.depends('native_api', '1');
		o.write = () => {}; o.remove = () => {};
		const ports = [
			['client_port', _('Client API port'), '5334'],
			['server_port', _('Server API port'), '5335'],
			['native_client_port', _('Client gRPC port'), '5336'],
			['native_server_port', _('Server gRPC port'), '5337']
		];
		const server = uci.get('homeproxy', 'server', 'enabled') === '1';
		for (const [key, label, port] of ports) {
			if (key.endsWith('server_port') && !server) continue;
			o = s.option(form.Value, key, label); o.default = port; o.datatype = 'port'; o.retain = true;
			o.depends({ [key.startsWith('native_') ? 'native_api' : 'external']: '1', _advanced: '1' });
			o.validate = function(sid, value) {
				const native = m.lookupOption('native_api', sid)?.[0]?.formvalue(sid) === '1';
				for (const [otherKey, , defaultPort] of ports) {
					if (otherKey === key || (otherKey.startsWith('native_') && (!native || (!server && otherKey.endsWith('server_port'))))) continue;
					const other = m.lookupOption(otherKey, sid)?.[0];
					const otherPort = other?.formvalue(sid) || uci.get('homeproxy', sid, otherKey) || defaultPort;
					if (value && Number(value) === Number(otherPort)) return _('API ports must be distinct.');
				}
				return true;
			};
		}
		for (const [key, label] of [['native_tls_cert', _('gRPC TLS certificate path')], ['native_tls_key', _('gRPC TLS private key path')]]) {
			o = s.option(form.Value, key, label); o.datatype = 'file'; o.retain = true;
			o.depends({ native_api: '1', _advanced: '1' });
			o.validate = function(sid, value) {
				const peer = m.lookupOption(key === 'native_tls_cert' ? 'native_tls_key' : 'native_tls_cert', sid)?.[0];
				return !!value === !!peer?.formvalue(sid) || _('Provide both TLS certificate and private key, or leave both empty.');
			};
		}
		const logs = m.section(form.NamedSection, instance === 'server' ? 'server' : 'config', 'homeproxy');
		o = logs.option(form.ListValue, 'log_level', instance === 'server' ? _('Server log level') : _('Client log level'),
			_('Info records core startup and connection activity. Warn records warnings and errors.'));
		for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic'])
			o.value(level, level);
		o.default = 'warn';
		o.rmempty = false;
		const content = await m.render();
		ui.showModal(_('Observability settings'), [content, E('div', { class: 'right' }, [
			E('button', { class: 'btn', click: () => { if (created) uci.remove('homeproxy', 'observability'); ui.hideModal(); } }, _('Cancel')), ' ',
			E('button', { class: 'btn cbi-button-positive', click: ui.createHandlerFn(this, async () => {
				await m.save();
				uci.set('homeproxy', 'observability', 'enabled', '1');
				await uci.save(); ui.hideModal(); await ui.changes.apply(true);
			}) }, _('Save & Apply'))
		])]);
	}
});
