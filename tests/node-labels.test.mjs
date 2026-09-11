import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/node.js', 'utf8');
const start = source.indexOf('function buildNodeLabels');
const end = source.indexOf('\nfunction renderNodeSettings', start);
const body = source.slice(start, end) + '\nreturn buildNodeLabels;';

function labels(sections) {
 const uci = {
  get: (_config, id, key) => sections.find(s => s['.name'] === id)?.[key],
  sections: (_config, type, callback) => sections.filter(s => s['.type'] === type).forEach(callback)
 };
 const hp = { calcStringMD5: value => 'hash:' + value };
 return new Function('uci', 'hp', body)(uci, hp)('homeproxy');
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
  { '.name': 'subscription', subscription_url: ['https://same.test/a', 'https://same.test/b'] },
  { '.name': 'src_a', '.type': 'subscription_source', url: 'https://same.test/a' },
  { '.name': 'src_b', '.type': 'subscription_source', url: 'https://same.test/b' },
  { '.name': 'node_aaaaaa', '.type': 'node', label: 'Hong Kong', source_id: 'src_a' },
  { '.name': 'node_bbbbbb', '.type': 'node', label: 'Hong Kong', source_id: 'src_b' }
 ]);
 assert.equal(result.node_aaaaaa, 'Hong Kong — same.test · aaaaaa');
 assert.equal(result.node_bbbbbb, 'Hong Kong — same.test · bbbbbb');
});
