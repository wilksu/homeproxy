"""Exercise the actual updater's post-import reconciliation, without fetching or restarting."""
import os,pathlib,subprocess,unittest,json
ROOT=pathlib.Path(__file__).resolve().parents[1]
UCODE=os.environ.get('UCODE','')
@unittest.skipUnless(UCODE,'UCODE required')
class SubscriptionCleanupTests(unittest.TestCase):
 def test_member_cleanup_disabled_udp_and_restart_failure(self):
  source=(ROOT/'root/etc/homeproxy/scripts/update_subscriptions.uc').read_text()
  body=source[source.index('\tlet need_restart = true;'):source.index('\n}\n\nif (!isEmpty(subscription_urls))')]
  for udp in ['nil','urltest']:
   for status in [0,1]:
    with self.subTest(udp=udp,status=status):
     harness='''let state={main_urltest_nodes:['gone','live'],main_udp_urltest_nodes:['gone','live']};
let logs=[]; const uciconfig='homeproxy',ucimain='config',ucinode='node';
let main_node='urltest',main_udp_node=UDP;let added=1,removed=1;
const uci={get_first:()=> 'live',get:(c,n,k)=>k?state[k]:(n==='live'?'node':null),set:(c,n,k,v)=>{state[k]=v;},commit:()=>true};
const isEmpty=v=>!v;const log=v=>push(logs,v);const service_action=()=>STATUS;
function reconcile(){ BODY }
let result=reconcile();printf('%J',{state,logs,result});'''.replace('UDP',json.dumps(udp)).replace('STATUS',str(status)).replace('BODY',body)
     p=subprocess.run([UCODE,'-e',harness],capture_output=True,text=True)
     self.assertEqual(p.returncode,0,p.stderr);r=json.loads(p.stdout)
     self.assertEqual(r['state']['main_urltest_nodes'],['live'])
     if udp=='urltest':self.assertEqual(r['state']['main_udp_urltest_nodes'],['live'])
     else:self.assertNotIn('main_udp_node',r['state'])
     if status:self.assertFalse(r['result']);self.assertNotIn('Successfully updated subscriptions.',r['logs'])
     else:self.assertIn('Successfully updated subscriptions.',r['logs'])
