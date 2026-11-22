import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { nodeViewSource } from './support/node-view.mjs';
import { loadHomeproxy } from './support/luci-form.mjs';

function editor(nodes, source = nodeViewSource) {
	let reads = 0, lookups = 0, size = Infinity;
	const values = {};
	const uci = { get(_config, id, key) {
		if (++reads > 8 * size)
			throw new Error('Node validation exceeded its configuration read budget');
		return key === undefined ? nodes[id] : nodes[id]?.[key];
	}, sections(_config, type, callback) {
		const records = Object.entries(nodes).map(([id, node]) => ({ '.name': id, '.type': 'node', ...node }))
			.filter(node => !type || node['.type'] === type);
		if (callback) records.forEach(callback);
		return records;
	} };
	const { hp, form, L, E } = loadHomeproxy({ uci });
	for (const type of ['Value', 'Flag', 'DummyValue', 'Button'])
		form[type] = {};
	const section = { children: [], option(_kind, name) {
		const field = { option: name, section: this, deps: [],
			value() {},
			depends(key, value) { this.deps.push(typeof key === 'object' ? { ...key } : { [key]: value }); },
			formvalue: () => Object.hasOwn(values, name) ? values[name] : undefined
		};
		this.children.push(field);
		return field;
	} };
	const context = vm.createContext({ form, uci, hp, L, E, fs: {}, ui: {}, widgets: { DeviceSelect: {} },
		countLookup() {
			if (++lookups > 16 * size)
				throw new Error('Node validation exceeded its collection lookup budget');
		}
	});
	vm.runInContext(`String.prototype.format = function(...args) {
		let i = 0; return this.replace(/%s/g, () => String(args[i++]));
	}; const _ = value => value;
	for (const [kind, names] of [[Map, ['has', 'get']], [Set, ['has']]])
		for (const name of names) {
			const original = kind.prototype[name];
			kind.prototype[name] = function(...args) { countLookup(); return original.apply(this, args); };
		}`, context);
	const end = source.indexOf('return view.extend');
	assert.ok(end > 0);
	const render = vm.runInContext(source.slice(0, end) + '\nrenderNodeSettings;', context);
	render(section, ['homeproxy'], {}, null, 'custom', {});
	return {
		section, values,
		validate(id, field = 'group_nodes') {
			reads = lookups = 0;
			size = Object.keys(nodes).length;
			const option = section.children.find(option => option.option === field);
			assert.equal(typeof option.validate, 'function', `${field} uses a validator`);
			return { result: option.validate(id), reads, lookups };
		}
	};
}

function sharedGroups(size) {
	const nodes = { n0: { type: 'socks' }, n1: { type: 'socks' } };
	for (let i = 2; i < size; i++)
		nodes['n' + i] = { type: 'selector', group_nodes: ['n' + (i - 1), 'n' + (i - 2)] };
	return nodes;
}

test('the rendered group and upstream fields use the same graph validator', () => {
	const { section } = editor({ node: { type: 'socks' } });
	const validators = ['group_nodes', 'node_detour']
		.map(name => section.children.find(option => option.option === name).validate);
	assert.equal(typeof validators[0], 'function');
	assert.ok(validators.every(validate => validate === validators[0]));
});

test('shared group dependencies stay within a linear configuration read budget', () => {
	for (const size of [13, 29, 100]) {
		const { result, reads } = editor(sharedGroups(size)).validate('n' + (size - 1));
		assert.equal(result, true, `${size} nodes: ${result}`);
		assert.ok(reads <= 8 * size, `${size} nodes caused ${reads} reads`);
	}
});

test('the work budget detects loss of completed traversal caching', () => {
	const guard = 'if(validated.has(id))return;';
	assert.equal(nodeViewSource.split(guard).length, 2, 'mutation has one exact anchor');
	const source = nodeViewSource.replace(guard, '');
	const nodes = sharedGroups(100);
	assert.match(editor(nodes, source).validate('n99').result, /exceeded its .* budget/);
});

test('group, detour and mixed cycles still fail after shared nodes have been visited', () => {
	const cases = [
		{ root: { type: 'selector', group_nodes: ['root'] } },
		{ root: { type: 'selector', group_nodes: ['safe', 'other'] },
		  safe: { type: 'socks' }, other: { type: 'selector', group_nodes: ['safe', 'root'] } },
		{ root: { type: 'socks', node_detour: 'other' }, other: { type: 'socks', node_detour: 'root' } },
		{ root: { type: 'selector', group_nodes: ['other'] }, other: { type: 'socks', node_detour: 'root' } }
	];
	for (const nodes of cases)
		assert.match(editor(nodes).validate('root').result, /Circular node dependency/);
});

test('missing group members and detours, empty groups and invalid defaults are rejected', () => {
	const cases = [
		[{ type: 'selector', group_nodes: ['gone'] }, /Missing node \(gone\)/],
		[{ type: 'socks', node_detour: 'gone' }, /Missing node \(gone\)/],
		[{ type: 'selector', group_nodes: [] }, /Group must contain at least one member/],
		[{ type: 'urltest', group_nodes: [] }, /Group must contain at least one member/],
		[{ type: 'selector', group_nodes: ['safe'], group_default: 'other' }, /Default must be a group member/]
	];
	for (const [root, error] of cases)
		assert.match(editor({ root, safe: { type: 'socks' } }).validate('root').result, error);
});

test('each validation reads current unsaved members, defaults and detours, including empty values', () => {
	const fixture = editor({ root: { type: 'selector', group_nodes: ['safe'], group_default: 'safe' },
		safe: { type: 'socks' } });
	assert.equal(fixture.validate('root').result, true);
	fixture.values.group_nodes = [];
	assert.match(fixture.validate('root').result, /Group must contain/);
	fixture.values.group_nodes = ['safe'];
	fixture.values.group_default = 'other';
	assert.match(fixture.validate('root').result, /Default must be a group member/);
	fixture.values.group_default = '';
	assert.equal(fixture.validate('root').result, true);
	fixture.values.group_nodes = ['root'];
	assert.match(fixture.validate('root').result, /Circular node dependency/);
	fixture.values.group_nodes = ['safe'];
	assert.equal(fixture.validate('root').result, true);
});

test('subsequent validations observe changed or deleted dependencies', () => {
	const nodes = sharedGroups(13);
	const fixture = editor(nodes);
	assert.equal(fixture.validate('n12').result, true);
	delete nodes.n0;
	assert.match(fixture.validate('n12').result, /Missing node \(n0\)/);
	nodes.n0 = { type: 'socks', node_detour: 'n12' };
	assert.match(fixture.validate('n12').result, /Circular node dependency/);
	nodes.n0 = { type: 'socks' };
	assert.equal(fixture.validate('n12').result, true);
});
