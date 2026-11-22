/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

const getRuntime = rpc.declare({ object: 'luci.homeproxy', method: 'runtime', params: ['instance'], expect: { '': {} } });
const apiRead = rpc.declare({ object: 'luci.homeproxy', method: 'api_read', params: ['instance', 'resource'], expect: { '': {} } });
const apiControl = rpc.declare({ object: 'luci.homeproxy', method: 'api_control', params: ['instance', 'action', 'target', 'value'], expect: { '': {} } });
const readLog = rpc.declare({ object: 'luci.homeproxy', method: 'log_read', params: ['type'], expect: { '': {} } });
const cleanLog = rpc.declare({ object: 'luci.homeproxy', method: 'log_clean', params: ['type'], expect: { '': {} } });

function bytes(value) {
	let n = Number(value || 0), unit = 0;
	while (n >= 1024 && unit < 3) { n /= 1024; unit++; }
	return n.toFixed(unit ? 1 : 0) + ' ' + ['B', 'KiB', 'MiB', 'GiB'][unit];
}

function duration(start, end) {
	if (!start) return '—';
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
		.map(n => String(n).padStart(2, '0')).join(':');
}

function address(host, port) {
	if (!host) return '—';
	if (!port) return host;
	return (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
}

function button(label, action, extra) {
	return E('button', { type: 'button', class: 'btn cbi-button ' + (extra || ''), click: ui.createHandlerFn(null, action) }, label);
}

function setContent(node, children) {
	node.replaceChildren(...(Array.isArray(children) ? children : [children]));
}

return view.extend({
	load() { return getRuntime('client'); },
	render(runtime) {
		let instance = 'client', active = 'groups', generation = 0, poller = null;
		let previous = null, latestProxies = {}, proxyRevision = '', latestDelays = new Map();
		let snapshotReceived = false, snapshotError = '', snapshotRequest = 0, snapshotGeneration = null, runtimeRequest = 0;
		const rows = new Map(), openGroups = new Map();

		const status = E('div', { class: 'hp-observe-status', role: 'status', 'aria-live': 'polite' });
		const metricValues = Array.from({ length: 4 }, () => E('strong', {}, '—'));
		const metricHints = [
			E('span', { class: 'hp-observe-muted' }, _('Core memory usage')),
			E('span', { class: 'hp-observe-muted' }, _('Current active connections')),
			E('span', { class: 'hp-observe-muted' }, _('Total: —')),
			E('span', { class: 'hp-observe-muted' }, _('Total: —'))
		];
		const metricsBar = E('div', { class: 'hp-observe-metrics' }, [
			_('Memory'), _('Connections'), _('Upload'), _('Download')
		].map((title, i) => E('div', { class: 'hp-observe-metric' }, [E('span', {}, title), metricValues[i], metricHints[i]])));

		const panel = E('div', { class: 'cbi-section hp-observe-panel', id: 'hp-observe-panel', role: 'tabpanel' });
		const nav = E('ul', { class: 'cbi-tabmenu hp-observe-tabs', role: 'tablist', 'aria-label': _('Observability pages') });
		const instances = E('select', {
			class: 'cbi-input-select', 'aria-label': _('Instance'),
			change: ui.createHandlerFn(this, async () => {
				instance = instances.value;
				rows.clear(); openGroups.clear(); latestDelays.clear();
				latestProxies = {}; proxyRevision = ''; previous = null;
				snapshotReceived = false; snapshotError = '';
				resetMetrics();
				await refreshRuntime();
			})
		}, [E('option', { value: 'client' }, _('Client')), E('option', { value: 'server' }, _('Server'))]);

		const root = E('div', { class: 'cbi-map hp-observe' }, [
			E('style', {}, `
.hp-observe{color:inherit;font-family:inherit}
.hp-observe .hp-observe-tabs,.hp-observe .hp-observe-tabs>li{color:inherit}
.hp-observe .hp-observe-tabs button{font:inherit;color:inherit!important}
.hp-observe .cbi-button:not(.cbi-button-negative){font-family:inherit;color:inherit!important;background:transparent!important;border:1px solid color-mix(in srgb,currentColor 35%,transparent)!important}
.hp-observe .cbi-button:not(.cbi-button-negative):hover:not(:disabled){background:color-mix(in srgb,currentColor 10%,transparent)!important}
.hp-observe .cbi-button:disabled{opacity:.5;cursor:default}
.hp-observe input,.hp-observe select{font-family:inherit;color:inherit}
.hp-observe input::placeholder{color:inherit;opacity:.75}
.hp-observe .hp-observe-panel pre{color:inherit}
.hp-observe .hp-group-error{font-weight:600;border-left:3px solid currentColor;padding-left:.5rem}
.hp-observe .hp-observe-tabs{display:flex;flex-wrap:wrap;gap:4px;background:none;margin:1rem 0 0;padding:0;border-bottom:1px solid color-mix(in srgb,currentColor 25%,transparent)}
.hp-observe .hp-observe-tabs>li{display:block;height:auto;max-width:none;margin:0;list-style:none;border-radius:4px 4px 0 0}
.hp-observe .hp-observe-tabs button.cbi-button{border:0!important;border-radius:4px 4px 0 0;background:transparent;color:inherit;box-shadow:none;padding:.5rem .85rem;min-height:34px;margin:0}
.hp-observe .hp-observe-tabs .cbi-tab{background:transparent;color:currentColor;border-bottom:3px solid currentColor;font-weight:600}
.hp-observe .hp-observe-tabs .cbi-tab-disabled{background:transparent;border-bottom:3px solid transparent}
.hp-observe button:focus-visible,.hp-observe input:focus-visible,.hp-observe select:focus-visible,.hp-observe summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.hp-observe-panel{padding:1.25rem!important;min-height:18rem;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-top:0}
.hp-observe-panel h3{margin-top:0}.hp-observe-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:32rem;overflow:auto;padding:1rem;background:color-mix(in srgb,currentColor 6%,transparent);border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:4px;line-height:1.6}
.hp-observe-toolbar{display:flex;gap:.75rem;align-items:flex-end;flex-wrap:wrap;margin:.75rem 0 1rem}
.hp-observe-field{display:flex;flex-direction:column;gap:.35rem;font-size:.9em;min-width:0}.hp-observe-field input{width:100%;min-width:0;box-sizing:border-box}.hp-observe-toolbar .hp-observe-field:has(input){flex:1 1 20rem;max-width:40rem}.hp-observe-field select{width:11rem}.hp-observe-toolbar>.cbi-button{margin:0;min-height:30px;box-sizing:border-box}
.hp-observe-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:1rem;align-items:end;margin:1rem 0}.hp-observe-filters .hp-observe-field select{width:100%;box-sizing:border-box}.hp-observe-actions{display:flex;justify-content:flex-end;gap:.75rem;flex-wrap:wrap;margin:1rem 0}.hp-observe-panel .hp-observe-scroll th{text-align:left}.hp-observe-panel .hp-observe-scroll td{text-align:left;overflow-wrap:anywhere}
.hp-observe-status{padding:.6rem .8rem;background:color-mix(in srgb,currentColor 6%,transparent);border-left:3px solid currentColor;margin:.75rem 0}
.hp-observe-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin:.75rem 0 1rem}
.hp-observe-metric{padding:.85rem 1rem;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:4px;background:transparent}
.hp-observe-metric strong{display:block;font-size:1.55rem;line-height:1.4;margin:.3rem 0;overflow-wrap:anywhere}.hp-observe-muted{color:inherit;font-size:.9em}
.hp-observe-scroll{overflow-x:auto}.hp-observe-panel table{width:100%;min-width:620px}.hp-observe-panel .td{overflow-wrap:anywhere;max-width:28rem;vertical-align:middle}
.hp-observe-empty{padding:2.5rem 1rem;text-align:center;color:inherit;background:color-mix(in srgb,currentColor 6%,transparent);border-radius:4px}
.hp-groups .hp-group{padding:0;margin:.75rem 0;overflow:hidden;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:4px}
.hp-group-summary{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;padding:.8rem 1rem;list-style:none;cursor:pointer;background:color-mix(in srgb,currentColor 6%,transparent)}
.hp-group-summary::-webkit-details-marker{display:none}.hp-group-summary::before{content:'▸';flex:none}.hp-group[open]>.hp-group-summary::before{content:'▾'}
.hp-group-title{font-weight:600;overflow-wrap:anywhere}.hp-group-kind{font-size:.85em;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:3px;padding:.1rem .4rem}
.hp-group-current{flex:1 1 14rem;min-width:0;overflow-wrap:anywhere;color:inherit}
.hp-group-content{padding:0 1rem 1rem}.hp-group-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;padding:.65rem 0;flex-wrap:wrap}.hp-group-feedback{flex:1 1 12rem;color:inherit;overflow-wrap:anywhere}.hp-group-toolbar button,.hp-group-action button{margin:0;min-height:30px}
.hp-group-member{display:grid;grid-template-columns:minmax(0,1fr) 7rem 6rem;gap:1rem;align-items:center;min-height:42px;padding:.4rem .6rem;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}
.hp-group-member-name{overflow-wrap:anywhere}.hp-group-head{font-weight:600;background:color-mix(in srgb,currentColor 6%,transparent)}.hp-group-latency{font-variant-numeric:tabular-nums;white-space:nowrap}.hp-group-action{display:flex;justify-content:flex-end}.hp-group-head>:last-child{text-align:right}
.hp-group-delay{display:inline-block;border-radius:3px;padding:.1rem .35rem;font-weight:600;color:#fff}
.hp-group-delay-fast{background:#146b3a}.hp-group-delay-medium{background:#775500}.hp-group-delay-slow{background:#a02728}
.hp-group-selected{background:color-mix(in srgb,currentColor 6%,transparent);box-shadow:inset 3px 0 currentColor}.hp-group-selected-label{color:currentColor;font-weight:600}
@media(max-width:600px){.hp-group-summary{padding:.7rem;gap:.5rem}.hp-group-current{flex-basis:100%;padding-left:1rem}.hp-group-content{padding:0 .5rem .5rem}.hp-group-member{grid-template-columns:minmax(0,1fr) 4.5rem 4.5rem;gap:.4rem;padding:.4rem}.hp-group-action button{padding:.3rem .5rem}}
@media(max-width:800px){.hp-observe-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.hp-observe-panel{padding:.8rem!important}.hp-observe .hp-observe-tabs button{padding:.6rem .7rem}}
@media(max-width:420px){.hp-observe-metric{padding:.7rem}.hp-observe-metric strong{font-size:1.3rem}.hp-observe .hp-observe-tabs{flex-wrap:nowrap;overflow-x:auto}.hp-observe .hp-observe-tabs>li{flex-shrink:0}.hp-observe-field,.hp-observe-field input{width:100%;min-width:0}.hp-observe-toolbar{align-items:stretch}}
`),
			E('h2', {}, _('HomeProxy observability')),
			E('div', { class: 'hp-observe-toolbar' }, [
				E('label', { class: 'hp-observe-field' }, [_('Instance'), instances]),
				button(_('Settings'), async () => { const settings = await L.require('view.homeproxy.observe-settings'); await settings.open(runtime, instance); }),
				button(_('Refresh'), refreshRuntime)
			]),
			status,
			metricsBar,
			nav,
			panel
		]);

		function resetMetrics() {
			metricValues.forEach(v => { v.textContent = '—'; });
			metricHints[2].textContent = _('Total: —');
			metricHints[3].textContent = _('Total: —');
		}

		function label(tag) {
			if (!tag) return '—';
			if (tag === 'main-out') return runtime.names?.[tag] || _('Main outbound');
			if (tag === 'main-udp-out') return runtime.names?.[tag] || _('Main UDP outbound');
			if (['direct-out', 'direct', 'DIRECT'].includes(tag)) return _('Direct');
			if (['block-out', 'block', 'REJECT'].includes(tag)) return _('Block');
			const section = String(tag).match(/^cfg-(.+)-(?:out|in|dns|rule)$/)?.[1];
			return section && runtime.names?.[section] ? runtime.names[section] : tag;
		}

		function stop() {
			generation++;
			if (poller) { poll.remove(poller); poller = null; }
		}

		async function refreshRuntime() {
			const request = ++runtimeRequest;
			stop();
			runtime = { version: _('Loading…') };
			status.textContent = runtime.version;
			setContent(panel, []);
			const next = await getRuntime(instance).catch(error => ({ error: error.message }));
			if (request !== runtimeRequest) return;
			runtime = next?.version ? next : { version: _('Unavailable'), error: next?.error };
			if (!document.hidden) show(active);
		}

		function updateMetrics(conns) {
			const now = performance.now();
			const up = Number(conns.uploadTotal || 0), down = Number(conns.downloadTotal || 0);
			const elapsed = previous ? (now - previous.time) / 1000 : 0;
			const valid = elapsed > 0 && up >= previous.up && down >= previous.down;
			metricValues[0].textContent = bytes(conns.memory);
			metricValues[1].textContent = String((conns.connections || []).length);
			metricValues[2].textContent = valid ? bytes((up - previous.up) / elapsed) + '/s' : '—';
			metricValues[3].textContent = valid ? bytes((down - previous.down) / elapsed) + '/s' : '—';
			metricHints[2].textContent = _('Total') + ': ' + bytes(up);
			metricHints[3].textContent = _('Total') + ': ' + bytes(down);
			previous = { time: now, up, down };
		}

		function syncConnections(conns) {
			const activeIDs = new Set();
			for (const c of conns.connections || []) {
				activeIDs.add(c.id);
				rows.set(c.id, { ...c, closed: false, startTime: Date.parse(c.start) || 0 });
			}
			for (const [id, item] of rows)
				if (!activeIDs.has(id) && !item.closed)
					item.closed = Date.now();
			let excess = rows.size - Math.max(activeIDs.size, 500);
			for (const [id, item] of rows) {
				if (excess <= 0) break;
				if (item.closed) { rows.delete(id); excess--; }
			}
		}

		let onSnapshot = null;

		async function fetchSnapshot(current, refresh = false) {
			if (current !== generation || !runtime.compatible || !runtime.api?.enabled || !runtime.running) return;
			if (!refresh && snapshotGeneration === current) return;
			const request = ++snapshotRequest;
			snapshotGeneration = current;
			const res = await apiRead(instance, active === 'groups' ? 'snapshot' : 'connections')
				.catch(error => ({ error: error.message }));
			if (request === snapshotRequest) snapshotGeneration = null;
			if (current !== generation || request !== snapshotRequest) return;
			if (res?.error || !res?.connections) {
				snapshotError = res?.error || _('Connection data unavailable');
				status.textContent = `${runtime.version} · ${instance} · ${snapshotError}`;
				previous = null;
				resetMetrics();
				if (active === 'connections') onSnapshot?.();
				return;
			}
			snapshotError = '';
			snapshotReceived = true;
			const connected = `${runtime.version} · ${instance} · ${_('Connected')}`;
			if (status.textContent !== connected) status.textContent = connected;
			updateMetrics(res.connections);
			syncConnections(res.connections);
			if (active === 'connections') onSnapshot?.();
			else if (res.proxies?.proxies) {
				const revision = JSON.stringify(res.proxies.proxies);
				latestProxies = res.proxies.proxies;
				if (revision !== proxyRevision) onSnapshot?.();
				proxyRevision = revision;
			}
		}

		function renderGroups() {
			const list = E('div', { class: 'hp-groups' });
			const pending = new Set(), feedback = new Map(), feedbackTimers = new Map();
			let initialized = false;
			const search = E('input', { class: 'cbi-input-text', placeholder: _('Search groups or members'), 'aria-label': _('Search groups or members'), input: () => draw() });
			const count = E('p', { class: 'hp-observe-muted', role: 'status' });
			const groupList = () => Object.values(latestProxies).filter(p => Array.isArray(p.all) && p.all.length > 0 && p.name !== 'GLOBAL');
			const expand = button(_('Expand all'), () => { groupList().forEach(g => openGroups.set(g.name, true)); draw(); });
			const collapse = button(_('Collapse all'), () => { groupList().forEach(g => openGroups.set(g.name, false)); draw(); });
			panel.append(E('h3', {}, _('Outbound groups')), E('div', { class: 'hp-observe-toolbar' }, [
				E('label', { class: 'hp-observe-field' }, [_('Search groups or members'), search]), expand, collapse
			]), count, list);

			async function act(key, action, groupName, value) {
				if (pending.has(key)) return;
				const current = generation;
				clearTimeout(feedbackTimers.get(groupName)); feedback.delete(groupName);
				pending.add(key); draw();
				try {
					const res = await apiControl(instance, action, groupName, value || '');
					if (current !== generation) return;
					if (res?.error) throw new Error(res.error);
					if (action === 'delay') {
						const group = latestProxies[groupName];
						for (const tag of group?.all || [])
							latestDelays.set(tag, Number(res.data?.[tag]) || 0);
					}
					await fetchSnapshot(current, true);
					if (current !== generation) return;
					const message = { text: action === 'delay' ? _('Latency test completed.') : _('Selection updated.'), error: false };
					feedback.set(groupName, message);
					feedbackTimers.set(groupName, setTimeout(() => {
						if (feedback.get(groupName) === message) feedback.delete(groupName);
						feedbackTimers.delete(groupName);
						if (current === generation && list.isConnected) draw();
					}, 4000));
				} catch (error) {
					if (current === generation) feedback.set(groupName, { text: error.message, error: true });
				} finally {
					pending.delete(key);
					if (current === generation && list.isConnected) draw();
				}
			}

			function delayOf(tag) {
				const history = latestProxies[tag]?.history;
				const last = Array.isArray(history) && history.length ? history[history.length - 1]?.delay : 0;
				return latestDelays.get(tag) ?? last ?? 0;
			}

			function draw() {
				const groups = groupList();
				if (!initialized && groups.length) {
					const preferred = groups.find(g => g.type === 'Selector') || groups[0];
					if (!openGroups.has(preferred.name)) openGroups.set(preferred.name, true);
					initialized = true;
				}
				const query = search.value.trim().toLowerCase();
				const matches = tag => [label(tag), tag].some(v => v.toLowerCase().includes(query));
				const visible = query ? groups.filter(g => matches(g.name) || g.all.some(matches)) : groups;
				count.textContent = _('Groups') + ': ' + visible.length + ' / ' + groups.length;
				expand.disabled = collapse.disabled = !groups.length;
				if (!visible.length) {
					setContent(list, E('p', { class: 'hp-observe-empty' }, query ? _('No matching groups or members.') : _('No outbound groups. A configuration using a single node may not create groups.')));
					return;
				}
				setContent(list, visible.map(group => {
					const items = group.all || [], isOpen = openGroups.get(group.name) || !!query;
					const selectable = group.type === 'Selector';
					const summary = E('summary', { class: 'hp-group-summary' }, [
						E('span', { class: 'hp-group-title', title: group.name }, label(group.name)),
						E('span', { class: 'hp-group-kind' }, selectable ? _('Manual selection') : _('Automatic selection')),
						E('span', { class: 'hp-group-current', title: group.now || '' }, _('Selected') + ': ' + label(group.now)),
						E('span', { class: 'hp-observe-muted' }, _('Members') + ': ' + items.length)
					]);
					const content = E('div', { class: 'hp-group-content' });
					function renderMembers() {
						const test = button(pending.has(group.name) ? _('Testing…') : _('Test latency'), () => act(group.name, 'delay', group.name, 'group'));
						test.disabled = pending.has(group.name);
						const groupMatches = !query || matches(group.name);
						const memberRows = (groupMatches ? items : items.filter(matches)).map(member => {
							const selected = group.now === member;
							const ms = delayOf(member);
							const choose = button(pending.has(group.name + ':select') ? _('Switching…') : _('Select'), () => act(group.name + ':select', 'select', group.name, member));
							choose.disabled = selected || pending.has(group.name + ':select');
							return E('div', { class: 'hp-group-member' + (selected ? ' hp-group-selected' : ''), role: 'row' }, [
								E('span', { class: 'hp-group-member-name', title: member, role: 'cell' }, label(member)),
								E('span', { class: 'hp-group-latency', role: 'cell' }, ms > 0 || latestDelays.has(member)
									? E('span', { class: 'hp-group-delay hp-group-delay-' + (ms === 0 || ms >= 500 ? 'slow' : ms >= 200 ? 'medium' : 'fast') }, ms > 0 ? ms + ' ms' : _('Failed'))
									: _('Untested')),
								E('span', { class: 'hp-group-action', role: 'cell' }, selected ? E('span', { class: 'hp-group-selected-label' }, _('Selected')) : selectable ? choose : '—')
							]);
						});
						content.append(
							E('div', { class: 'hp-group-toolbar' }, [
								E('span', { class: 'hp-group-feedback' + (feedback.get(group.name)?.error ? ' hp-group-error' : ''), role: 'status', 'aria-live': 'polite' }, feedback.get(group.name)?.text || ''),
								test
							]),
							E('div', { class: 'hp-group-members', role: 'table', 'aria-label': label(group.name) }, [
								E('div', { class: 'hp-group-member hp-group-head', role: 'row' }, [_('Node'), _('Latency'), _('Action')].map(t => E('span', { role: 'columnheader' }, t))), ...memberRows
							])
						);
					}
					if (isOpen) renderMembers();
					const details = E('details', { class: 'hp-group', open: isOpen || null }, [summary, content]);
					details.addEventListener('toggle', () => {
						if (!details.isConnected) return;
						if (!query) openGroups.set(group.name, details.open);
						if (!details.open) content.replaceChildren();
						else if (!content.firstChild) renderMembers();
					});
					return details;
				}));
			}

			onSnapshot = draw;
			if (proxyRevision) draw();
		}

		function renderConnections() {
			let page = 0;
			const filter = E('input', { class: 'cbi-input-text', placeholder: _('Filter domain, source, rule or outbound'), 'aria-label': _('Filter connections'), input: () => { page = 0; draw(); } });
			const stateFilter = E('select', { class: 'cbi-input-select', 'aria-label': _('Connection state'), change: () => { page = 0; draw(); } }, [['active', _('Active')], ['all', _('All')], ['closed', _('Closed')]].map(([value, text]) => E('option', { value }, text)));
			const sort = E('select', { class: 'cbi-input-select', 'aria-label': _('Connection sorting'), change: () => { page = 0; draw(); } }, [['startTime', _('Newest first')], ['upload', _('Uploaded bytes')], ['download', _('Downloaded bytes')]].map(([value, text]) => E('option', { value }, text)));
			async function close(action, target, selectedInstance) {
				const current = generation;
				const res = await apiControl(selectedInstance, action, target, '');
				if (res?.error) ui.addNotification(null, E('p', {}, res.error), 'error');
				else if (instance === selectedInstance) await fetchSnapshot(current, true);
			}
			const closeAll = button(_('Close all connections'), () => {
				const selectedInstance = instance;
				return ui.showModal(_('Close all connections'), [
					E('p', {}, _('This closes all active connections in the selected core instance.')),
					E('div', { class: 'right' }, [
						button(_('Cancel'), () => ui.hideModal()), ' ',
						button(_('Close all connections'), async () => {
							ui.hideModal();
							await close('close_all', '', selectedInstance);
						}, 'cbi-button-negative')
					])
				]);
			});
			const summary = E('p');
			const table = E('table', { class: 'table' });
			const previousBtn = button(_('Previous'), () => { page = Math.max(0, page - 1); draw(); });
			const nextBtn = button(_('Next'), () => { page++; draw(); });
			const empty = E('p', { class: 'hp-observe-empty' }, _('Waiting for connections…'));
			panel.append(
				E('h3', {}, _('Connections')),
				E('div', { class: 'hp-observe-filters' }, [
					E('label', { class: 'hp-observe-field' }, [_('Filter connections'), filter]),
					E('label', { class: 'hp-observe-field' }, [_('Connection state'), stateFilter]),
					E('label', { class: 'hp-observe-field' }, [_('Connection sorting'), sort])
				]),
				E('div', { class: 'hp-observe-actions' }, closeAll),
				summary,
				E('div', { class: 'hp-observe-scroll' }, table),
				empty,
				E('div', { class: 'hp-observe-toolbar' }, [previousBtn, nextBtn])
			);
			previousBtn.disabled = nextBtn.disabled = closeAll.disabled = true;

			function ruleLabel(c) {
				const rule = [c.rule, c.rulePayload].filter(Boolean).join(' · ');
				return rule === 'final' ? _('Default route') :
					rule.replace(/\bcfg-[a-zA-Z0-9_]+-(?:out|in|dns|rule)\b/g, label);
			}

			function draw() {
				const query = filter.value.trim().toLowerCase();
				const all = [...rows.values()].filter(c => {
					if (stateFilter.value === 'active' && c.closed) return false;
					if (stateFilter.value === 'closed' && !c.closed) return false;
					if (!query) return true;
					const m = c.metadata || {}, chain = (c.chains || []).map(label).join(' ');
					return [m.host, m.destinationIP, m.sourceIP, c.rule, c.rulePayload, ruleLabel(c), ...(c.chains || []), chain].join(' ').toLowerCase().includes(query);
				}).sort((a, b) => Number(b[sort.value] || 0) - Number(a[sort.value] || 0));
				page = Math.min(page, Math.max(0, Math.ceil(all.length / 100) - 1));
				summary.textContent = snapshotError || !snapshotReceived ? '' : `${all.length} ${_(all.length === 1 ? 'connection' : 'connections')} · ${_('Page')} ${page + 1}`;
				previousBtn.disabled = page === 0;
				nextBtn.disabled = (page + 1) * 100 >= all.length;
				closeAll.disabled = !!snapshotError || ![...rows.values()].some(c => !c.closed);
				empty.hidden = all.length > 0;
				empty.textContent = snapshotError ? _('Unable to read the current connections.') :
					!snapshotReceived ? _('Waiting for connections…') :
					query ? _('No connections match this filter.') :
					stateFilter.value === 'active' ? _('No active connections. Traffic through this instance appears here while the connection is open.') :
					stateFilter.value === 'closed' ? _('No closed connections recorded on this page yet.') :
					_('No connections have been reported by this core.');
				setContent(table, [
					E('tr', { class: 'tr' }, [_('Destination'), _('Source'), _('Rule'), _('Outbound'), _('Traffic'), _('Duration'), _('Action')].map(v => E('th', { class: 'th', scope: 'col' }, v))),
					...all.slice(page * 100, page * 100 + 100).map(c => {
						const m = c.metadata || {};
						const dest = address(m.host || m.destinationIP, m.destinationPort) + (m.network ? ' · ' + m.network : '');
						const outTag = c.chains?.[0] || '';
						return E('tr', { class: 'tr' }, [
							E('td', { class: 'td' }, dest),
							E('td', { class: 'td' }, address(m.sourceIP, m.sourcePort)),
							E('td', { class: 'td', title: [c.rule, c.rulePayload].filter(Boolean).join(' · ') }, ruleLabel(c) || '—'),
							E('td', { class: 'td', title: outTag }, label(outTag)),
							E('td', { class: 'td' }, `↑ ${bytes(c.upload)} / ↓ ${bytes(c.download)}`),
							E('td', { class: 'td' }, duration(c.startTime, c.closed || Date.now())),
							E('td', { class: 'td' }, c.closed ? _('Closed') : snapshotError ? '—' :
								button(_('Close connection'), () => close('close', c.id, instance)))
						]);
					})
				]);
			}

			onSnapshot = draw;
			draw();
		}

		function renderLogs() {
			let paused = false, rawText = '', logRequest = 0, chooseSource = true;
			const logKind = instance === 'client' ? 'sing-box-c' : 'sing-box-s';
			const sourceSelect = E('select', { class: 'cbi-input-select', 'aria-label': _('Log source'), change: () => {
				paused = false;
				chooseSource = false;
				rawText = '';
				pause.textContent = _('Pause display');
				output.textContent = _('Loading…');
				return readLogFile();
			} }, [
				E('option', { value: logKind }, _('Core log')),
				E('option', { value: 'homeproxy' }, _('HomeProxy log'))
			]);
			const search = E('input', { class: 'cbi-input-text', placeholder: _('Filter logs'), 'aria-label': _('Filter logs'), input: draw });
			const output = E('pre', { tabindex: '0', 'aria-label': _('Live logs') }, _('Loading…'));
			const logState = E('p', { class: 'hp-observe-muted', role: 'status' });
			const pause = button(_('Pause display'), () => {
				paused = !paused;
				pause.textContent = paused ? _('Resume display') : _('Pause display');
				draw();
				if (!paused) readLogFile();
			});
			const clearBtn = button(_('Clean log'), async () => {
				const source = sourceSelect.value;
				const result = await cleanLog(source);
				if (result?.error || result?.result === false || result?.status > 0)
					throw new Error(result.error || _('Unable to clean log.'));
				if (source === sourceSelect.value) {
					logRequest++;
					rawText = '';
					output.textContent = _('Log is empty.');
					draw();
				}
			});
			panel.append(
				E('h3', {}, _('Logs')),
				E('div', { class: 'hp-observe-filters' }, [
					E('label', { class: 'hp-observe-field' }, [_('Log source'), sourceSelect]),
					E('label', { class: 'hp-observe-field' }, [_('Filter logs'), search]),
					pause, clearBtn
				]),
				logState,
				output
			);

			function draw() {
				const lines = rawText ? rawText.split(/\r?\n/) : [];
				const query = search.value.toLowerCase();
				const filtered = query ? lines.filter(l => l.toLowerCase().includes(query)) : lines;
				const shown = filtered.slice(-1000).join('\n');
				const level = sourceSelect.value === logKind && runtime.log_level ? ' · ' + _('Core log level') + ' ' + runtime.log_level : '';
				const state = (paused ? _('Display paused.') : _('Live display')) + level + ' · ' + filtered.length + ' ' + _(filtered.length === 1 ? 'line' : 'lines');
				if (logState.textContent !== state) logState.textContent = state;
				const text = shown || (rawText ? _('No log messages match the current filters.') : _('Log is empty.'));
				if (!paused && output.textContent !== text) output.textContent = text;
			}

			async function readLogFile() {
				if (paused) return;
				const current = generation;
				const request = ++logRequest;
				const source = sourceSelect.value;
				let missing = false;
				try {
					const result = await readLog(source);
					if (current !== generation || request !== logRequest || paused) return;
					if (result?.error) throw new Error(result.error);
					missing = !!result?.missing;
					rawText = String(result?.text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
				} catch (err) {
					if (current !== generation || request !== logRequest || paused) return;
					rawText = '';
					logState.textContent = _('Unable to read the log.');
					output.textContent = String(err);
					return;
				}
				if (chooseSource && source === logKind && !rawText) {
					chooseSource = false;
					sourceSelect.value = 'homeproxy';
					return readLogFile();
				}
				chooseSource = false;
				draw();
				if (missing) output.textContent = _('Log file does not exist.');
			}

			onSnapshot = readLogFile;
			readLogFile();
		}

		function show(tab) {
			stop();
			active = tab;
			onSnapshot = null;
			setContent(panel, []);
			for (const item of nav.children) {
				const selected = item.firstChild.dataset.tab === tab;
				item.setAttribute('class', selected ? 'cbi-tab' : 'cbi-tab-disabled');
				item.firstChild.setAttribute('aria-selected', String(selected));
				item.firstChild.setAttribute('tabindex', selected ? '0' : '-1');
			}
			panel.setAttribute('aria-labelledby', 'hp-tab-' + tab);
			status.textContent = `${runtime.version} · ${instance} · ${runtime.error || (runtime.running ? _('Running') : _('Not running'))}`;
			const current = generation;
			if (tab !== 'logs' && (!runtime.compatible || !runtime.api?.enabled || !runtime.running)) {
				panel.append(E('p', { class: 'hp-observe-empty' }, _('The paired core must be running with Clash API enabled. Check API settings and the HomeProxy log.')));
				return;
			}
			({ groups: renderGroups, connections: renderConnections, logs: renderLogs })[tab]();
			if (runtime.compatible && runtime.api?.enabled && runtime.running) {
				poller = () => Promise.all([fetchSnapshot(current), tab === 'logs' && onSnapshot?.()]);
				fetchSnapshot(current);
				poll.add(poller, tab === 'connections' ? 1 : 2);
			} else if (tab === 'logs') {
				poller = () => onSnapshot?.();
				poll.add(poller, 2);
			}
		}

		for (const [tab, text] of [['groups', _('Groups')], ['connections', _('Connections')], ['logs', _('Logs')]]) {
			const b = button(text, () => show(tab));
			b.dataset.tab = tab;
			b.setAttribute('id', 'hp-tab-' + tab);
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-controls', 'hp-observe-panel');
			b.addEventListener?.('keydown', event => {
				const tabs = Array.from(nav.children).map(item => item.firstChild), index = tabs.indexOf(b);
				let next;
				if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
				else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
				else if (event.key === 'Home') next = 0;
				else if (event.key === 'End') next = tabs.length - 1;
				else return;
				event.preventDefault();
				tabs[next].focus();
				show(tabs[next].dataset.tab);
			});
			nav.append(E('li', { role: 'presentation' }, b));
		}

		const hidden = () => { if (document.hidden) stop(); else show(active); };
		document.addEventListener('visibilitychange', hidden);
		window.addEventListener('pagehide', stop);
		const observer = new MutationObserver(() => {
			if (!root.isConnected) {
				stop();
				observer.disconnect();
				document.removeEventListener('visibilitychange', hidden);
				window.removeEventListener('pagehide', stop);
			}
		});
		requestAnimationFrame(() => { observer.observe(document.body, { childList: true, subtree: true }); show(active); });
		return root;
	},
	handleSaveApply: null, handleSave: null, handleReset: null
});
