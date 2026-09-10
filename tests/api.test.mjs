import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const bundle = fs.readFileSync(new URL('../htdocs/luci-static/resources/homeproxy-api.js', import.meta.url), 'utf8');
function library(fetch, session) {
 const context = { Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, fetch, Response, ReadableStream, DOMException };
 if (session) context.L = { env: { sessionid: session } };
 vm.runInNewContext(bundle, context);
 return context.HomeProxyAPI;
}
const API = library();
test('gRPC frames decode across every boundary, including empty messages', () => {
 const frames = [API.frame(new Uint8Array([10, 2, 79, 75])), API.frame(new Uint8Array())];
 const input = Uint8Array.from(frames.flatMap(x => [...x]));
 for (let split = 0; split <= input.length; split++) {
  const decoder = new API.FrameDecoder();
  const result = [...decoder.push(input.slice(0, split)), ...decoder.push(input.slice(split))];
  assert.equal(result.length, 2); assert.deepEqual([...result[0].data], [10, 2, 79, 75]);
  assert.equal(result[1].data.length, 0); assert.equal(decoder.pending.length, 0);
 }
});
test('oversized or compressed frames are rejected', () => {
 const d = new API.FrameDecoder();
 assert.throws(() => d.push(new Uint8Array([0, 1, 0, 0, 0])), /size limit/);
 assert.throws(() => new API.FrameDecoder().push(new Uint8Array([1, 0, 0, 0, 0])), /encoding/);
});
function response(chunks) {
 return new Response(new ReadableStream({ start(controller) { chunks.forEach(c => controller.enqueue(c)); controller.close(); } }));
}
function trailer(text) { const f = API.frame(new TextEncoder().encode(text)); f[0] = 128; return f; }
test('version uses native protobuf, and checks the grpc-status trailer', async () => {
 const A = library(async () => response([API.frame(Uint8Array.from([10, 6, ...new TextEncoder().encode('1.14.0'), 16, 4])), trailer('grpc-status: 0\r\n')]));
 const value = await new A.Client('client', '/test-api').call('GetVersion');
 assert.equal(value.version, '1.14.0'); assert.equal(value.apiVersion, 4);
});
test('HTTP 200 with an RPC error is not accepted', async () => {
 const A = library(async () => response([trailer('grpc-status: 16\r\ngrpc-message: unauthorized\r\n')]));
 await assert.rejects(new A.Client('client', '/test-api').call('GetVersion'), /unauthorized/);
});
test('missing trailers are a failure, even after a valid message', async () => {
 const A = library(async () => response([API.frame(new Uint8Array())]));
 await assert.rejects(new A.Client('client', '/test-api').call('GetVersion'), /ended/);
});
test('cancelling the last subscriber aborts the request', async () => {
 let signal;
 const A = library(async (url, options) => {
  signal = options.signal;
  return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
 });
 const stop = new A.Client('client', '/test-api').subscribe('SubscribeLog', {}, () => {});
 await new Promise(resolve => setTimeout(resolve, 10)); stop();
 assert.equal(signal.aborted, true);
});

test('LuCI session is sent explicitly when browser cookies do not cover the CGI path', async () => {
 const sid = 'a'.repeat(32);
 const api = library(async (url, options) => {
  assert.equal(options.headers.Authorization, 'LuCI ' + sid);
  return new Response('', { status: 401 });
 }, sid);
 await assert.rejects(new api.Client('client', '/test-api').call('GetVersion'), /HTTP 401/);
});

test('tool methods decode core progress and Tailscale status without a rebuild', async () => {
 const cases = [
  ['StartSTUNTest', { server: 'example.test:3478' }, [18, 3, 49, 58, 50, 24, 12, 48, 1], value => { assert.equal(value.externalAddr, '1:2'); assert.equal(value.latencyMs, 12); assert.equal(value.isFinal, true); }],
  ['StartNetworkQualityTest', { maxRuntimeSeconds: 20 }, [48, 25, 64, 1], value => { assert.equal(value.idleLatencyMs, 25); assert.equal(value.isFinal, true); }],
  ['SubscribeTailscaleStatus', {}, [], value => assert.equal(value.endpoints.length, 0)],
  ['StartTailscalePing', { endpointTag: 'ts', peerIP: '100.64.0.1' }, [16, 1], value => assert.equal(value.isDirect, true)]
 ];
 for (const [method, request, payload, check] of cases) {
  const A = library(async (url) => { assert.ok(url.endsWith('/' + method)); return response([API.frame(Uint8Array.from(payload)), trailer('grpc-status: 0\r\n')]); });
  check(await new A.Client('client', '/test-api').call(method, request));
 }
});


test('native transport opens one HTTP stream without job polling', async () => {
 const calls=[];
 const A=library(async url=>{calls.push(url);return new Response('body');});
 const r=await A.nativeFetch('/api',{method:'POST'});
 assert.equal(await r.text(),'body');assert.deepEqual(calls,['/api']);
});

test('authorization failure stops subscriptions instead of repeatedly retrying', async () => {
 for (const status of [401,403]) {
  let calls=0;
  const A=library(async()=>{calls++;return new Response('denied',{status});});
  const stop=new A.Client('client','/test-api').subscribe('SubscribeLog',{},()=>{});
  await new Promise(r=>setTimeout(r,1200));stop();
  assert.equal(calls,1);
 }
});
