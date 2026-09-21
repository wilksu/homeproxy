import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/node.js', 'utf8');
const helperSource = fs.readFileSync('htdocs/luci-static/resources/homeproxy.js', 'utf8');
const start = source.indexOf('function buildNodeLabels');
const end = source.indexOf('\nfunction renderNodeSettings', start);
const body = source.slice(start, end) + '\nreturn buildNodeLabels;';
const helperStart = helperSource.indexOf('function getSubscriptionInfo');
const helperEnd = helperSource.indexOf('\nreturn baseclass.extend', helperStart);
const getSubscriptionInfo = new Function('uci', helperSource.slice(helperStart, helperEnd) + '\nreturn getSubscriptionInfo;');

function labels(sections) {
 const uci = {
  get: (_config, id, key) => sections.find(s => s['.name'] === id)?.[key],
  sections: (_config, type, callback) => sections.filter(s => s['.type'] === type).forEach(callback)
 };
	const hp = { calcStringMD5: value => 'hash:' + value };
	hp.getSubscriptionInfo = getSubscriptionInfo(uci).bind(hp);
	return new Function('uci', 'hp', '_', body)(uci, hp, value => value)('homeproxy');
}

test('subscription titles distinguish equal node labels', () => {
 const result = labels([
  { '.name': 'subscription', subscription_url: ['https://same.test/a#Provider A', 'https://same.test/b#Provider B'] },
  { '.name': 'src_a', '.type': 'subscription_source', url: 'https://same.test/a' },
  { '.name': 'src_b', '.type': 'subscription_source', url: 'https://same.test/b' },
  { '.name': 'node_aaaaaa', '.type': 'node', label: 'Hong Kong', source_id: 'src_a' },
  { '.name': 'node_bbbbbb', '.type': 'node', label: 'Hong Kong', source_id: 'src_b' }
 ]);
 assert.equal(result.node_aaaaaa, 'Hong Kong — Provider A');
 assert.equal(result.node_bbbbbb, 'Hong Kong — Provider B');
});

test('a short stable suffix resolves the remaining identical choices', () => {
 const result = labels([
  { '.name': 'subscription', subscription_url: ['https://same.test/feed?account=a', 'https://same.test/feed?account=b'] },
  { '.name': 'src_source_aaaaaa', '.type': 'subscription_source', url: 'https://same.test/feed?account=a' },
  { '.name': 'src_source_bbbbbb', '.type': 'subscription_source', url: 'https://same.test/feed?account=b' },
  { '.name': 'node_aaaaaa', '.type': 'node', label: 'Hong Kong', source_id: 'src_source_aaaaaa' },
  { '.name': 'node_bbbbbb', '.type': 'node', label: 'Hong Kong', source_id: 'src_source_bbbbbb' }
 ]);
 assert.equal(result.node_aaaaaa, 'Hong Kong — same.test · aaaaaa');
 assert.equal(result.node_bbbbbb, 'Hong Kong — same.test · bbbbbb');
});

/* Subscription titles and node labels are user supplied text and are used as
 * index keys, so a key that names an Object.prototype member must not break
 * grouping or leak into the prototype chain. */
test('titles colliding with prototype member names are grouped and disambiguated', () => {
	for (const title of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
		const result = labels([
			{ '.name': 'subscription', subscription_url: [
				`https://same.test/account-a#${title}`,
				`https://same.test/account-b#${title}`
			] },
			{ '.name': 'src_a', '.type': 'subscription_source', url: 'https://same.test/account-a' },
			{ '.name': 'src_b', '.type': 'subscription_source', url: 'https://same.test/account-b' },
			{ '.name': 'node_aaaaaa', '.type': 'node', label: 'Hong Kong', source_id: 'src_a' },
			{ '.name': 'node_bbbbbb', '.type': 'node', label: 'Hong Kong', source_id: 'src_b' }
		]);

		assert.equal(result.node_aaaaaa, `Hong Kong — ${title} · src_a`, title);
		assert.equal(result.node_bbbbbb, `Hong Kong — ${title} · src_b`, title);
	}

	assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'push'), false,
		'grouping must not write onto Object.prototype');
});

test('a node labelled like a prototype member is still disambiguated', () => {
	const result = labels([
		{ '.name': 'subscription', subscription_url: [] },
		{ '.name': 'node_aaaaaa', '.type': 'node', label: '__proto__' },
		{ '.name': 'node_bbbbbb', '.type': 'node', label: '__proto__' }
	]);

	assert.equal(result.node_aaaaaa, '__proto__ · aaaaaa');
	assert.equal(result.node_bbbbbb, '__proto__ · bbbbbb');
});

test('nodes keep their removed subscription ownership and label', () => {
	const result = labels([
		{ '.name': 'subscription', subscription_url: [] },
		{ '.name': 'src_retired', '.type': 'subscription_source', url: 'https://retired.test/feed' },
		{
			'.name': 'node_retired', '.type': 'node', label: 'Hong Kong',
			source_id: 'src_retired', grouphash: 'hash:https://retired.test/feed'
		}
	]);

	assert.equal(result.node_retired, 'Hong Kong — Removed · retired.test');
});

test('a stale hash never moves an identified node into a re-added source', () => {
	const sections = [
		{ '.name': 'subscription', subscription_url: ['https://same.test/b#B', 'https://same.test/a#A'] },
		{ '.name': 'src_b', '.type': 'subscription_source', url: 'https://same.test/b' },
		{ '.name': 'node_b', '.type': 'node', label: 'Hong Kong', source_id: 'src_b',
			grouphash: 'hash:https://same.test/a' }
	];
	const result = labels(sections);
	assert.equal(result.node_b, 'Hong Kong — B');

	sections[0].subscription_url = ['https://same.test/a#A'];
	assert.equal(labels(sections).node_b, 'Hong Kong — Removed · same.test');
});

test('a removed identified source cannot steal a current legacy source hash or tab', () => {
	const sections = [
		{ '.name': 'subscription', subscription_url: ['https://same.test/a#A'] },
		{ '.name': 'src_a', '.type': 'subscription_source', url: 'https://same.test/a' },
		{ '.name': 'src_b', '.type': 'subscription_source', url: 'https://same.test/b' },
		{ '.name': 'node_a', '.type': 'node', label: 'Hong Kong',
			grouphash: 'hash:https://same.test/a' },
		{ '.name': 'node_b', '.type': 'node', label: 'Hong Kong',
			source_id: 'src_b', grouphash: 'hash:https://same.test/a' }
	];
	const uci = {
		get: (_config, id, key) => sections.find(item => item['.name'] === id)?.[key],
		sections: (_config, type, callback) => sections.filter(item => item['.type'] === type).forEach(callback)
	};
	const hp = { calcStringMD5: value => 'hash:' + value };
	const info = getSubscriptionInfo(uci).call(hp, 'homeproxy');
	const result = labels(sections);

	assert.equal(info.length, 2);
	assert.notEqual(info[0].hash, info[1].hash);
	assert.equal(result.node_a, 'Hong Kong — A');
	assert.equal(result.node_b, 'Hong Kong — Removed · same.test');
});

test('an old duplicate URL renders only one stable subscription source', () => {
	const sections = [
		{
			'.name': 'subscription',
			subscription_url: ['https://same.test/feed#First', 'https://same.test/feed#Second']
		},
		{ '.name': 'src_same', '.type': 'subscription_source', url: 'https://same.test/feed' }
	];
	const uci = {
		get: (_config, id, key) => sections.find(section => section['.name'] === id)?.[key],
		sections: (_config, type, callback) => sections.filter(section => section['.type'] === type).forEach(callback)
	};
	const hp = { calcStringMD5: value => 'hash:' + value };
	const result = getSubscriptionInfo(uci).call(hp, 'homeproxy');

	assert.equal(result.length, 1);
	assert.equal(result[0].title, 'First');
});
