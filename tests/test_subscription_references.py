"""Subscription removals must not leave external references dangling."""
import json,os,pathlib,subprocess,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
UCODE=os.environ.get('UCODE')

@unittest.skipUnless(UCODE,'UCODE required')
class SubscriptionReferenceTests(unittest.TestCase):
 def check(self,records,removed):
  source=(ROOT/'root/etc/homeproxy/scripts/update_subscriptions.uc').read_text()
  body=source[source.index('function externalReferences'):source.index('\nfunction main')]
  code='''
const records=%s;
const uci={foreach:function(_config,kind,callback){for(let record in records)if(record['.type']===kind)callback(record);}};
%s
print(sprintf('%%J',externalReferences(%s,'hash-a')));
'''%(json.dumps(records),body,json.dumps(removed))
  result=subprocess.run([UCODE,'-e',code],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
  return json.loads(result.stdout)
 def test_external_reference_blocks_removal(self):
  records=[{'.name':'gone','.type':'node','grouphash':'hash-a'},
           {'.name':'local','.type':'node','label':'Local','node_detour':'gone'}]
  self.assertEqual(self.check(records,['gone']),['Local.node_detour -> gone'])
 def test_removed_owners_and_same_source_nodes_do_not_block(self):
  records=[{'.name':'gone','.type':'node','grouphash':'hash-a','group_nodes':['other']},
           {'.name':'survivor','.type':'node','grouphash':'hash-a','group_nodes':['gone']}]
  self.assertEqual(self.check(records,['gone']),[])
 def test_cross_source_reference_blocks_removal(self):
  records=[{'.name':'gone','.type':'node','grouphash':'hash-a'},
           {'.name':'other','.type':'node','label':'Other','grouphash':'hash-b','node_detour':'gone'}]
  self.assertEqual(self.check(records,['gone']),['Other.node_detour -> gone'])
