import test from 'node:test';
import assert from 'node:assert/strict';

import { loadHomeproxy, createDocument, parseValue } from './support/luci-form.mjs';
import { loadClientView, renderClientForm, uciFixture } from './support/client-view.mjs';

const document = createDocument();
const FEATURES = { version: '1.14.0', with_quic: true, with_tls: true, with_grpc: true, with_ech: true, with_vifas: true, hp_has_tproxy: true, hp_has_ip_full: true, hp_has_tun: true };

function configSections(routing_mode, node_count) {
	const sections = [
		{ '.name': 'config', '.type': 'homeproxy', routing_mode },
		{ '.name': 'subscription', '.type': 'subscription', subscription_url: ['https://same.test/feed#Alpha'] },
		{ '.name': 'src_a', '.type': 'subscription_source', url: 'https://same.test/feed' }
	];

	for (let i = 0; i < node_count; i++) {
		sections.push({
			'.name': `node${i}`, '.type': 'node', label: `Node ${i}`,
			address: '1.2.3.4', port: '443', type: 'vmess', source_id: 'src_a'
		});
	}

	return sections;
}

/* Build the real client form for one page load, then render and wire the
 * default_outbound selector exactly like the routing tab does. */
async function outboundSelector(routing_mode, cfgvalue, node_count = 3) {
	const uci = uciFixture(configSections(routing_mode, node_count));
	const { hp } = loadHomeproxy({ uci, document });
	const map = await renderClientForm(loadClientView({ hp, uci, features: FEATURES }), 'homeproxy');
	const recorded = map.find('default_outbound');

	assert.ok(recorded, 'the routing tab must keep a default outbound selector');

	recorded.loaded_value = cfgvalue;
	recorded.load('config');

	const option = Object.assign(new hp.CBILazyListValue(), {
		option: 'default_outbound',
		keylist: recorded.keylist,
		vallist: recorded.vallist,
		lazyChoices: recorded.lazyChoices,
		default: recorded.default,
		rmempty: recorded.rmempty,
		retain: true,
		cfgvalue: () => cfgvalue
	});
	const frame = option.renderWidget('config', 0, cfgvalue);
	const select = frame.querySelector('select');

	option.formvalue = () => select.value;
	return { option, select, recorded };
}

test('a retained default outbound survives the routing mode round trip', async () => {
	/* custom(node2) -> non-custom retains it -> back to custom must not
	 * rewrite it, because the routing tab may save before the next reload. */
	for (const mode of ['custom', 'bypass_mainland_china', 'proxy_mainland_china', 'custom']) {
		const { option, select } = await outboundSelector(mode, 'node2');

		assert.ok(select.options.some(option_node => option_node.attributes.value === 'node2'),
			`${mode}: the retained node must be offered by the selector`);
		assert.equal(select.value, 'node2', `${mode}: the select must show the retained node`);
		assert.deepEqual(parseValue(option, 'config'), { writes: [], removed: [] },
			`${mode}: saving must not rewrite the retained outbound`);
	}
});

test('a selector exposes a wrapper select like ui.Select does', async () => {
	const { select, recorded } = await outboundSelector('custom', 'node1');

	assert.ok(select, 'the rendered widget must nest a select');
	assert.deepEqual(Object.keys(recorded.lazyChoices), ['node0', 'node1', 'node2']);
	assert.match(recorded.vallist[recorded.keylist.indexOf('node1')], /^\[vmess\] Node 1 \(1\.2\.3\.4:443\) — Alpha$/);
});

test('a thousand node choices stay out of the DOM until the select is used', async () => {
	const { option, select } = await outboundSelector('custom', 'node999', 1000);

	assert.equal(select.options.length, 4, 'three fixed choices plus the selected node');
	assert.equal(select.value, 'node999');

	select.listeners.pointerdown[0]();

	assert.equal(select.options.length, 1003);
	assert.equal(select.value, 'node999');
	assert.deepEqual(select.options.map(item => item.value),
		['nil', 'direct-out', 'block-out', ...Array.from({ length: 1000 }, (_, i) => `node${i}`)],
		'opening the select must preserve the configured choice order');
	assert.deepEqual(parseValue(option, 'config'), { writes: [], removed: [] });
});

test('the deferred choices are restored only once per rendered select', async () => {
	const { select } = await outboundSelector('custom', 'node1', 50);

	select.listeners.focus[0]();
	const afterFirst = select.options.length;

	select.listeners.focus[0]();
	select.listeners.pointerdown[0]();

	assert.equal(afterFirst, 53);
	assert.equal(select.options.length, afterFirst);
});

test('lazy expansion keeps selected and non-deferred choices in their original positions', () => {
	const { hp } = loadHomeproxy({ document: createDocument() });
	const option = Object.assign(new hp.CBILazyListValue(), {
		keylist: ['nil', 'node0', 'node1', 'node2', 'route'],
		vallist: ['Disable', 'A', 'B', 'C', 'Route'],
		lazyChoices: { node0: true, node1: true, node2: true }
	});
	const select = option.renderWidget('config', 0, 'node2').querySelector('select');
	assert.deepEqual(select.options.map(item => item.value), ['nil', 'node2', 'route']);
	select.listeners.focus[0]();
	assert.deepEqual(select.options.map(item => item.value), option.keylist);
	assert.equal(select.value, 'node2');
});
