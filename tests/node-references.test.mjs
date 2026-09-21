import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadNodeHelpers, nodeViewSource } from './support/node-view.mjs';

test('remove subscriptions detects defaults, policies, DNS, groups and dial dependencies', () => {
	const { nodeReferences } = loadNodeHelpers();
	const records = [
		{ '.name': 'routing', '.type': 'homeproxy', default_outbound: 'sub' },
		{ '.name': 'config', '.type': 'homeproxy', main_node: 'sub', main_udp_urltest_nodes: ['sub'] },
		...['routing_rule', 'dns_server', 'dns_rule', 'ruleset'].map(type => ({ '.name': type, '.type': type, outbound: 'sub' })),
		{ '.name': 'manual', '.type': 'node', group_nodes: ['sub'], group_default: 'sub', local_detour: 'sub', node_base: 'sub', node_detour: 'sub' },
		{ '.name': 'legacy', '.type': 'routing_node', node: 'sub', outbound: 'sub', urltest_nodes: ['sub'] }
	];

	assert.equal(nodeReferences(records, ['sub']).length, 15);
	assert.deepEqual(nodeReferences(records, ['unreferenced']), []);
	assert.deepEqual(nodeReferences([{ '.name': 'sub', '.type': 'node', group_nodes: ['sub2'] }], ['sub', 'sub2']), []);
});

test('the UI and subscription updater protect the same reference fields', () => {
	const updater = fs.readFileSync('root/etc/homeproxy/scripts/update_subscriptions.uc', 'utf8');
	const readFields = source => {
		const match = source.match(/const fields = (\{[\s\S]*?\n\s*\});/);
		assert.ok(match, 'reference field table must remain discoverable');
		return new Function(`return (${match[1]});`)();
	};

	assert.deepEqual(readFields(nodeViewSource), readFields(updater));
});

test('a node from a removed subscription is not reclassified as manual', () => {
	const values = {
		orphan: { source_id: 'src_removed', grouphash: 'old_hash' },
		manual: { source_id: null, grouphash: null }
	};
	const { isSubscriptionNode } = loadNodeHelpers({
		uci: { get: (_config, section_id, option) => values[section_id]?.[option] }
	});
	const subscriptions = [{ id: 'src_removed', hash: 'old_hash', configured: false }];

	assert.equal(isSubscriptionNode('homeproxy', 'orphan', subscriptions), true);
	assert.equal(isSubscriptionNode('homeproxy', 'manual', subscriptions), false);
});

test('a source ID takes precedence over a stale hash when classifying nodes', () => {
	const nodes = {
		owned_by_b: { source_id: 'src_b', grouphash: 'hash_a' },
		legacy_a: { grouphash: 'hash_a' }
	};
	const { subscriptionMatchesNode } = loadNodeHelpers({
		uci: { get: (_config, section, field) => nodes[section]?.[field] }
	});
	const a = { id: 'src_a', hash: 'hash_a' };
	const b = { id: 'src_b', hash: 'hash_b' };

	assert.equal(subscriptionMatchesNode('homeproxy', 'owned_by_b', a), false);
	assert.equal(subscriptionMatchesNode('homeproxy', 'owned_by_b', b), true);
	assert.equal(subscriptionMatchesNode('homeproxy', 'legacy_a', a), true);
});

test('bulk cleanup recognizes both current source IDs and legacy hashes', () => {
	const { subscriptionNodeIDs } = loadNodeHelpers();
	assert.deepEqual(subscriptionNodeIDs([
		{ '.name': 'current', '.type': 'node', source_id: 'src_current' },
		{ '.name': 'legacy', '.type': 'node', grouphash: 'legacy_hash' },
		{ '.name': 'manual', '.type': 'node' },
		{ '.name': 'source', '.type': 'subscription_source', source_id: 'not-a-node' }
	]), ['current', 'legacy']);
});

test('bulk cleanup waits for other fields to validate before removing nodes', async () => {
	const anchor = nodeViewSource.indexOf("'_remove_subscriptions'");
	const start = nodeViewSource.indexOf('o.onclick = function() {', anchor);
	const end = nodeViewSource.indexOf('\n\t\t}', start);
	assert.ok(anchor >= 0 && start >= 0 && end > start);
	const sections = [
		{ '.name': 'sub_node', '.type': 'node', source_id: 'src_one' },
		{ '.name': 'manual', '.type': 'node' }
	];
	const removed = [];
	const uci = {
		sections: () => sections,
		remove: (_config, id) => removed.push(id)
	};
	const { subscriptionNodeIDs, nodeReferences } = loadNodeHelpers();
	const click = new Function('uci', 'subscriptionNodeIDs', 'nodeReferences', 'ui', 'E', '_', 'data',
		`const o = {}; ${nodeViewSource.slice(start, end + 4)}; return o.onclick;`)(
		uci, subscriptionNodeIDs, nodeReferences, { addNotification: () => {} }, () => {}, value => value, ['homeproxy']);
	const map = {
		readonly: false,
		subscriptionWritePending: false,
		invalid: true,
		save(cb) { return this.invalid ? Promise.reject(new Error('other field invalid')) : Promise.resolve().then(cb); }
	};

	await assert.rejects(click.call({ map }), /other field invalid/);
	assert.deepEqual(removed, []);
	assert.equal(map.subscriptionWritePending, false);
	map.invalid = false;
	await click.call({ map });
	assert.deepEqual(removed, ['sub_node']);
});

test('the subscription save button leaves a displayed save failure handled', async () => {
	const anchor = nodeViewSource.indexOf("'_save_subscriptions'");
	const start = nodeViewSource.indexOf('o.onclick = function() {', anchor);
	const end = nodeViewSource.indexOf('\n\t\t}', start);
	assert.ok(anchor >= 0 && start >= 0 && end > start);
	let applied = 0;
	const click = new Function('ui', `const o = {}; ${nodeViewSource.slice(start, end + 4)}; return o.onclick;`)({
		changes: { apply: () => { applied++; } }
	});

	await click.call({ map: { save: () => Promise.reject(new Error('shown by Map.save')) } });
	assert.equal(applied, 0);
	await click.call({ map: { save: () => Promise.resolve() } });
	assert.equal(applied, 1);
});

test('subscription URLs accept only unique HTTP and HTTPS sources', () => {
	const { validateSubscriptionURLs } = loadNodeHelpers();

	assert.equal(validateSubscriptionURLs([
		'http://one.test/feed',
		'https://two.test/feed#Provider'
	]), null);
	for (const value of ['ftp://one.test/feed', 'file:///tmp/feed', 'not-a-url', 'https://'])
		assert.equal(validateSubscriptionURLs([value])?.code, 'invalid', value);
	assert.deepEqual(validateSubscriptionURLs([
		'https://one.test/feed#Primary',
		'https://one.test/feed#Backup name'
	]), {
		code: 'duplicate',
		value: 'https://one.test/feed#Backup name',
		clean: 'https://one.test/feed'
	});
});

function subscriptionChangeFixture(records) {
	const sections = structuredClone(records);
	const calls = [];
	const uci = {
		get: (_config, section_id, option) => sections.find(item => item['.name'] === section_id)?.[option],
		sections: (_config, type, callback) => {
			const result = sections.filter(item => !type || item['.type'] === type);
			if (callback)
				result.forEach(callback);
			return result;
		},
		set: (_config, section_id, option, value) => {
			calls.push(['set', section_id, option, value]);
			sections.find(item => item['.name'] === section_id)[option] = value;
		},
		remove: (_config, section_id) => {
			calls.push(['remove', section_id]);
			sections.splice(sections.findIndex(item => item['.name'] === section_id), 1);
		}
	};
	const { applySubscriptionURLChange } = loadNodeHelpers({ uci });
	const apply = values => applySubscriptionURLChange('homeproxy', 'subscription', values, url => `hash:${url}`);
	return { apply, calls, sections, uci };
}

test('removing a subscription URL atomically removes its source and nodes', () => {
	const { apply, calls, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://one.test/feed#One'] },
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/feed' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one', grouphash: 'hash:https://one.test/feed' },
		{ '.name': 'manual', '.type': 'node' }
	]);

	const result = apply([]);

	assert.equal(result.changed, true);
	assert.deepEqual(result.removedNodes, ['node_one']);
	assert.deepEqual(result.removedSources, ['src_one']);
	assert.deepEqual(sections.map(item => item['.name']), ['subscription', 'manual']);
	assert.deepEqual(calls, [
		['remove', 'node_one'],
		['remove', 'src_one'],
		['set', 'subscription', 'subscription_url', []]
	]);
});

test('adding and reordering sources never mutates node ownership', () => {
	const { apply, calls, sections } = subscriptionChangeFixture([
		{
			'.name': 'subscription', '.type': 'homeproxy',
			subscription_url: ['https://one.test/feed', 'https://two.test/feed']
		},
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/feed' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one' }
	]);

	let result = apply(['https://two.test/feed', 'https://one.test/feed']);
	assert.deepEqual(result.removedNodes, []);
	assert.deepEqual(result.removedSources, []);
	assert.ok(sections.some(item => item['.name'] === 'node_one'));

	result = apply(['https://two.test/feed', 'https://one.test/feed', 'https://three.test/feed']);
	assert.deepEqual(result.removedNodes, []);
	assert.deepEqual(result.removedSources, []);
	assert.equal(sections.some(item => item['.name'] === 'src_three'), false,
		'a new source is created only after a successful update');
	assert.ok(calls.every(call => call[0] === 'set'));
});

test('a referenced subscription node blocks URL removal without partial changes', () => {
	const { apply, calls, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://one.test/feed'] },
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/feed' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one', grouphash: 'hash:https://one.test/feed' },
		{ '.name': 'policy', '.type': 'routing_rule', label: 'Streaming', outbound: 'node_one' }
	]);

	const result = apply([]);

	assert.equal(result.changed, false);
	assert.deepEqual(result.references, ['Streaming · outbound']);
	assert.deepEqual(calls, []);
	assert.deepEqual(sections.find(item => item['.name'] === 'subscription').subscription_url, ['https://one.test/feed']);
	assert.ok(sections.some(item => item['.name'] === 'node_one'));
	assert.ok(sections.some(item => item['.name'] === 'src_one'));
});

test('one reference blocks an entire multi-source removal and a retry then succeeds', () => {
	const fixture = subscriptionChangeFixture([
		{
			'.name': 'subscription', '.type': 'homeproxy',
			subscription_url: ['https://one.test/feed', 'https://two.test/feed']
		},
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/feed' },
		{ '.name': 'src_two', '.type': 'subscription_source', url: 'https://two.test/feed' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one' },
		{ '.name': 'node_two', '.type': 'node', source_id: 'src_two' },
		{ '.name': 'policy', '.type': 'routing_rule', outbound: 'node_two' }
	]);

	const blocked = fixture.apply([]);
	assert.equal(blocked.changed, false);
	assert.deepEqual(blocked.removedNodes, ['node_one', 'node_two']);
	assert.deepEqual(fixture.calls, []);
	assert.ok(fixture.sections.some(item => item['.name'] === 'node_one'));

	fixture.sections.splice(fixture.sections.findIndex(item => item['.name'] === 'policy'), 1);
	const retried = fixture.apply([]);
	assert.equal(retried.changed, true);
	assert.deepEqual(fixture.sections.map(item => item['.name']), ['subscription']);
});

test('removing a source with no nodes still cleans its metadata', () => {
	const { apply, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://empty.test/feed'] },
		{ '.name': 'src_empty', '.type': 'subscription_source', url: 'https://empty.test/feed' }
	]);

	const result = apply([]);
	assert.deepEqual(result.removedNodes, []);
	assert.deepEqual(result.removedSources, ['src_empty']);
	assert.deepEqual(sections.map(item => item['.name']), ['subscription']);
});

test('removing and later re-adding a URL starts with no stale source or nodes', () => {
	const { apply, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://one.test/feed'] },
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/feed' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one' }
	]);

	apply([]);
	const readded = apply(['https://one.test/feed#Re-added']);

	assert.equal(readded.changed, true);
	assert.deepEqual(sections.map(item => item['.name']), ['subscription']);
	assert.deepEqual(sections[0].subscription_url, ['https://one.test/feed#Re-added']);
});

test('legacy hash-only subscription nodes are removed with their URL', () => {
	const { apply, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://legacy.test/feed'] },
		{ '.name': 'legacy_node', '.type': 'node', grouphash: 'hash:https://legacy.test/feed' }
	]);

	const result = apply([]);

	assert.deepEqual(result.removedNodes, ['legacy_node']);
	assert.equal(sections.some(item => item['.name'] === 'legacy_node'), false);
});

test('a single URL replacement keeps source identity and nodes', () => {
	const { apply, calls, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://one.test/old#Provider'] },
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/old' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one', grouphash: 'hash:https://one.test/old' }
	]);

	const result = apply(['https://one.test/new#Provider']);

	assert.equal(result.replaced, true);
	assert.equal(sections.find(item => item['.name'] === 'src_one').url, 'https://one.test/new');
	assert.ok(sections.some(item => item['.name'] === 'node_one'));
	assert.deepEqual(calls, [
		['set', 'src_one', 'url', 'https://one.test/new'],
		['set', 'node_one', 'grouphash', 'hash:https://one.test/new'],
		['set', 'subscription', 'subscription_url', ['https://one.test/new#Provider']]
	]);
});

test('replace A with B, re-add A, then remove A keeps the B-owned node', () => {
	const { apply, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://one.test/a'] },
		{ '.name': 'src_b', '.type': 'subscription_source', url: 'https://one.test/a' },
		{ '.name': 'node_b', '.type': 'node', source_id: 'src_b', grouphash: 'hash:https://one.test/a' }
	]);

	assert.equal(apply(['https://one.test/b']).replaced, true);
	assert.equal(sections.find(item => item['.name'] === 'node_b').grouphash, 'hash:https://one.test/b');
	apply(['https://one.test/b', 'https://one.test/a']);
	/* Simulate a pre-migration cache: source_id must still win over an old hash. */
	sections.find(item => item['.name'] === 'node_b').grouphash = 'hash:https://one.test/a';
	const removal = apply(['https://one.test/b']);

	assert.deepEqual(removal.removedNodes, []);
	assert.deepEqual(removal.removedSources, []);
	assert.equal(sections.find(item => item['.name'] === 'node_b').source_id, 'src_b');
});

test('a URL replacement keeps legacy hash-only nodes attached through later deletion', () => {
	const { apply, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://one.test/old'] },
		{ '.name': 'legacy_node', '.type': 'node', grouphash: 'hash:https://one.test/old' }
	]);

	const replacement = apply(['https://one.test/new']);
	assert.equal(replacement.replaced, true);
	assert.equal(sections.find(item => item['.name'] === 'legacy_node').grouphash,
		'hash:https://one.test/new');

	const removal = apply([]);
	assert.deepEqual(removal.removedNodes, ['legacy_node']);
	assert.equal(sections.some(item => item['.name'] === 'legacy_node'), false);
});

test('changing only a subscription title never deletes its nodes', () => {
	const { apply, sections } = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://one.test/feed#Old'] },
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/feed' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one', grouphash: 'hash:https://one.test/feed' }
	]);

	const result = apply(['https://one.test/feed#New']);

	assert.equal(result.replaced, false);
	assert.deepEqual(result.removedNodes, []);
	assert.ok(sections.some(item => item['.name'] === 'node_one'));
	assert.deepEqual(sections.find(item => item['.name'] === 'subscription').subscription_url,
		['https://one.test/feed#New']);
});

test('a multi-URL edit retires the old source instead of guessing a replacement', () => {
	const { apply, sections } = subscriptionChangeFixture([
		{
			'.name': 'subscription', '.type': 'homeproxy',
			subscription_url: ['https://one.test/feed', 'https://keep.test/feed']
		},
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/feed' },
		{ '.name': 'src_keep', '.type': 'subscription_source', url: 'https://keep.test/feed' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one' },
		{ '.name': 'node_keep', '.type': 'node', source_id: 'src_keep' }
	]);

	const result = apply(['https://keep.test/feed', 'https://new.test/feed']);

	assert.equal(result.replaced, false);
	assert.deepEqual(result.removedNodes, ['node_one']);
	assert.deepEqual(result.removedSources, ['src_one']);
	assert.deepEqual(sections.filter(item => item['.type'] === 'node').map(item => item['.name']), ['node_keep']);
	assert.deepEqual(sections.find(item => item['.name'] === 'subscription').subscription_url,
		['https://keep.test/feed', 'https://new.test/feed']);
});

function saveLifecycleFixture() {
	const fixture = subscriptionChangeFixture([
		{ '.name': 'subscription', '.type': 'homeproxy', subscription_url: ['https://one.test/feed'] },
		{ '.name': 'src_one', '.type': 'subscription_source', url: 'https://one.test/feed' },
		{ '.name': 'node_one', '.type': 'node', source_id: 'src_one' },
		{ '.name': 'route', '.type': 'routing_rule', label: 'Work', outbound: 'node_one' }
	]);
	const calls = [];
	const { configureSubscriptionURLWrites, saveNodeMap } = loadNodeHelpers({
		uci: fixture.uci,
		ui: { addNotification: () => calls.push('notification') }
	});
	const map = {
		config: 'homeproxy',
		subscriptionWritePending: false,
		data: {
			save: async () => calls.push('data-save'),
			unload: () => calls.push('unload'),
			load: async () => calls.push('data-load')
		},
		load: async () => calls.push('map-load'),
		reset: async () => calls.push('reset')
	};
	const option = { map, getUIElement: () => ({ setValue: value => calls.push(['restore', value]) }) };
	configureSubscriptionURLWrites(option);
	let values = [];
	let invalidOtherField = false;
	const mapSave = function(cb) {
		/* LuCI Map.save(): parse all fields, then run cb, data.save, load. */
		return Promise.all([
			Promise.resolve().then(() => values == ''
				? option.remove('subscription') : option.write('subscription', values)),
			Promise.resolve().then(() => {
				if (invalidOtherField)
					throw new Error('unrelated field invalid');
			})
		]).then(cb).then(this.data.save).then(this.load);
	};
	const save = () => saveNodeMap(map, mapSave, 'homeproxy', null, false, url => `hash:${url}`);
	return { ...fixture, calls, map, save, setValues: next => { values = next; },
		setInvalid: next => { invalidOtherField = next; } };
}

test('a referenced removal rejects through the save promise and releases the button', async () => {
	const { save, calls, sections } = saveLifecycleFixture();
	const button = { disabled: false, spinning: false };
	const click = () => {
		button.disabled = button.spinning = true;
		return Promise.resolve(save()).finally(() => {
			button.disabled = button.spinning = false;
		});
	};

	await assert.rejects(click(), error =>
		error.subscriptionURLRejected === true && /Work · outbound/.test(error.message));
	assert.equal(button.disabled, false);
	assert.equal(button.spinning, false);
	assert.deepEqual(calls, [['restore', ['https://one.test/feed']], 'notification']);
	assert.ok(sections.some(item => item['.name'] === 'node_one'));
});

test('unrelated validation failure preserves the unsaved URL edit and retry', async () => {
	const fixture = saveLifecycleFixture();
	fixture.sections.splice(fixture.sections.findIndex(item => item['.name'] === 'route'), 1);
	fixture.setInvalid(true);
	await assert.rejects(fixture.save(), /unrelated field invalid/);
	assert.deepEqual(fixture.calls, []);
	assert.equal(fixture.map.subscriptionWritePending, false);
	assert.deepEqual(fixture.sections.find(item => item['.name'] === 'subscription').subscription_url,
		['https://one.test/feed']);
	assert.ok(fixture.sections.some(item => item['.name'] === 'node_one'));

	fixture.setInvalid(false);
	await fixture.save();
	assert.ok(fixture.calls.includes('data-save'));
	assert.deepEqual(fixture.sections.map(item => item['.name']), ['subscription']);
});

test('a failed subscription save reloads UCI before rejecting', async () => {
	const calls = [];
	const { rollbackSubscriptionWrite } = loadNodeHelpers();
	const failure = new Error('uci save rejected');
	const map = {
		config: 'homeproxy',
		subscriptionWritePending: true,
		data: {
			unload: config => calls.push(['unload', config]),
			load: async config => calls.push(['load', config])
		},
		reset: async () => calls.push(['reset'])
	};

	await assert.rejects(() => rollbackSubscriptionWrite(map, failure), /uci save rejected/);

	assert.equal(map.subscriptionWritePending, false);
	assert.deepEqual(calls, [['unload', 'homeproxy'], ['load', 'homeproxy'], ['reset']]);
});

/** Everything one remove click touches: the row, its table, the buttons and UCI. */
function removalFixture({ fail, readonly } = {}) {
	const calls = [];
	const notices = [];
	const table = { name: 'table' };
	const row = {
		closest: selector => selector === '.tr' ? row : table,
		parentElement: { querySelectorAll: () => [button, next] },
		remove() { calls.push('row-remove'); }
	};
	const button = { name: 'button', closest: selector => selector === '.tr' ? row : table };
	const next = { name: 'next-button', focus() { calls.push('focus-next'); } };
	const data = {
		remove: (config, sid) => calls.push(`data-remove:${config}:${sid}`),
		save: async () => {
			calls.push('data-save');
			if (fail)
				throw new Error('uci save rejected');
		},
		unload: config => calls.push(`data-unload:${config}`),
		load: async config => { calls.push(`data-load:${config}`); }
	};
	const { removeNode } = loadNodeHelpers({
		uci: { sections: () => [{ '.name': 'group', '.type': 'node', group_nodes: ['used'] }] },
		ui: { addNotification: (...args) => notices.push(args) },
		requestAnimationFrame: callback => callback()
	});
	const section = {
		map: { config: 'homeproxy', readonly: !!readonly, data }
	};

	return {
		calls,
		notices,
		remove: sid => removeNode.call(section, sid, { currentTarget: button })
	};
}

test('individual removal blocks referenced nodes without touching the configuration', () => {
	const { calls, notices, remove } = removalFixture();

	remove('used');

	assert.equal(notices.length, 1);
	assert.equal(notices[0][2], 'error');
	assert.match(String(notices[0][1].children), /still referenced/);
	assert.deepEqual(calls, []);
});

test('removal drops the row only after the direct save succeeded', async () => {
	const { calls, remove } = removalFixture();

	await remove('unused');

	assert.deepEqual(calls, [
		'data-remove:homeproxy:unused',
		'data-save',
		'row-remove',
		'focus-next'
	]);
});

test('a failed removal reloads the package and keeps the row visible', async () => {
	const { calls, notices, remove } = removalFixture({ fail: true });

	await remove('unused');

	assert.deepEqual(calls, [
		'data-remove:homeproxy:unused',
		'data-save',
		'data-unload:homeproxy',
		'data-load:homeproxy'
	]);
	assert.ok(!calls.includes('row-remove'), 'the row must stay while the deletion never reached UCI');
	assert.equal(notices.length, 1);
	assert.equal(notices[0][2], 'error');
	assert.match(String(notices[0][1].children), /still present in the configuration/);
});

test('a readonly map ignores removal requests', () => {
	const { calls, remove } = removalFixture({ readonly: true });

	remove('unused');

	assert.deepEqual(calls, []);
});
