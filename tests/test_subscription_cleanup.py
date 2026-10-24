"""Reconcile main-node references; activation is owned by the transaction tests."""
import json, os, pathlib, subprocess, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
UCODE=os.environ.get('UCODE','')

@unittest.skipUnless(UCODE,'UCODE required')
class SubscriptionCleanupTests(unittest.TestCase):
 def reconcile(self, main, udp, members, first='live'):
  source=(ROOT/'root/etc/homeproxy/scripts/update_subscriptions.uc').read_text()
  body=source[source.index('\tif (!isEmpty(main_node)'):source.index('\n}\n\nif (!isEmpty(subscription_urls))')]
  harness='''let state={main_urltest_nodes:MEMBERS,main_udp_urltest_nodes:MEMBERS};
let commits=0;const uciconfig='homeproxy',ucimain='config',ucinode='node';
const main_node=MAIN,main_udp_node=UDP,added=1,removed=1;
const uci={get_first:()=>FIRST,get:(c,n,k)=>k?state[k]:(n==='live'?'node':null),set:(c,n,k,v)=>{state[k]=v;},commit:()=>{commits++;}};
const isEmpty=v=>!v;const log=()=>{};
BODY
printf('%J',{state,commits});'''
  for key,value in [('MEMBERS',members),('MAIN',main),('UDP',udp),('FIRST',first)]:
   harness=harness.replace(key,json.dumps(value))
  result=subprocess.run([UCODE,'-e',harness.replace('BODY',body)],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr);return json.loads(result.stdout)

 def test_removed_members_are_pruned_and_disabled_udp_stays_disabled(self):
  for udp in ['nil','urltest']:
   with self.subTest(udp=udp):
    result=self.reconcile('urltest',udp,['gone','live'])
    self.assertEqual(result['commits'],1)
    self.assertEqual(result['state']['main_urltest_nodes'],['live'])
    if udp=='urltest':self.assertEqual(result['state']['main_udp_urltest_nodes'],['live'])
    self.assertNotIn('main_udp_node',result['state'])

 def test_empty_groups_and_missing_nodes_fall_back_to_first_node(self):
  for main in ['urltest','gone']:
   result=self.reconcile(main,'urltest',['gone'])
   self.assertEqual(result['state']['main_node'],'live')
   self.assertEqual(result['state']['main_udp_node'],'live')
  result=self.reconcile('gone','same',[],first=None)
  self.assertEqual(result['state']['main_node'],'nil')
  self.assertEqual(result['state']['main_udp_node'],'nil')
