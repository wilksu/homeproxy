import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source=fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/node.js','utf8');
const helper=source.slice(source.indexOf('function runSubscriptionUpdate'),source.indexOf('// Shared by individual deletion'));
function load(result,calls){return new Function('fs','_',helper+'return runSubscriptionUpdate;')({exec_direct:async(...args)=>{calls.push(args);return result;}},s=>s);}
test('the subscription UI rejects failed or malformed command results, instead of reloading as success',async()=>{
 for(const result of [{code:1},{},null])await assert.rejects(load(result,[])('src_test'),/Subscription update failed/);
 const calls=[];await load({code:0},calls)('src_test');await load({code:0},calls)();
 assert.deepEqual(calls,[['/etc/homeproxy/scripts/update_subscriptions_ui.sh',['src_test'],'json'],['/etc/homeproxy/scripts/update_subscriptions_ui.sh',[],'json']]);
});
test('the CGI wrapper returns exit status and keeps private error details in the local log',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hp-ui-update-'));
 try{
  const updater=path.join(dir,'updater');fs.writeFileSync(updater,'#!/bin/sh\necho private-output\necho private-error >&2\nexit "$1"\n',{mode:0o700});
  const wrapper=path.join(dir,'wrapper');fs.writeFileSync(wrapper,fs.readFileSync('root/etc/homeproxy/scripts/update_subscriptions_ui.sh','utf8').replace('/etc/homeproxy/scripts/update_subscriptions.uc',updater).replaceAll('/var/run/homeproxy',dir));
  for(const code of [0,1,17]){const p=spawnSync('/bin/sh',[wrapper,String(code)],{encoding:'utf8'});assert.equal(p.status,0);assert.deepEqual(JSON.parse(p.stdout),{code});assert.equal(p.stderr,'');}
  const log=path.join(dir,'homeproxy.log');assert.match(fs.readFileSync(log,'utf8'),/private-output\nprivate-error/);assert.equal(fs.statSync(log).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
