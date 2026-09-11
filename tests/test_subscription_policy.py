"""Remote configuration cannot acquire local router services or write permissions."""
import json,os,pathlib,subprocess,tempfile,unittest
from test_generator import ROOT,UCODE
class ACLTests(unittest.TestCase):
 def test_update_requires_write_access(self):
  acl=json.loads((ROOT/'root/usr/share/rpcd/acl.d/luci-app-homeproxy.json').read_text())['luci-app-homeproxy']
  path='/etc/homeproxy/scripts/update_subscriptions.uc'
  self.assertNotIn('exec',acl['read']['file'].get(path,[]))
  self.assertIn('exec',acl['write']['file'][path])
  self.assertNotIn('api_control',acl['read']['ubus']['luci.homeproxy'])
@unittest.skipUnless(UCODE,'UCODE required')
class RemoteEndpointTests(unittest.TestCase):
 def test_subscription_rejects_local_service_endpoint(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=pathlib.Path(tmp);(p/'digest.uc').write_text("export function md5(v) { return 'fixture'; }")
   module=ROOT/'root/etc/homeproxy/scripts/node_import.uc'
   for fields in [{},{'ssh_server':True},{'system_interface':True},{'advertise_exit_node':True},{'state_directory':'/root','auth_key':'remote','taildrop_directory':'/etc'}]:
    payload={'type':'tailscale','tag':'remote',**fields}
    code='import {importNode} from '+json.dumps(str(module))+'; importNode('+json.dumps(payload)+',x=>x);'
    r=subprocess.run([UCODE,'-L',str(p/'*.uc'),'-e',code],capture_output=True,text=True)
    self.assertNotEqual(r.returncode,0);self.assertIn('must be configured locally',r.stderr)
 def test_unreferenced_unsupported_outbounds_are_skipped(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=pathlib.Path(tmp);(p/'digest.uc').write_text("export function md5(v) { return 'fixture'; }")
   bindir=p/'bin';bindir.mkdir();core=bindir/'sing-box';core.write_text('#!/bin/sh\nexit 0\n');core.chmod(0o755)
   module=ROOT/'root/etc/homeproxy/scripts/node_import.uc'
   payload={'outbounds':[{'tag':'proxy','type':'shadowsocks','server':'192.0.2.1','server_port':443,'method':'aes-128-gcm','password':'fixture'},{'tag':'block','type':'block'},{'tag':'dns-out','type':'dns'}]}
   code='import {importNodes} from '+json.dumps(str(module))+'; print(length(importNodes('+json.dumps(payload)+',"source")));'
   env={**os.environ,'PATH':str(bindir)+':'+os.environ['PATH'],'HP_OUTPUT_DIR':tmp}
   r=subprocess.run([UCODE,'-L',str(p/'*.uc'),'-e',code],env=env,capture_output=True,text=True)
   self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout,'1')
 def test_dependency_on_skipped_outbound_is_rejected(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=pathlib.Path(tmp);(p/'digest.uc').write_text("export function md5(v) { return 'fixture'; }")
   module=ROOT/'root/etc/homeproxy/scripts/node_import.uc'
   payload={'outbounds':[{'tag':'group','type':'selector','outbounds':['block']},{'tag':'block','type':'block'}]}
   code='import {importNodes} from '+json.dumps(str(module))+'; importNodes('+json.dumps(payload)+',"source");'
   r=subprocess.run([UCODE,'-L',str(p/'*.uc'),'-e',code],env={**os.environ,'HP_OUTPUT_DIR':tmp},capture_output=True,text=True)
   self.assertNotEqual(r.returncode,0);self.assertIn('Missing group member or detour',r.stderr)
