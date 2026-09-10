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
