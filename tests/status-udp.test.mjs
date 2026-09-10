import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
class Element {
 constructor(tag, attrs={}, children=[]) { this.tag=tag;this.attrs=attrs;this.children=Array.isArray(children)?children:[children];this.style={};this.value=attrs.value;this.disabled=attrs.disabled;this.isConnected=true; }
 get textContent(){return this.children.map(c=>c?.textContent??c).join('');}
 set textContent(s){this.children=[s];}
 click(){return this.attrs.click?.();}
}
function fixture(messages, options={}) {
 const requests=[];
 class Client {
  async call(){return {version:'1.14.0',apiVersion:4};}
  async *stream(method, request, signal){
   requests.push({method,request,signal});
   if(options.wait) await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
   for(const message of messages) yield message;
  }
 }
 const E=(...args)=>new Element(...args), window={HomeProxyAPI:{Client},addEventListener(){},removeEventListener(){}};
 const document={body:E('body'),addEventListener(){},removeEventListener(){}};
 const rpc={declare:()=>async()=>({running:!options.stopped,compatible:true,api:{enabled:true},expected:'1.14.0',api_version:4,udp_outbound:'main-udp-out'})};
 const ui={createHandlerFn:(scope,fn)=>fn.bind(scope)};
 const source=fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/status.js','utf8').split('return view.extend({')[0];
 const create=new Function('E','window','document','rpc','ui','L','MutationObserver','_',source+'\nreturn getUDPConnStat;')(E,window,document,rpc,ui,{},class {observe(){} disconnect(){}},s=>s);
 const option={};create(option);
 const elements=option.default.children.filter(x=>x instanceof Element);
 return {requests,check:elements.find(x=>x.tag==='button'&&x.textContent==='Check'),cancel:elements.find(x=>x.tag==='button'&&x.textContent==='Cancel'),result:elements.find(x=>x.tag==='strong'),details:elements.find(x=>x.tag==='small')};
}

test('UDP check requires a binding response and uses the configured UDP outbound',async()=>{
 const f=fixture([{phase:0},{externalAddr:'192.0.2.1:1234',latencyMs:42}]);await f.check.click();
 assert.equal(f.result.textContent,'passed');assert.equal(f.result.title,'42 ms');
 assert.equal(f.requests[0].request.server,'stun.cloudflare.com:3478');
 assert.equal(f.requests[0].request.outboundTag,'main-udp-out');
 assert.equal(f.requests[0].signal.aborted,true);
 assert.equal(f.check.textContent,'Check');
});
test('a completed RPC without a STUN reply must fail',async()=>{
 const f=fixture([{isFinal:true,error:''}]);await f.check.click();
 assert.equal(f.result.textContent,'failed');assert.match(f.result.title,/No valid STUN response/);
});
test('STUN errors are shown instead of a success marker',async()=>{
 const f=fixture([{isFinal:true,error:'connection refused'}]);await f.check.click();
 assert.equal(f.result.textContent,'failed');assert.match(f.result.title,/connection refused/);
});
test('cancel aborts the active request and resets the button',async()=>{
 const f=fixture([],{wait:true});const pending=f.check.click();await new Promise(r=>setImmediate(r));f.check.click();await pending;
 assert.equal(f.result.textContent,'Cancelled');assert.equal(f.check.textContent,'Check');
});
test('a stopped core does not start a UDP test',async()=>{
 const f=fixture([],{stopped:true});await f.check.click();assert.equal(f.requests.length,0);assert.match(f.result.title,/Start the paired core/);
});
