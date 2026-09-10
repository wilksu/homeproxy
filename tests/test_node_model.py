import json,os,pathlib,subprocess,tempfile,unittest
from test_generator import ROOT,UCODE
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
