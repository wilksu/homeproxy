import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeViewSource } from './support/node-view.mjs';
import { parseValue } from './support/luci-form.mjs';

function fieldBlock(start, end, dependencies = {}) {
	const begin = nodeViewSource.indexOf(start);
	const finish = nodeViewSource.indexOf(end, begin);
	assert.ok(begin >= 0 && finish > begin, 'node field block exists');
	const option = { option: '', deps: [], depends(...args) { this.deps.push(args); } };
	new Function('s', 'form', 'uci', 'data', '_', 'let o; ' + nodeViewSource.slice(begin, finish))(
		{ option(type, name) { option.kind = type; option.option = name; return option; } },
		{ DynamicList: 'list', Flag: 'flag' }, dependencies.uci, ['homeproxy'], value => value);
	return option;
}

test('transport Host headers use a list editor for every supported HTTP transport', () => {
	const option = fieldBlock("o = s.option(form.DynamicList, 'ws_host'", "o = s.option(form.Value, 'ws_path'");
	assert.equal(option.kind, 'list');
	for (const transport of ['ws', 'http', 'httpupgrade'])
		assert.ok(option.deps.some(([field, value]) => field === 'transport' && value === transport));
});

test('UDP fragmentation editor distinguishes unset from explicit false', () => {
	for (const type of ['direct', 'hysteria', 'hysteria2', 'tuic', 'shadowsocks', 'vless']) {
		let stored;
		const option = fieldBlock("o = s.option(form.Flag, 'udp_fragment'", "o = s.option(form.Flag, 'udp_over_tcp'", {
			uci: { get: (_config, _id, field) => field === 'type' ? type : stored }
		});
		const expected = ['direct', 'hysteria', 'hysteria2', 'tuic'].includes(type) ? '1' : '0';
		assert.equal(option.cfgvalue('node'), expected);
		stored = '0';
		assert.equal(option.cfgvalue('node'), '0');
		stored = '1';
		option.formvalue = () => '0';
		assert.deepEqual(parseValue(option, 'node'), { writes: [['udp_fragment', '0']], removed: [] });
	}
});
