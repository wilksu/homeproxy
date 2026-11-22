import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';

class Element {
	constructor(tag, attrs = {}, children = []) { this.tag=tag;this.attrs=attrs;this.children=[];this.append(...(Array.isArray(children)?children:[children])); }
	append(...children) { this.children.push(...children.filter(value=>value != null)); }
	get textContent() { return this.children.map(child=>child instanceof Element?child.textContent:String(child)).join(''); }
}
const E=(tag,attrs,children)=>new Element(tag,attrs,children);
const walk=node=>node instanceof Element?[node,...node.children.flatMap(walk)]:[];

function fixture(existing) {
	const sections=existing?{observability:{'.type':'homeproxy',external:'0'}}:{};
	const events=[], options={};
	const uci={
		async load(){}, get(_config,section,option){const value=sections[section];return option?value?.[option]:value?.['.type'];},
		add(_config,type,name){events.push('add');sections[name]={'.type':type};return name;},
		set(_config,section,option,value){sections[section][option]=value;}, unset(_config,section,option){delete sections[section][option];},
		remove(_config,section){events.push('remove');delete sections[section];}, async save(){events.push('save');}
	};
	class Option {
		dependencies=[];
		depends(...args){this.dependencies.push(args);}
		formvalue(){return this.current;}
		value(){}
	}
	class Map {
		section(){return {option(_type,key){return options[key]=new Option();}};}
		lookupOption(key){return [options[key]];}
		async render(){return E('div',{},sections.observability?['settings-fields']:[]);}
		async save(){events.push('map-save');}
	}
	let modal;
	const ui={showModal(_title,content){modal=content;},hideModal(){events.push('hide');},createHandlerFn(scope,fn){return fn.bind(scope);},changes:{async apply(){events.push('apply');}}};
	const rpc={declare:({method})=>async instance=>{
		if (method==='dashboard_launch') {
			events.push(instance);
			return {url:'http://192.0.2.2:5336/dashboard/homeproxy-connect.html',secret:'a'.repeat(64)};
		}
		return {secret:'fixture'};
	}};
	const formPost={submit(){events.push('submit');}};
	const tab={opener:{},document:{createElement:()=>formPost,body:{appendChild(){}}}};
	const window={location:{hostname:'127.0.0.1',protocol:'http:'},open:()=>tab};
	const form={Map,NamedSection:class{},Flag:class{},Value:class{},ListValue:class{},DynamicList:class{},DummyValue:class{}};
	const source=fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/observe-settings.js','utf8');
	const settings=new Function('baseclass','form','uci','ui','rpc','E','_','window',source)({extend:value=>value},form,uci,ui,rpc,E,value=>value,window);
	return {settings,sections,events,options,formPost,tab,modal:()=>modal,button(label){return walk(E('div',{},modal)).find(node=>node.tag==='button'&&node.textContent===label);}};
}

test('missing observability settings render with defaults and cancel cleanly',async()=>{
	const f=fixture(false);await f.settings.open();
	assert.equal(f.modal()[0].textContent,'settings-fields');
	assert.equal(f.sections.observability.client_port,'5334');
	assert.equal(f.sections.observability.server_port,'5335');
	f.button('Cancel').attrs.click();
	assert.equal(f.sections.observability,undefined);
	assert.deepEqual(f.events,['add','remove','hide']);
});

test('fallback observability settings persist only when applied and gRPC is optional',async()=>{
	const f=fixture(false);await f.settings.open();await f.button('Save & Apply').attrs.click();
	assert.equal(f.sections.observability.enabled,'1');
	assert.equal(f.options.native_api.default,'0');
	assert.deepEqual(f.options.native_tls_cert.dependencies,[[{native_api:'1',_advanced:'1'}]]);
	assert.deepEqual(f.events,['add','map-save','save','hide','apply']);
	const existing=fixture(true);await existing.settings.open();assert.deepEqual(existing.events,[]);
});

test('native address and port validation use the running instance and Clash settings',async()=>{
	const f=fixture(true);
	await f.settings.open({running:true,grpc_url:'http://127.0.0.1:5336'});
	assert.equal(f.options._native_endpoint.renderWidget().children[0].attrs.value,'http://127.0.0.1:5336');
	f.options.native_api.current='1';
	assert.equal(f.options.native_client_port.validate('observability','5334'),'API ports must be distinct.');
	assert.equal(f.options.native_client_port.validate('observability','5336'),true);
});

test('local Dashboard opening uses the forwarded host and puts the secret only in the fragment',async()=>{
	const f=fixture(true);
	await f.settings.open({running:true,grpc_dashboard:true,grpc_url:'http://192.0.2.2:5336'});
	const endpoint=f.options._native_endpoint.renderWidget();
	assert.equal(endpoint.children[0].attrs.value,'http://127.0.0.1:5336');
	await endpoint.children[1].attrs.click();
	assert.equal(f.tab.opener,null);
	assert.equal(f.formPost.method,'post');
	const address=new URL(f.formPost.action);
	assert.equal(address.origin,'http://127.0.0.1:5336');
	assert.equal(address.search,'');
	assert.equal(address.hash,'#secret='+ 'a'.repeat(64));
	assert.deepEqual(f.events,['client','submit']);
});

test('the Dashboard launcher stores the selected local endpoint and removes the secret from the URL',()=>{
	const html=fs.readFileSync('root/usr/share/homeproxy/dashboard-connect.html','utf8');
	const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
	const events=[];
	const saved={id:'other',url:'https://example.test'};
	const location={hash:'#secret='+ 'b'.repeat(64),pathname:'/dashboard/homeproxy-connect.html',
		origin:'https://router.test:5336',replace(url){events.push(url);}};
	const history={replaceState(_state,_title,url){events.push(url);}};
	const localStorage={
		getItem:()=>JSON.stringify({servers:[saved,{id:'homeproxy-local',secret:'old'}]}),
		setItem(key,value){assert.equal(key,'sing-box-dashboard.servers');events.push(JSON.parse(value));}
	};
	runInNewContext(script,{location,history,localStorage,URLSearchParams});
	assert.equal(events[0],location.pathname);
	assert.deepEqual(events[1],{activeId:'homeproxy-local',servers:[saved,{
		id:'homeproxy-local',name:'HomeProxy',url:location.origin,secret:'b'.repeat(64)
	}]});
	assert.equal(events[2],'./');
});
