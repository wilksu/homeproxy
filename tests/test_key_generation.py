"""Run the RPC key generator with the paired real core, including empty parameters."""
import json, os, pathlib, shutil, subprocess, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
UCODE=os.environ.get('UCODE',shutil.which('ucode') or '')
CORE=os.environ.get('SING_BOX',shutil.which('sing-box') or '')
@unittest.skipUnless(UCODE and CORE,'UCODE and SING_BOX are required')
class KeyGenerationTests(unittest.TestCase):
 def generate(self,kind,params=''):
  s=(ROOT/'root/usr/share/rpcd/ucode/luci.homeproxy').read_text()
  a=s.index('if (!(req.args?.type',s.index('singbox_generator:'))
  b=s.index('\n\t\t}\n\t},\n\n\tsingbox_get_features:',a)
  quote=s[s.index('function shellquote'):s.index('\nfunction hasKernelModule')]
  script="import {popen} from 'fs';"+quote+"function run(req){"+s[a:b].replace('/usr/bin/sing-box',CORE)+"}; print(sprintf('%J',run("+json.dumps({'args':{'type':kind,'params':params}})+")));"
  p=subprocess.run([UCODE,'-e',script],capture_output=True,text=True)
  self.assertEqual(p.returncode,0,p.stderr)
  return json.loads(p.stdout)
 def test_parameterless_generators(self):
  for kind in ['reality-keypair','wg-keypair','vapid-keypair']:
   with self.subTest(kind=kind):
    result=self.generate(kind)['result'];self.assertTrue(result['private_key']);self.assertTrue(result['public_key'])
  self.assertRegex(self.generate('uuid')['result']['uuid'],r'^[0-9a-f-]{36}$')
 def test_ech_and_failure(self):
  result=self.generate('ech-keypair','qa.local')['result'];self.assertIn('BEGIN ECH CONFIGS',result['ech_cfg']);self.assertIn('BEGIN ECH KEYS',result['ech_key'])
  self.assertFalse(self.generate('reality-keypair','unexpected')['result'])
  self.assertFalse(self.generate('invalid')['result'])
