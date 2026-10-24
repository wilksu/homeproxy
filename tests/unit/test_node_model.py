import json,os,pathlib,subprocess,tempfile,unittest
from support.ucode import ROOT,UCODE
@unittest.skipUnless(UCODE,'UCODE required')
class NodeModelTests(unittest.TestCase):
 def resolve(self,nodes,id='ref'):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp);(path/'config.json').write_text(json.dumps(nodes))
   (path/'test.uc').write_text("import{cursor}from'uci';import{nodeModel}from'node_model';try{print(sprintf('%J',{node:nodeModel(cursor()).validate("+json.dumps(id)+")}));}catch(e){print(sprintf('%J',{error:''+e}));}")
   r=subprocess.run([UCODE,'-L',str(ROOT/'tests/support/*.uc'),'-L',str(ROOT/'root/etc/homeproxy/scripts/*.uc'),str(path/'test.uc')],env={**os.environ,'HP_TEST_UCI':str(path/'config.json')},capture_output=True,text=True)
   self.assertEqual(r.returncode,0,r.stderr);return json.loads(r.stdout)
 def fixture(self):
  return {'base':{'.type':'node','type':'socks','address':'192.0.2.1','port':'1080'},'ref':{'.type':'node','node_mode':'reference','node_base':'base','local_detour':'up'},'up':{'.type':'node','type':'socks','address':'192.0.2.2','port':'1080'}}
 def test_reference_follows_updates_and_local_override(self):
  c=self.fixture();c['base']['password']='old';self.assertEqual(self.resolve(c)['node']['node_detour'],'up')
  c['base']['password']='new';self.assertEqual(self.resolve(c)['node']['password'],'new')
  c['base']['node_detour']='up';c['ref']['local_detour']='_direct';self.assertIsNone(self.resolve(c)['node'].get('node_detour'))
 def test_missing_and_reference_cycles(self):
  c=self.fixture();c.pop('base');self.assertIn('missing',self.resolve(c)['error'])
  c=self.fixture();c['base'].update(node_mode='reference',node_base='ref');self.assertIn('Circular',self.resolve(c)['error'])
 def test_mixed_group_detour_cycle_and_invalid_default(self):
  c=self.fixture();c['up']={'.type':'node','type':'selector','group_nodes':['ref']};self.assertIn('Circular',self.resolve(c)['error'])
  c['up']['group_nodes']=['base'];c['up']['group_default']='ref';self.assertIn('Default',self.resolve(c)['error'])
 def test_group_cannot_be_used_as_protocol_base(self):
  c=self.fixture();c['base']={'.type':'node','type':'selector','group_nodes':['up']};self.assertIn('proxy outbound',self.resolve(c)['error'])
 def test_stored_remote_tailscale_is_blocked_but_manual_is_kept(self):
  for source in ['grouphash','source_id']:
   c={'ref':{'.type':'node','type':'tailscale',source:'remote','tailscale_ssh_server':'1'}}
   self.assertIn('not permitted',self.resolve(c)['error'])
  c={'ref':{'.type':'node','type':'tailscale','tailscale_ssh_server':'1'}}
  self.assertEqual(self.resolve(c)['node']['type'],'tailscale')
 def test_shared_dependency_graph_is_read_once_per_generation(self):
  # Each group has two shared predecessors: an exponential walk without memoization.
  nodes={'n0':{'.type':'node','type':'socks'},'n1':{'.type':'node','type':'socks'}}
  for i in range(2,100):nodes['n'+str(i)]={'.type':'node','type':'selector','group_nodes':['n'+str(i-1),'n'+str(i-2)]}
  code="import{nodeModel}from'node_model';const nodes="+json.dumps(nodes)+";let reads=0;const model=nodeModel({get_all:(c,id)=>{reads++;return nodes[id];}});for(let id in keys(nodes))model.validate(id);print(reads);"
  result=subprocess.run([UCODE,'-L',str(ROOT/'root/etc/homeproxy/scripts/*.uc'),'-e',code],capture_output=True,text=True,timeout=5)
  self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(int(result.stdout),100)

 def test_failed_validation_does_not_poison_other_roots_or_hide_cycles(self):
  code="""import{nodeModel}from'node_model';
const nodes={cycle:{'.type':'node',type:'selector',group_nodes:['cycle']},valid:{'.type':'node',type:'socks'},missing:{'.type':'node',type:'selector',group_nodes:['absent']}};
const model=nodeModel({get_all:(c,id)=>nodes[id]});let errors=[];
for(let id in ['cycle','missing','cycle','missing'])try{model.validate(id);}catch(e){push(errors,''+e);}
printf('%J',{errors,node:model.validate('valid')});"""
  result=subprocess.run([UCODE,'-L',str(ROOT/'root/etc/homeproxy/scripts/*.uc'),'-e',code],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr);data=json.loads(result.stdout)
  self.assertEqual(len(data['errors']),4)
  self.assertTrue(all('Circular' in e for e in data['errors'][::2]))
  self.assertTrue(all('missing' in e for e in data['errors'][1::2]))
  self.assertEqual(data['node']['type'],'socks')

 def test_new_model_observes_changes_and_returned_records_are_independent(self):
  code="""import{nodeModel}from'node_model';
const nodes={base:{'.type':'node',type:'socks',password:'old'}};
const uci={get_all:(c,id)=>nodes[id]};const first=nodeModel(uci);
let returned=first.validate('base');returned.password='caller-edit';nodes.base={'.type':'node',type:'socks',password:'new'};
printf('%J',[first.validate('base').password,nodeModel(uci).validate('base').password]);"""
  result=subprocess.run([UCODE,'-L',str(ROOT/'root/etc/homeproxy/scripts/*.uc'),'-e',code],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout),['old','new'])
