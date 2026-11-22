import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadNodeHelpers, nodeViewSource } from './support/node-view.mjs';
import { parseValue } from './support/luci-form.mjs';

test('empty subscription filter keywords are removed by normal form parsing', () => {
	const start = nodeViewSource.indexOf("o = s.taboption('subscription', form.DynamicList, 'filter_keywords'");
	const end = nodeViewSource.indexOf("o = s.taboption('subscription', form.Value, 'user_agent'", start);
	const field = { option: 'filter_keywords', rmempty: true, default: null, depends() {},
		cfgvalue: () => ['old pattern'], formvalue: () => [] };
	new Function('s', 'form', '_', 'let o; ' + nodeViewSource.slice(start, end))(
		{ taboption: () => field }, { DynamicList: {} }, value => value);
	assert.deepEqual(parseValue(field, 'subscription'), { writes: [], removed: ['filter_keywords'] });
});

test('remove subscriptions detects defaults, policies, DNS, groups and dial dependencies', () => {
	const { nodeReferences } = loadNodeHelpers();
	const records = [
		{ '.name': 'routing', '.type': 'homeproxy', default_outbound: 'sub' },
		{ '.name': 'config', '.type': 'homeproxy', main_node: 'sub', main_udp_urltest_nodes: ['sub'] },
		...['routing_rule', 'dns_server', 'dns_rule', 'ruleset'].map(type => ({ '.name': type, '.type': type, outbound: 'sub' })),
		{ '.name': 'manual', '.type': 'node', group_nodes: ['sub'], group_default: 'sub', node_detour: 'sub' },
		{ '.name': 'legacy', '.type': 'routing_node', node: 'sub', outbound: 'sub', urltest_nodes: ['sub'] }
	];

	assert.equal(nodeReferences(records, ['sub']).length, 13);
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
		orphan: { grouphash: 'old_hash' },
		manual: { grouphash: null }
	};
	const { isSubscriptionNode } = loadNodeHelpers({
		uci: { get: (_config, section_id, option) => values[section_id]?.[option] }
	});
	const subscriptions = [{ hash: 'old_hash', configured: false }];

	assert.equal(isSubscriptionNode('homeproxy', 'orphan', subscriptions), true);
	assert.equal(isSubscriptionNode('homeproxy', 'manual', subscriptions), false);
});

test('subscriptionMatchesNode matches nodes by grouphash', () => {
	const nodes = {
		owned_by_b: { grouphash: 'hash_b' },
		owned_by_a: { grouphash: 'hash_a' }
	};
	const { subscriptionMatchesNode } = loadNodeHelpers({
		uci: { get: (_config, section, field) => nodes[section]?.[field] }
	});
	const a = { hash: 'hash_a' };
	const b = { hash: 'hash_b' };

	assert.equal(subscriptionMatchesNode('homeproxy', 'owned_by_b', a), false);
	assert.equal(subscriptionMatchesNode('homeproxy', 'owned_by_b', b), true);
	assert.equal(subscriptionMatchesNode('homeproxy', 'owned_by_a', a), true);
});

test('bulk cleanup recognizes grouphash-owned nodes only', () => {
	const { subscriptionNodeIDs } = loadNodeHelpers();
	assert.deepEqual(subscriptionNodeIDs([
		{ '.name': 'sub1', '.type': 'node', grouphash: 'hash_one' },
		{ '.name': 'manual', '.type': 'node' },
		{ '.name': 'other', '.type': 'homeproxy', grouphash: 'not-a-node' }
	]), ['sub1']);
});

test('bulk cleanup waits for other fields to validate before removing nodes', async () => {
	const anchor = nodeViewSource.indexOf("'_remove_subscriptions'");
	const start = nodeViewSource.indexOf('o.onclick = function() {', anchor);
	const end = nodeViewSource.indexOf('\n\t\t}', start);
	assert.ok(anchor >= 0 && start >= 0 && end > start);
	const sections = [
		{ '.name': 'sub_node', '.type': 'node', grouphash: 'hash_one' },
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
		invalid: true,
		save(cb) { return this.invalid ? Promise.reject(new Error('other field invalid')) : Promise.resolve().then(cb); }
	};

	await assert.rejects(click.call({ map }), /other field invalid/);
	assert.deepEqual(removed, []);
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
