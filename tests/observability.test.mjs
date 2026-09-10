import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// A small DOM fixture exercises view state without a router or a build step.
class Element {
 constructor(tag, attrs = {}, children = []) {
  this.tag = tag; this.attrs = attrs; this.children = []; this.dataset = {};
  this.value = attrs.value || ''; this.isConnected = true;
  this.append(...(Array.isArray(children) ? children : [children]));
  if (tag === 'select') this.value = (this.children.find(c => c.attrs?.selected != null) || this.children[0])?.value || '';
 }
 append(...children) { this.children.push(...children.filter(c => c != null)); }
 replaceChildren(...children) { this.children = []; this.append(...children); }
 addEventListener(key, callback) { this.attrs[key] = callback; }
 setAttribute(key, value) { this.attrs[key] = value; }
 get textContent() { return this.children.map(c => c instanceof Element ? c.textContent : String(c)).join(''); }
 set textContent(value) { this.children = [value]; }
 get firstChild() { return this.children[0]; }
 click() { return this.attrs.click?.(); }
}
const E = (tag, attrs, children) => new Element(tag, attrs, children);
function walk(node) { return node instanceof Element ? [node, ...node.children.flatMap(walk)] : []; }
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
 const runtime = { version: '1.14.0', expected: '1.14.0', api_version: 4, compatible: true, running: true, api: { enabled: true }, ...overrides };
 const streams = [], controls = [], stages = [], listeners = {}, exports = [], timers = [];
 class Client {
  async *stream(method,request,signal) {
   let resolve;const promise=new Promise(r=>resolve=r);const item={method,stopped:false,callback:data=>resolve(data)};streams.push(item);
   signal?.addEventListener('abort',()=>{item.stopped=true;resolve(null);});
   try { const data=await promise;if(data)yield data; }finally{item.stopped=true;}
  }
  async call(method, request) { controls.push({ method, request }); return { version: '1.14.0', apiVersion: 4 }; }
  subscribe(method, request, callback) { const s = { method, callback, stopped: false }; streams.push(s); return () => { s.stopped = true; }; }
 }
 class ReportURL extends URL { static createObjectURL(blob) { exports.push(blob); return 'blob:test'; } static revokeObjectURL() {} }
 const document = { hidden: false, body: E('body'), addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: () => {} };
 const rpc = { declare: ({ method }) => async (...args) => {
  if (method === 'runtime') return runtime;
  stages.push(args); return { status: 'pass', message: 'fixture', details: {} };
 } };
 const ui = { createHandlerFn: (scope, fn) => fn.bind(scope), addNotification: () => {} };
 const window = { HomeProxyAPI: { Client }, addEventListener: () => {}, removeEventListener: () => {} };
 const source = fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/observability.js', 'utf8');
 const view = new Function('view','rpc','ui','L','E','window','document','location','MutationObserver','requestAnimationFrame','_','URL','poll','performance','setTimeout','clearTimeout', source)(
  { extend: v => v }, rpc, ui, { url: p => '/' + p }, E, window, document, { hostname: 'router.test' },
  class { observe() {} disconnect() {} }, fn => queueMicrotask(fn), s => s, ReportURL, {add(){},remove(){}}, {now:()=>Date.now()}, (fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;}, timer=>{if(timer)timer.cancelled=true;});
 const root = view.render([null, runtime]);
 const button = label => { const b = walk(root).find(n => n.tag === 'button' && n.textContent === label); assert.ok(b, label); return b; };
 return { root, button, streams, controls, stages, exports, document, listeners, timers };
}

test('the overview subscribes only after the pinned API version check', async () => {
 const f = fixture(); await settle();
 assert.equal(f.controls[0].method, 'GetVersion');
 assert.equal(f.streams[0].method, 'SubscribeStatus');
 f.streams[0].callback({ memory: 1048576, connectionsIn: 2, connectionsOut: 3 });
 await settle();
 assert.match(f.root.textContent, /1.0 MiB/);
 const unavailable = fixture({ compatible: false }); await settle();
 assert.equal(unavailable.streams.length, 0);
 assert.match(unavailable.root.textContent, /paired core must be running/);
});

test('log pause and hidden-page cancellation do not keep rendering messages', async () => {
 const f = fixture(); await settle(); await f.button('Logs').click();
 assert.ok(f.streams[0].stopped);
 const log = f.streams.at(-1);
 log.callback({ messages: [{ level: 'DEBUG', message: 'first line' }] });
 await settle();
 assert.match(f.root.textContent, /first line/);
 f.button('Pause display').click();
 log.callback({ messages: [{ level: 'DEBUG', message: '\x1b[32msecond line\x1b[0m' }] });
 await settle();
 assert.doesNotMatch(f.root.textContent, /second line/);
 f.button('Resume display').click();
 f.streams.at(-1).callback({reset:true,messages:[{level:'DEBUG',message:'second line'}]});
 await settle();
 assert.match(f.root.textContent, /second line/);
 assert.doesNotMatch(f.root.textContent, /\x1b\[/);
 f.document.hidden = true; f.listeners.visibilitychange();
 assert.ok(log.stopped);
 log.callback({ messages: [{ level: 'ERROR', message: 'late line' }] });
 await settle();
 assert.doesNotMatch(f.root.textContent, /late line/);
});

test('closed connections leave the active view but remain available in history', async () => {
 const f = fixture(); await settle(); await f.button('Connections').click();
 const stream = f.streams.at(-1);
 stream.callback({ events: [{ type: 'CONNECTION_EVENT_NEW', id: 'id1', connection: { id: 'id1', domain: 'example.test', network: 'tcp' } }] });
 await settle();
 assert.match(f.root.textContent, /example.test/);
 stream.callback({ events: [{ type: 'CONNECTION_EVENT_CLOSED', id: 'id1' }] });
 await settle();
 assert.doesNotMatch(f.root.textContent, /example.test/);
 const filter = walk(f.root).find(n => n.attrs['aria-label'] === 'Connection state');
 filter.value = 'closed'; filter.attrs.change();
 assert.match(f.root.textContent, /example.test/);
});

test('diagnostics use the complete target but export only its origin', async () => {
 const f = fixture(); await settle(); await f.button('Diagnostics').click();
 walk(f.root).find(n => n.attrs['aria-label'] === 'Domain or URL').value = 'https://example.test/private?token=secret#fragment';
 await f.button('Start diagnosis').click();
 assert.equal(f.stages.length, 11);
 assert.match(f.stages[0][1], /token=secret/);
 f.button('Export result').click();
 const report = JSON.parse(await f.exports[0].text());
 assert.equal(report.target, 'https://example.test');
 assert.doesNotMatch(JSON.stringify(report), /secret|private|fragment/);
});

test('tabs expose the active page and only the selected tab is in the tab order', async () => {
 const f = fixture(); await settle();
 const tabs = () => walk(f.root).filter(n => n.attrs.role === 'tab');
 assert.equal(tabs().filter(t => t.attrs['aria-selected'] === 'true').length, 1);
 assert.equal(f.button('Overview').attrs.tabindex, '0');
 await f.button('Logs').click();
 assert.equal(f.button('Logs').attrs['aria-selected'], 'true');
 assert.equal(f.button('Overview').attrs['aria-selected'], 'false');
 assert.equal(f.button('Overview').attrs.tabindex, '-1');
 assert.equal(walk(f.root).find(n => n.attrs.role === 'tabpanel').attrs['aria-labelledby'], 'hp-tab-logs');
 const active = walk(f.root).find(n => n.attrs.class === 'cbi-tab');
 assert.equal(active.firstChild, f.button('Logs'));
});

test('empty connection lists disable pagination and explain their state', async () => {
 const f = fixture(); await settle(); await f.button('Connections').click();
 f.streams.at(-1).callback({ reset: true, events: [] });
 await settle();
 assert.equal(f.button('Previous').disabled, true);
 assert.equal(f.button('Next').disabled, true);
 assert.match(f.root.textContent, /No active connections/);
});

test('diagnostic actions distinguish idle and completed reports', async () => {
 const f = fixture(); await settle(); await f.button('Diagnostics').click();
 assert.equal(f.button('Cancel').disabled, true);
 assert.equal(f.button('Export result').disabled, true);
 walk(f.root).find(n => n.attrs['aria-label'] === 'Domain or URL').value = 'example.test';
 await f.button('Start diagnosis').click();
 assert.equal(f.button('Cancel').disabled, true);
 assert.equal(f.button('Export result').disabled, false);
 assert.match(f.root.textContent, /Diagnosis finished · 11 \/ 11/);
});


test('groups release the snapshot stream and preserve expansion while filtering', async () => {
 const f=fixture({names:{a:'Proxy',b:'Node B'}});await settle();await f.button('Groups').click();
 const stream=f.streams.at(-1), payload={group:[{tag:'cfg-a-out',type:'selector',selectable:true,selected:'cfg-b-out',items:[{tag:'cfg-b-out',urlTestDelay:42}]}]};
 stream.callback(payload);
 await settle();
 assert.match(f.root.textContent,/Node B/);assert.match(f.root.textContent,/42 ms/);
 assert.doesNotMatch(f.root.textContent,/cfg-a-out/);
 let details=walk(f.root).find(n=>n.tag==='details');details.open=false;details.attrs.toggle();
 assert.equal(stream.stopped,true);
 walk(f.root).find(n=>n.attrs['aria-label']==='Search groups or members').attrs.input();
 details=walk(f.root).find(n=>n.tag==='details');assert.equal(details.attrs.open,null);
 await settle();
 const search=walk(f.root).find(n=>n.attrs['aria-label']==='Search groups or members');search.value='absent';search.attrs.input();assert.match(f.root.textContent,/No matching groups/);
 search.value='Node B';search.attrs.input();assert.match(f.root.textContent,/42 ms/);
});

test('log snapshot replaces history and a core reset clears it', async () => {
 const f=fixture(); await settle(); await f.button('Logs').click();
 const log=f.streams.at(-1);
 log.callback({reset:true,messages:[{level:'INFO',message:'old snapshot'}]});
 await settle();
 log.callback({reset:false,messages:[{level:'INFO',message:'live event'}]});
 await settle();
 assert.match(f.root.textContent,/old snapshot/);assert.match(f.root.textContent,/live event/);
 log.callback({reset:true,messages:[{level:'INFO',message:'new snapshot'}]});
 await settle();
 assert.doesNotMatch(f.root.textContent,/old snapshot|live event/);
 log.callback({reset:true,messages:[]});
 await settle();
 assert.doesNotMatch(f.root.textContent,/new snapshot/);
});

test('URLTest refreshes late results after the core timeout and cancels on leave', async()=>{
 const f=fixture();await settle();await f.button('Groups').click();
 const group={tag:'g',selectable:true,items:[{tag:'n',urlTestDelay:1}]};
 f.streams.at(-1).callback({group:[group]});await settle();
 const pending=f.button('Test latency').click();await settle();
 f.streams.at(-1).callback({group:[group]});await pending;
 const late=f.timers.find(t=>t.ms===16000);assert.ok(late);
 late.fn();await settle();f.streams.at(-1).callback({group:[{...group,items:[{tag:'n',urlTestDelay:15000}]}]});await settle();
 assert.match(f.root.textContent,/15000 ms/);
 await f.button('Logs').click();assert.equal(late.cancelled,true);
});
