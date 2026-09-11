import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

class Element {
 constructor(tag, attrs = {}, children = []) { this.tag=tag;this.attrs=attrs;this.children=[];this.append(...(Array.isArray(children)?children:[children])); }
 append(...children) { this.children.push(...children.filter(value=>value != null)); }
 get textContent() { return this.children.map(child=>child instanceof Element?child.textContent:String(child)).join(''); }
}
const E=(tag,attrs,children)=>new Element(tag,attrs,children);
const walk=node=>node instanceof Element?[node,...node.children.flatMap(walk)]:[];

function fixture(existing) {
 const sections=existing?{observability:{'.type':'homeproxy',external:'0'}}:{};
 const events=[];
 const uci={
  async load(){}, get(_config,section,option){const value=sections[section];return option?value?.[option]:value?.['.type'];},
  add(_config,type,name){events.push('add');sections[name]={'.type':type};return name;},
  set(_config,section,option,value){sections[section][option]=value;}, unset(_config,section,option){delete sections[section][option];},
  remove(_config,section){events.push('remove');delete sections[section];}, async save(){events.push('save');}
 };
 class Option { depends(){} }
 class Map {
  section(){return {option(){return new Option();}};}
  lookupOption(){return [];}
  async render(){return E('div',{},sections.observability?['settings-fields']:[]);}
  async save(){events.push('map-save');}
 }
 let modal;
 const ui={showModal(_title,content){modal=content;},hideModal(){events.push('hide');},createHandlerFn(scope,fn){return fn.bind(scope);},changes:{async apply(){events.push('apply');}}};
 const rpc={declare:()=>async()=>({secret:'fixture'})};
 const form={Map,NamedSection:class{},Flag:class{},Value:class{},DynamicList:class{},DummyValue:class{}};
 const source=fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/observe-settings.js','utf8');
 const settings=new Function('baseclass','form','uci','ui','rpc','E','_',source)({extend:value=>value},form,uci,ui,rpc,E,value=>value);
 return {settings,sections,events,modal:()=>modal,button(label){return walk(E('div',{},modal)).find(node=>node.tag==='button'&&node.textContent===label);}};
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

test('fallback observability settings persist only when applied',async()=>{
 const f=fixture(false);await f.settings.open();await f.button('Save & Apply').attrs.click();
 assert.equal(f.sections.observability.enabled,'1');
 assert.deepEqual(f.events,['add','map-save','save','hide','apply']);
 const existing=fixture(true);await existing.settings.open();assert.deepEqual(existing.events,[]);
});
