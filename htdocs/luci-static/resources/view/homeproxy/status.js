/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Copyright (C) 2022-2025 ImmortalWrt.org
 */

'use strict';
'require dom';
'require form';
'require fs';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';

/* Thanks to luci-app-aria2 */
const css = '				\
#log_textarea {				\
	padding: 10px;			\
	text-align: left;		\
}					\
#log_textarea pre {			\
	padding: .5rem;			\
	word-break: break-all;		\
	margin: 0;			\
}					\
.description {				\
	background-color: #33ccff;	\
}';

const hp_dir = '/var/run/homeproxy';

let nativeAPILoad;
function loadNativeAPI() {
	if (window.HomeProxyAPI) return Promise.resolve();
	if (!nativeAPILoad) nativeAPILoad = new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = L.resource('homeproxy-api.js') + '?v=20260910-stream1';
		script.onload = resolve;
		script.onerror = () => { nativeAPILoad = null; script.remove(); reject(new Error(_('Cannot load API client'))); };
		document.head.appendChild(script);
	});
	return nativeAPILoad;
}

function getUDPConnStat(o) {
	const getRuntime = rpc.declare({ object: 'luci.homeproxy', method: 'runtime', params: ['instance'], expect: { '': {} } });
	const result = E('strong', { role: 'status', 'aria-live': 'polite' }, _('unchecked'));
	const server = 'stun.cloudflare.com:3478';
	let controller;
	const check = E('button', { type: 'button', class: 'btn cbi-button cbi-button-action', click: ui.createHandlerFn(this, async () => {
		if (controller) { controller.abort(); return; }
		controller = new AbortController();
		check.textContent = _('Cancel');
		result.textContent = _('Checking…'); result.style.color = '';
		result.title = '';
		let timedOut = false, received = false;
		const timer = setTimeout(() => { timedOut = true; controller?.abort(); }, 25000);
		const abort = () => controller?.abort();
		const hidden = () => { if (document.hidden) abort(); };
		window.addEventListener('pagehide', abort);
		document.addEventListener('visibilitychange', hidden);
		const observer = new MutationObserver(() => { if (!result.isConnected) abort(); });
		observer.observe(document.body, { childList: true, subtree: true });
		try {
			const [, runtime] = await Promise.all([loadNativeAPI(), getRuntime('client')]);
			if (controller.signal.aborted) throw new Error('cancelled');
			if (!runtime.running || !runtime.compatible || !runtime.api?.enabled || !runtime.udp_outbound)
				throw new Error(_('Start the paired core with API enabled first.'));
			const client = new window.HomeProxyAPI.Client('client');
			const version = await client.call('GetVersion', {}, controller.signal);
			if (version.version !== runtime.expected || version.apiVersion !== runtime.api_version)
				throw new Error(_('Core/API version is outside the supported pairing.'));
			for await (const message of client.stream('StartSTUNTest', { server, outboundTag: runtime.udp_outbound }, controller.signal)) {
				if (message.externalAddr) {
					received = true;
					result.textContent = _('passed');
					result.title = message.latencyMs + ' ms';
					result.style.color = 'green';
					break; // Binding response proves UDP return traffic; NAT classification is separate.
				}
				if (message.error) throw new Error(message.error);
			}
			if (!received) throw new Error(_('No valid STUN response received.'));
		} catch (error) {
			result.style.color = 'red';
			result.textContent = timedOut ? _('Timed out') : controller.signal.aborted ? _('Cancelled') : _('failed');
			if (!controller.signal.aborted) result.title = error.message;
		} finally {
			clearTimeout(timer); controller.abort(); controller = null;
			observer.disconnect(); window.removeEventListener('pagehide', abort); document.removeEventListener('visibilitychange', hidden);
			check.textContent = _('Check');
		}
	}) }, _('Check'));
	o.default = E('div', {}, [check, ' ', result]);
}

function getConnStat(o, site) {
	const callConnStat = rpc.declare({
		object: 'luci.homeproxy',
		method: 'connection_check',
		params: ['site'],
		expect: { '': {} }
	});

	o.default = E('div', { 'style': 'cbi-value-field' }, [
		E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, () => {
				return L.resolveDefault(callConnStat(site), {}).then((ret) => {
                                        let ele = o.default.firstElementChild.nextElementSibling;
					if (ret.result) {
						ele.style.setProperty('color', 'green');
                                                ele.innerHTML = _('passed');
					} else {
						ele.style.setProperty('color', 'red');
                                                ele.innerHTML = _('failed');
					}
				});
			})
		}, [ _('Check') ]),
		' ',
		E('strong', { 'style': 'color:gray' }, _('unchecked')),
	]);
}

function getResVersion(o, type) {
	const callResVersion = rpc.declare({
		object: 'luci.homeproxy',
		method: 'resources_get_version',
		params: ['type'],
		expect: { '': {} }
	});

	const callResUpdate = rpc.declare({
		object: 'luci.homeproxy',
		method: 'resources_update',
		params: ['type'],
		expect: { '': {} }
	});

	return L.resolveDefault(callResVersion(type), {}).then((res) => {
		let spanTemp = E('div', { 'style': 'cbi-value-field' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, () => {
					return L.resolveDefault(callResUpdate(type), {}).then((res) => {
						switch (res.status) {
						case 0:
							o.description = _('Successfully updated.');
							break;
						case 1:
							o.description = _('Update failed.');
							break;
						case 2:
							o.description = _('Already in updating.');
							break;
						case 3:
							o.description = _('Already at the latest version.');
							break;
						default:
							o.description = _('Unknown error.');
							break;
						}

						return o.map.reset();
					});
				})
			}, [ _('Check update') ]),
			' ',
			E('strong', { 'style': (res.error ? 'color:red' : 'color:green') },
				[ res.error ? 'not found' : res.version ]
			),
		]);

		o.default = spanTemp;
	});
}

function getRuntimeLog(o, name, _option_index, section_id, _in_table) {
	const filename = o.option.split('_')[1];

	const callLogClean = rpc.declare({
		object: 'luci.homeproxy',
		method: 'log_clean',
		params: ['type'],
		expect: { '': {} }
	});

	const log_textarea = E('div', { 'id': 'log_textarea' },
		E('img', {
			'src': L.resource('icons/loading.svg'),
			'alt': _('Loading'),
			'style': 'vertical-align:middle'
		}, _('Collecting data...'))
	);

	let log;
	poll.add(L.bind(() => {
		return fs.read_direct(String.format('%s/%s.log', hp_dir, filename), 'text')
		.then((res) => {
			log = E('pre', { 'wrap': 'pre' }, [
				res.trim() || _('Log is empty.')
			]);

			dom.content(log_textarea, log);
		}).catch((err) => {
			if (err.toString().includes('NotFoundError'))
				log = E('pre', { 'wrap': 'pre' }, [
					_('Log file does not exist.')
				]);
			else
				log = E('pre', { 'wrap': 'pre' }, [
					_('Unknown error: %s').format(err)
				]);

			dom.content(log_textarea, log);
		});
	}));

	return E([
		E('style', [ css ]),
		E('div', {'class': 'cbi-map'}, [
			E('h3', {'name': 'content', 'style': 'align-items: center; display: flex;'}, [
				_('%s log').format(name),
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'style': 'margin-left: 4px;',
					'click': ui.createHandlerFn(this, () => {
						return L.resolveDefault(callLogClean(filename), {});
					})
				}, [ _('Clean log') ])
			]),
			E('div', {'class': 'cbi-section'}, [
				log_textarea,
				E('div', {'style': 'text-align:right'},
					E('small', {}, _('Refresh every %s seconds.').format(L.env.pollinterval))
				)
			])
		])
	]);
}

return view.extend({
	render() {
		let m, s, o;

		m = new form.Map('homeproxy');

		s = m.section(form.NamedSection, 'config', 'homeproxy', _('Connection check'));
		s.anonymous = true;

		o = s.option(form.DummyValue, '_check_baidu', _('BaiDu') + ' (HTTPS/TCP)');
		o.cfgvalue = L.bind(getConnStat, this, o, 'baidu');

		o = s.option(form.DummyValue, '_check_google', _('Google') + ' (HTTPS/TCP)');
		o.cfgvalue = L.bind(getConnStat, this, o, 'google');

		o = s.option(form.DummyValue, '_check_udp', 'UDP (STUN)');
		o.cfgvalue = L.bind(getUDPConnStat, this, o);

		s = m.section(form.NamedSection, 'config', 'homeproxy', _('Resources management'));
		s.anonymous = true;

		o = s.option(form.DummyValue, '_china_ip4_version', _('China IPv4 list version'));
		o.cfgvalue = L.bind(getResVersion, this, o, 'china_ip4');
		o.rawhtml = true;

		o = s.option(form.DummyValue, '_china_ip6_version', _('China IPv6 list version'));
		o.cfgvalue = L.bind(getResVersion, this, o, 'china_ip6');
		o.rawhtml = true;

		o = s.option(form.DummyValue, '_china_list_version', _('China list version'));
		o.cfgvalue = L.bind(getResVersion, this, o, 'china_list');
		o.rawhtml = true;

		o = s.option(form.DummyValue, '_gfw_list_version', _('GFW list version'));
		o.cfgvalue = L.bind(getResVersion, this, o, 'gfw_list');
		o.rawhtml = true;

		o = s.option(form.Value, 'github_token', _('GitHub token'));
		o.password = true;
		o.renderWidget = function() {
			let node = form.Value.prototype.renderWidget.apply(this, arguments);

			(node.querySelector('.control-group') || node).appendChild(E('button', {
				'class': 'cbi-button cbi-button-apply',
				'title': _('Save'),
				'click': ui.createHandlerFn(this, () => {
					return this.map.save(null, true).then(() => {
						ui.changes.apply(true);
					});
				}, this.option)
			}, [ _('Save') ]));

			return node;
		}

		s = m.section(form.NamedSection, 'config', 'homeproxy');
		s.anonymous = true;

		o = s.option(form.DummyValue, '_homeproxy_logview');
		o.render = L.bind(getRuntimeLog, this, o, _('HomeProxy'));


		return m.render();
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
