import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

class Element {
	constructor(tag, attrs = {}, children = []) {
		this.tag = tag; this.attrs = attrs; this.children = []; this.dataset = {};
		this.value = attrs.value || ''; this.isConnected = true;
		this.append(...(Array.isArray(children) ? children : [children]));
		if (tag === 'select') this.value = (this.children.find(c => c.attrs?.selected != null) || this.children[0])?.value || '';
	}
	append(...children) { this.children.push(...children.filter(c => c != null)); }
	replaceChildren(...children) { this.children = []; this.append(...children); }
	addEventListener(key, callback) { this.attrs[key] = callback; }
	setAttribute(key, value) { this.attrs[key] = value; }
	get textContent() { return this.children.map(c => c instanceof Element ? c.textContent : String(c)).join(''); }
	set textContent(value) { this.children = [value]; }
	get firstChild() { return this.children[0]; }
	click() { return this.attrs.click?.(); }
}

const E = (tag, attrs, children) => new Element(tag, attrs, children);
const walk = node => node instanceof Element ? [node, ...node.children.flatMap(walk)] : [];
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
	const runtime = { version: '1.14.0', expected: '1.14.0', compatible: true, running: true, api: { enabled: true }, names: {}, ...overrides };
	let snapshot = overrides.snapshot ?? {
		connections: { memory: 1048576, uploadTotal: 1000, downloadTotal: 2000, connections: [] },
		proxies: { proxies: {} }
	};
	let logText = overrides.logText ?? 'first line';
	const controls = [], cleanedLogs = [], listeners = {}, polls = [], timers = [];
	const rpc = {
		declare: ({ method }) => async (...args) => {
			if (method === 'runtime') return overrides.runtimeResult ? overrides.runtimeResult(...args) : runtime;
			if (method === 'api_read') return typeof snapshot === 'function' ? snapshot(...args) : snapshot;
			if (method === 'api_control') {
				controls.push(args);
				return overrides.controlResult ?? { result: true };
			}
			if (method === 'log_read') return { text: typeof logText === 'function' ? logText(`/var/run/homeproxy/${args[0]}.log`) : logText };
			if (method === 'log_clean') { cleanedLogs.push(args); logText = ''; return { result: true }; }
			return {};
		}
	};
	const poll = {
		add: fn => polls.push(fn),
		remove: fn => { const i = polls.indexOf(fn); if (i >= 0) polls.splice(i, 1); }
	};
	const document = { hidden: false, body: E('body'), addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: () => {} };
	const ui = { createHandlerFn: (scope, fn) => fn.bind(scope), addNotification: () => {}, showModal: () => {}, hideModal: () => {} };
	const source = fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/observability.js', 'utf8');
	const view = new Function('view', 'rpc', 'ui', 'poll', 'L', 'E', 'window', 'document', 'MutationObserver', 'requestAnimationFrame', '_', 'performance', 'setTimeout', 'clearTimeout', source)(
		{ extend: v => v }, rpc, ui, poll, { url: p => '/' + p }, E, { addEventListener: () => {}, removeEventListener: () => {} }, document,
		class { observe() {} disconnect() {} }, fn => queueMicrotask(fn), s => s, { now: () => Date.now() },
		(fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, t => { if (t) t.cancelled = true; }
	);
	const root = view.render(runtime);
	const button = label => { const b = walk(root).find(n => n.tag === 'button' && n.textContent === label); assert.ok(b, label); return b; };
	return {
		root, button, controls, cleanedLogs, listeners, polls, timers, document,
		setSnapshot: next => { snapshot = next; },
		setLogText: next => { logText = next; }
	};
}

test('always-visible metrics bar updates from Clash API and unavailable cores block groups/connections', async () => {
	const f = fixture(); await settle();
	assert.match(f.root.textContent, /1\.0 MiB/);
	assert.equal(f.polls.length, 1);
	const unavailable = fixture({ compatible: false }); await settle();
	assert.equal(unavailable.polls.length, 0);
	assert.match(unavailable.root.textContent, /paired core must be running with Clash API enabled/);
});

test('groups tab maps friendly names, tests latency, switches selection and preserves expansion', async () => {
	const f = fixture({
		names: { a: 'Proxy', b: 'Node B', c: 'Node C' },
		controlResult: { result: true, data: { 'cfg-b-out': 42, 'cfg-c-out': 88 } },
		snapshot: {
			connections: { memory: 1024, uploadTotal: 0, downloadTotal: 0, connections: [] },
			proxies: {
				proxies: {
					'cfg-a-out': { name: 'cfg-a-out', type: 'Selector', all: ['cfg-b-out', 'cfg-c-out'], now: 'cfg-b-out' },
					'cfg-b-out': { name: 'cfg-b-out', type: 'Shadowsocks', history: [{ delay: 42 }] },
					'cfg-c-out': { name: 'cfg-c-out', type: 'Shadowsocks', history: [] }
				}
			}
		}
	});
	await settle();
	assert.match(f.root.textContent, /Proxy/);
	assert.match(f.root.textContent, /Node B/);
	assert.match(f.root.textContent, /42 ms/);
	let details = walk(f.root).find(n => n.tag === 'details');
	assert.equal(details.attrs.open, true);
	details.open = false; details.attrs.toggle();
	await f.polls[0]();
	assert.equal(walk(f.root).find(n => n.tag === 'details'), details);
	assert.equal(details.open, false);
	assert.equal(walk(details).filter(n => n.attrs.role === 'row').length, 0);
	details.open = true; details.attrs.toggle();
	await f.button('Test latency').click();
	assert.deepEqual(f.controls[0], ['client', 'delay', 'cfg-a-out', 'group']);
	assert.equal(walk(f.root).find(n => n.tag === 'details').attrs.open, true);
	assert.match(f.root.textContent, /88 ms/);
	await f.button('Select').click();
	assert.deepEqual(f.controls[1], ['client', 'select', 'cfg-a-out', 'cfg-c-out']);
});

test('collapsed groups render summaries without creating their member rows', async () => {
	const members = Array.from({ length: 100 }, (_, i) => `member-${i}`);
	const proxies = Object.fromEntries(Array.from({ length: 40 }, (_, i) => {
		const name = `group-${i}`;
		return [name, { name, type: 'Selector', all: members, now: members[0] }];
	}));
	const f = fixture({ snapshot: { connections: { connections: [] }, proxies: { proxies } } });
	await settle();
	const groups = walk(f.root).filter(n => n.tag === 'details');
	const rows = () => walk(f.root).filter(n => n.attrs.role === 'row').length;
	assert.equal(groups.length, 40);
	assert.equal(rows(), 101);
	groups[1].open = true; groups[1].attrs.toggle();
	assert.equal(rows(), 202);
	groups[1].open = false; groups[1].attrs.toggle();
	assert.equal(rows(), 101);
	f.button('Collapse all').click();
	assert.equal(rows(), 0);
});

test('slow Clash snapshots do not start overlapping background requests', async () => {
	let finish, calls = 0;
	const f = fixture({ snapshot: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
	await settle();
	await f.polls[0]();
	await f.polls[0]();
	assert.equal(calls, 1);
	finish({ connections: { connections: [] } });
	await settle();
	const next = f.polls[0]();
	assert.equal(calls, 2);
	finish({ connections: { connections: [] } });
	await next;
});

test('switching away and back ignores a late runtime response for the same instance', async () => {
	const pending = [];
	const f = fixture({ runtimeResult: instance => new Promise(resolve => pending.push({ instance, resolve })) });
	const select = walk(f.root).find(n => n.attrs['aria-label'] === 'Instance');
	const selectInstance = instance => { select.value = instance; return select.attrs.change(); };
	const tasks = [selectInstance('client'), selectInstance('server'), selectInstance('client')];
	assert.deepEqual(pending.map(x => x.instance), ['client', 'server', 'client']);
	pending[2].resolve({ version: '1.14.3', compatible: true, running: false });
	pending[1].resolve({ version: '1.14.2' });
	pending[0].resolve({ version: '1.14.1' });
	await Promise.all(tasks);
	assert.match(f.root.textContent, /1\.14\.3 · client/);
	assert.doesNotMatch(f.root.textContent, /1\.14\.[12] ·/);
});

test('connections tab tracks active and closed connections and disables pagination when empty', async () => {
	const f = fixture({
		names: { rules: 'Streaming rules' },
		snapshot: {
			connections: {
				memory: 1024, uploadTotal: 10, downloadTotal: 20,
				connections: [{ id: 'c1', metadata: { host: 'example.test', network: 'tcp', sourceIP: '2001:db8::2', destinationPort: '443', sourcePort: '1234' }, rule: 'rule_set=cfg-rules-rule', upload: 10, download: 20, start: '2026-01-01T00:00:00Z', chains: ['direct'] }]
			},
			proxies: { proxies: {} }
		}
	});
	await settle();
	await f.button('Connections').click();
	await settle();
	assert.match(f.root.textContent, /example\.test/);
	assert.match(f.root.textContent, /Streaming rules/);
	assert.match(f.root.textContent, /\[2001:db8::2\]:1234/);
	assert.match(f.root.textContent, /Direct/);
	f.setSnapshot({ connections: { memory: 1024, uploadTotal: 10, downloadTotal: 20, connections: [] }, proxies: { proxies: {} } });
	await f.polls[0]();
	assert.doesNotMatch(f.root.textContent, /example\.test/);
	const stateSelect = walk(f.root).find(n => n.attrs['aria-label'] === 'Connection state');
	stateSelect.value = 'closed'; stateSelect.attrs.change();
	assert.match(f.root.textContent, /example\.test/);
	stateSelect.value = 'active'; stateSelect.attrs.change();
	assert.equal(f.button('Previous').disabled, true);
	assert.equal(f.button('Next').disabled, true);
	assert.match(f.root.textContent, /No active connections/);
});

test('large connection lists render one page and filtering resets pagination', async () => {
	const connections = Array.from({ length: 250 }, (_, i) => ({
		id: `connection-${i}`, metadata: { host: `host-${i}.test` }, upload: i, start: new Date(1700000000000 + i * 1000).toISOString()
	}));
	const f = fixture({ snapshot: { connections: { connections } } });
	await f.button('Connections').click();
	await settle();
	const table = () => walk(f.root).find(n => n.tag === 'table');
	assert.equal(table().children.length, 101);
	assert.match(f.root.textContent, /250 connections · Page 1/);
	f.button('Next').click();
	f.button('Next').click();
	assert.equal(table().children.length, 51);
	assert.match(f.root.textContent, /250 connections · Page 3/);
	assert.equal(f.button('Next').disabled, true);
	const filter = walk(f.root).find(n => n.attrs['aria-label'] === 'Filter connections');
	filter.value = 'host-199.test';
	filter.attrs.input();
	assert.equal(table().children.length, 2);
	assert.match(f.root.textContent, /1 connection · Page 1/);
	assert.match(f.root.textContent, /host-199\.test/);
});

test('logs tab works when core is stopped, strips ANSI, pauses, cleans and stops when hidden', async () => {
	const f = fixture({ running: false, logText: 'boot failed' });
	await settle();
	await f.button('Logs').click();
	await settle();
	assert.match(f.root.textContent, /boot failed/);
	f.button('Pause display').click();
	f.setLogText('\x1b[32msecond line\x1b[0m');
	await f.polls[0]();
	assert.doesNotMatch(f.root.textContent, /second line/);
	f.button('Resume display').click();
	await settle();
	assert.match(f.root.textContent, /second line/);
	assert.doesNotMatch(f.root.textContent, /\x1b\[/);
	await f.button('Clean log').click();
	assert.deepEqual(f.cleanedLogs, [['sing-box-c']]);
	f.document.hidden = true; f.listeners.visibilitychange();
	assert.equal(f.polls.length, 0);
});

test('a quiet core opens the maintenance log, and the core source still shows its configured level', async () => {
	const f = fixture({ log_level: 'warn', logText: path => path.endsWith('homeproxy.log') ? 'service started' : '' });
	await settle();
	await f.button('Logs').click();
	await settle();
	assert.match(f.root.textContent, /service started/);
	const source = walk(f.root).find(n => n.attrs['aria-label'] === 'Log source');
	assert.equal(source.value, 'homeproxy');
	source.value = 'sing-box-c';
	await source.attrs.change();
	assert.match(f.root.textContent, /Core log level warn/);
	assert.match(f.root.textContent, /Log is empty/);
});

test('connection RPC failure is visible and disables controls until the next snapshot', async () => {
	const f = fixture({ snapshot: { error: 'unavailable' } });
	await settle();
	await f.button('Connections').click();
	await settle();
	assert.match(f.root.textContent, /Unable to read the current connections/);
	assert.equal(f.button('Close all connections').disabled, true);
	f.setSnapshot({ connections: { connections: [] } });
	await f.polls[0]();
	assert.match(f.root.textContent, /No active connections/);
});

test('tabs expose active state and only the selected tab is in the tab order', async () => {
	const f = fixture(); await settle();
	const tabs = () => walk(f.root).filter(n => n.attrs.role === 'tab');
	assert.equal(tabs().filter(t => t.attrs['aria-selected'] === 'true').length, 1);
	assert.equal(f.button('Groups').attrs.tabindex, '0');
	await f.button('Logs').click();
	assert.equal(f.button('Logs').attrs['aria-selected'], 'true');
	assert.equal(f.button('Groups').attrs['aria-selected'], 'false');
	assert.equal(f.button('Groups').attrs.tabindex, '-1');
	assert.equal(walk(f.root).find(n => n.attrs.role === 'tabpanel').attrs['aria-labelledby'], 'hp-tab-logs');
	const active = walk(f.root).find(n => n.attrs.class === 'cbi-tab');
	assert.equal(active.firstChild, f.button('Logs'));
});
