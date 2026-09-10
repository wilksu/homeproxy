async function hpNativeFetch(url, options) {
 for (let attempt = 0; ; attempt++) {
  const response = await fetch(url, options);
  const busy = response.status === 429 || (response.status === 503 && (await response.clone().text()).includes('admission busy'));
  if (!busy || attempt >= 5) return response;
  await response.body?.cancel();
  await new Promise(resolve => setTimeout(resolve, 300));
  if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
 }
}

/* SPDX-License-Identifier: GPL-2.0-only */
import protobuf from 'protobufjs/light.js';
import schema from './schema.json';
const root = protobuf.Root.fromJSON(schema);
const service = root.lookupService('daemon.StartedService');
const MAX_FRAME = 4 * 1024 * 1024;

export function frame(payload) {
 const bytes = new Uint8Array(payload.length + 5);
 new DataView(bytes.buffer).setUint32(1, payload.length);
 bytes.set(payload, 5);
 return bytes;
}

export class FrameDecoder {
 constructor() { this.pending = new Uint8Array(); }
 push(chunk) {
  const merged = new Uint8Array(this.pending.length + chunk.length);
  merged.set(this.pending); merged.set(chunk, this.pending.length);
  this.pending = merged;
  const frames = [];
  while (this.pending.length >= 5) {
   const size = new DataView(this.pending.buffer, this.pending.byteOffset).getUint32(1);
   if (size > MAX_FRAME) throw new Error('API frame exceeds size limit');
   if (this.pending.length < size + 5) break;
   const flags = this.pending[0];
   if (flags !== 0 && flags !== 128) throw new Error('Unsupported API frame encoding');
   frames.push({ trailer: flags === 128, data: this.pending.slice(5, 5 + size) });
   this.pending = this.pending.slice(5 + size);
  }
  return frames;
 }
}

export class Client {
 constructor(instance, base = '/cgi-bin/homeproxy-api') {
  if (!['client', 'server'].includes(instance)) throw new Error('Invalid instance');
  this.instance = instance; this.base = base;
 }
 async *stream(methodName, request = {}, signal) {
  const method = service.methods[methodName];
  if (!method) throw new Error('Unsupported API method');
  method.resolve();
  const payload = method.resolvedRequestType.encode(method.resolvedRequestType.fromObject(request)).finish();
  const response = await (this.base === '/cgi-bin/homeproxy-api' ? hpNativeFetch : fetch)(`${this.base}/${this.instance}/${methodName}`, {
   method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
   headers: { 'Content-Type': 'application/grpc-web+proto', 'Authorization': globalThis.L?.env?.sessionid ? 'LuCI ' + globalThis.L.env.sessionid : '' }, body: frame(payload)
  });
  if (!response.ok) throw Object.assign(new Error(`API HTTP ${response.status}: ${await response.text()}`), { status: response.status });
  const reader = response.body.getReader();
  const decoder = new FrameDecoder();
  let finished = false;
  try {
   while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const item of decoder.push(value)) {
     if (item.trailer) {
      const text = new TextDecoder().decode(item.data);
      const status = text.match(/grpc-status:\s*(\d+)/i)?.[1];
      if (status !== '0') throw new Error(text.match(/grpc-message:\s*([^\r\n]*)/i)?.[1] || `API status ${status || 'missing'}`);
      finished = true;
     } else {
      if (finished) throw new Error('Data after API trailers');
      yield method.resolvedResponseType.toObject(method.resolvedResponseType.decode(item.data), { longs: String, enums: String, defaults: true });
     }
    }
   }
   if (!finished || decoder.pending.length) throw new Error('API stream ended; reconnecting');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
 }
 async call(methodName, request = {}, signal) {
  let result;
  for await (const message of this.stream(methodName, request, signal)) result = message;
  return result;
 }
 subscribe(methodName, request, onMessage, onState = () => {}) {
  const controller = new AbortController();
  let timer, wake;
  const wait = (ms) => new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, ms); });
  (async () => {
   let delay = 1000;
   while (!controller.signal.aborted) {
    try {
     onState('connecting');
     for await (const item of this.stream(methodName, request, controller.signal)) {
      if (controller.signal.aborted) break;
      delay = 1000; onMessage(item); onState('connected');
     }
    } catch (error) {
     if (controller.signal.aborted) break;
     onState('error', error.message);
     if (error.status === 401 || error.status === 403 || error.status === 429) break;
    }
    if (controller.signal.aborted) break;
    await wait(delay); delay = Math.min(delay * 2, 15000);
   }
  })();
  return () => { controller.abort(); clearTimeout(timer); wake?.(); };
 }
}

export { hpNativeFetch as nativeFetch };
