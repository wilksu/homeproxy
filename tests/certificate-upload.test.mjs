import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('certificate upload binds type and destination before LuCI section and event arguments', async () => {
 const source = fs.readFileSync('htdocs/luci-static/resources/homeproxy.js', 'utf8');
 const method = source.match(/uploadCertificate\([^]*?\n\t},/)[0];
 const calls = [], target = {};
 const rpc = { declare: () => async filename => { calls.push(['write', filename]); return { result: true }; } };
 const ui = { uploadFile: async (path, button) => { calls.push(['upload', path, button]); return { size: 123 }; }, addNotification: () => {} };
 const L = { bind: (fn, scope, ...bound) => fn.bind(scope, ...bound) };
 const translate = message => ({ format: (...values) => message.replace(/%s/g, () => values.shift()) });
 const upload = new Function('rpc', 'ui', 'L', 'E', '_', `return ({${method}}).uploadCertificate;`)(rpc, ui, L, () => {}, translate);
 await L.bind(upload, {}, 'certificate', 'server_publickey')('qa_server', { target });
 assert.deepEqual(calls, [['upload', '/tmp/homeproxy_certificate.tmp', target], ['write', 'server_publickey']]);
});
