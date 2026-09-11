"""Subscription removals must not leave external or local-override references dangling."""
import json,os,pathlib,subprocess,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
UCODE=os.environ.get('UCODE')

@unittest.skipUnless(UCODE,'UCODE required')
class SubscriptionReferenceTests(unittest.TestCase):
 def check(self,records,removed):
  source=(ROOT/'root/etc/homeproxy/scripts/update_subscriptions.uc').read_text()
  body=source[source.index('function externalReferences'):source.index('\nfunction service_action')]
  code='''
const records=%s;
const uci={foreach:function(_config,kind,callback){for(let record in records)if(record['.type']===kind)callback(record);}};
%s
print(sprintf('%%J',externalReferences(%s,'source-a','hash-a')));
'''%(json.dumps(records),body,json.dumps(removed))
  result=subprocess.run([UCODE,'-e',code],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
  return json.loads(result.stdout)
 def test_external_reference_blocks_removal(self):
  records=[{'.name':'gone','.type':'node','source_id':'source-a'},
           {'.name':'local','.type':'node','label':'Local','node_mode':'reference','node_base':'gone'}]
  self.assertEqual(self.check(records,['gone']),['Local.node_base -> gone'])
 def test_removed_owners_and_replaced_source_fields_do_not_block(self):
  records=[{'.name':'gone','.type':'node','source_id':'source-a','group_nodes':['other']},
           {'.name':'survivor','.type':'node','source_id':'source-a','group_nodes':['gone']}]
  self.assertEqual(self.check(records,['gone']),[])
 def test_preserved_local_override_is_checked(self):
  records=[{'.name':'gone','.type':'node','source_id':'source-a'},
           {'.name':'survivor','.type':'node','source_id':'source-a','local_detour':'gone'}]
  self.assertEqual(self.check(records,['gone']),['survivor.local_detour -> gone'])
