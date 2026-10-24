import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeViewSource } from './support/node-view.mjs';
import { parseValue, loadHomeproxy } from './support/luci-form.mjs';

function fieldBlock(start, end, dependencies = {}) {
	const begin = nodeViewSource.indexOf(start);
	const finish = nodeViewSource.indexOf(end, begin);
	assert.ok(begin >= 0 && finish > begin, 'node field block exists');
	const option = { option: '', deps: [], depends(...args) { this.deps.push(args); } };
	new Function('s', 'form', 'uci', 'data', '_', 'hp', 'let o; ' + nodeViewSource.slice(begin, finish))(
		{ option(type, name) { option.kind = type; option.option = name; return option; } },
		{ DynamicList: 'list', Flag: 'flag' }, dependencies.uci, ['homeproxy'], value => value, loadHomeproxy().hp);
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

test('HTTP Host validation accepts authorities and rejects malformed input', () => {
	const { hp } = loadHomeproxy();
	for (const value of ['', 'example.test', 'example.test:8443', '192.0.2.1:80', '[2001:db8::1]', '[2001:db8::1]:8443'])
		assert.equal(hp.validateHTTPHost('node', value), true, value);
	for (const value of ['bad host', 'example.test:65536', 'example.test:abc', 'user@example.test', 'example.test/path', 'example.test?x=1', 'example.test\\path', '2001:db8::1', '[not-ipv6]', 'example.test\n'])
		assert.notEqual(hp.validateHTTPHost('node', value), true, value);
	for (const field of ['http_host', 'httpupgrade_host', 'ws_host']) {
		const begin = nodeViewSource.indexOf(`'${field}', _('`);
		assert.ok(nodeViewSource.slice(begin, begin + 160).includes('o.validate = hp.validateHTTPHost;'), field);
	}
});

test('manual share link imports use the backend parser and reject malformed replies', async () => {
	let response = { nodes: [{ type: 'hysteria2', tls_insecure: '0' }], total: 1 };
	let request;
	const { hp } = loadHomeproxy({ rpc: { declare(options) {
		assert.equal(options.method, 'share_links_parse');
		return async content => { request = content; return response; };
	} } });
	const content = 'hy2://fixture@192.0.2.1:443/?insecure=0';
	assert.deepEqual(await hp.parseShareLinks(content), response);
	assert.equal(request, content);
	for (response of [{}, { nodes: [], total: '1' }, { error: 'too large' }])
		await assert.rejects(hp.parseShareLinks(content));
	assert.ok(!nodeViewSource.includes('function parseShareLink('));
	assert.ok(nodeViewSource.includes('await hp.parseShareLinks(input)'));
});
