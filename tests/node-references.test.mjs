import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/node.js','utf8');
const body=source.slice(source.indexOf('function nodeReferences'),source.indexOf('function allowInsecureConfirm'));
const references=new Function(body+'return nodeReferences;')();
test('remove subscriptions detects defaults, policies, DNS, groups and dial dependencies',()=>{
 const records=[
  {'.name':'routing','.type':'homeproxy',default_outbound:'sub'},
  {'.name':'config','.type':'homeproxy',main_node:'sub',main_udp_urltest_nodes:['sub']},
  ...['routing_rule','dns_server','dns_rule','ruleset'].map(type=>({'.name':type,'.type':type,outbound:'sub'})),
  {'.name':'manual','.type':'node',group_nodes:['sub'],group_default:'sub',local_detour:'sub',node_base:'sub',node_detour:'sub'},
  {'.name':'legacy','.type':'routing_node',node:'sub',outbound:'sub',urltest_nodes:['sub']}
 ];
 assert.equal(references(records,['sub']).length,15);
 assert.deepEqual(references(records,['unreferenced']),[]);
 assert.deepEqual(references([{'.name':'sub','.type':'node',group_nodes:['sub2']}],['sub','sub2']),[]);
});

test('individual removal blocks referenced nodes and delegates unused nodes to LuCI',()=>{
 const sections=[{'.name':'group','.type':'node',group_nodes:['used']}];
 const notices=[],removed=[];
 const form={GridSection:{prototype:{handleRemove(id){removed.push(id);return 'saved';}}}};
 const remove=new Function('uci','ui','form','E','_',body+'return removeNode;')(
  {sections:()=>sections},{addNotification:(...args)=>notices.push(args)},form,(_tag,_attrs,text)=>text,s=>s);
 const section={map:{config:'homeproxy',readonly:false}};
 remove.call(section,'used');assert.equal(notices.length,1);assert.deepEqual(removed,[]);
 assert.equal(remove.call(section,'unused'),'saved');assert.deepEqual(removed,['unused']);
 section.map.readonly=true;remove.call(section,'unused');assert.deepEqual(removed,['unused']);
});
