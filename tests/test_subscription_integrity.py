"""Run the complete staged updater: incomplete output must never reconcile nodes."""
import base64, hashlib, json, os, pathlib, subprocess, tempfile, unittest
from test_generator import ROOT, UCODE
import test_share_links as share

LIMIT=512*1024
URL='https://fixture.invalid/subscription'
SOURCE='src_fixture'

@unittest.skipUnless(UCODE,'UCODE required')
class SubscriptionIntegrityTests(unittest.TestCase):
 def update(self, label_size=1000, encoded=False, trailer=True, status=0):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp);mods=share.modules(path)
   helper=mods/'homeproxy.uc';helper.write_text(helper.read_text().replace('/var/run/homeproxy',str(path/'run')))
   labels=['fixture-%04d-'%i+'x'*label_size for i in range(600)]
   hashes={URL:hashlib.md5(URL.encode()).hexdigest()}
   config={'config':{'.type':'homeproxy','routing_mode':'custom'},
    'subscription':{'.type':'homeproxy','subscription_url':[URL]},
    SOURCE:{'.type':'subscription_source','url':URL}}
   for label in labels:
    identity=SOURCE+'\n'+label;digest=hashlib.md5(identity.encode()).hexdigest();hashes[identity]=digest
    config['n'+digest]={'.type':'node','type':'socks','address':'192.0.2.1','port':'1080',
     'socks_version':'5','label':label,'source_id':SOURCE,'grouphash':hashes[URL],'node_id':'n'+digest}
   (mods/'digest.uc').write_text('const hashes='+json.dumps(hashes)+';export function md5(value){return hashes[value];};')
   original=path/'config.json';original.write_text(json.dumps(config));saved=path/'saved.json'
   selected=labels[:-1]
   body='\n'.join('socks://192.0.2.1:1080#'+label for label in selected)+'\n'
   if encoded:body=base64.b64encode(body.encode()).decode()
   output=body+ ('\n200' if trailer else '')
   feed=path/'feed';feed.write_text(output)
   curl=path/'curl';curl.write_text('#!/bin/sh\ncat '+str(feed)+'\nexit '+str(status)+'\n');curl.chmod(0o755)
   script=path/'update.uc';script.write_text((ROOT/'root/etc/homeproxy/scripts/update_subscriptions.uc').read_text().replace('/usr/bin/curl',str(curl)))
   result=subprocess.run([UCODE,'-L',str(mods/'*.uc'),'-L',str(ROOT/'tests/support/*.uc'),
    '-L',str(ROOT/'root/etc/homeproxy/scripts/*.uc'),str(script)],capture_output=True,text=True,timeout=20,
    env={**os.environ,'HP_SUBSCRIPTION_STAGED':'1','HP_TEST_UCI':str(original),'HP_TEST_UCI_SAVE':str(saved)})
   self.assertEqual(result.stderr,'',result.stderr)
   after=json.loads(saved.read_text()) if saved.exists() else json.loads(original.read_text())
   log=(path/'run/homeproxy.log').read_text()
   return result.returncode,config,after,log,len(output.encode()),saved.exists()

 def test_command_output_boundary_never_returns_a_partial_prefix(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp)
   for length in [LIMIT-1,LIMIT,LIMIT+1]:
    with self.subTest(length=length):
     feed=path/'feed';feed.write_text('x'*length)
     code="import{executeCommand,shellQuote}from'homeproxy';let r=executeCommand('cat '+shellQuote("+json.dumps(str(feed))+"));print(sprintf('%J',{length:r.stdout===null?null:length(r.stdout),truncated:r.truncated,exitcode:r.exitcode}));"
     p=subprocess.run([UCODE,'-L',str(ROOT/'tests/support/*.uc'),'-L',str(ROOT/'root/etc/homeproxy/scripts/*.uc'),'-e',code],capture_output=True,text=True)
     self.assertEqual(p.returncode,0,p.stderr)
     self.assertEqual(json.loads(p.stdout),{'length':length if length<=LIMIT else None,'truncated':length>LIMIT,'exitcode':0})

 def test_oversized_plain_subscription_preserves_all_old_nodes(self):
  status,before,after,log,size,committed=self.update()
  self.assertGreater(size,LIMIT);self.assertEqual(status,1)
  self.assertEqual(after,before);self.assertFalse(committed)
  self.assertIn('512 KiB output limit',log)

 def test_oversized_base64_subscription_preserves_all_old_nodes(self):
  status,before,after,log,size,committed=self.update(label_size=740,encoded=True)
  self.assertGreater(size,LIMIT);self.assertEqual(status,1)
  self.assertEqual(after,before);self.assertFalse(committed)
  self.assertIn('512 KiB output limit',log)

 def test_incomplete_transfer_and_missing_http_status_preserve_nodes(self):
  for trailer,exitcode in [(False,0),(True,18)]:
   with self.subTest(trailer=trailer,exitcode=exitcode):
    status,before,after,log,size,committed=self.update(label_size=20,trailer=trailer,status=exitcode)
    self.assertLess(size,LIMIT);self.assertEqual(status,1)
    self.assertEqual(after,before);self.assertFalse(committed)
    self.assertIn('Failed to fetch subscription',log)

 def test_complete_plain_and_base64_feeds_update_and_remove_only_stale_node(self):
  for encoded in [False,True]:
   with self.subTest(encoded=encoded):
    status,before,after,log,size,committed=self.update(label_size=20,encoded=encoded)
    self.assertEqual(status,0,log);self.assertTrue(committed)
    old={k for k,v in before.items() if v['.type']=='node'}
    fresh={k for k,v in after.items() if v['.type']=='node'}
    self.assertEqual(len(fresh),599);self.assertEqual(len(old-fresh),1)
    self.assertEqual(fresh-old,set())
