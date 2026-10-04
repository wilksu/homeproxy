"""Exercise the complete RPC source with an isolated log directory."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
UCODE = os.environ.get('UCODE', shutil.which('ucode') or '')

@unittest.skipUnless(UCODE, 'UCODE is required')
class RpcLogTests(unittest.TestCase):
 def test_clear_existing_missing_and_illegal_log(self):
  with tempfile.TemporaryDirectory() as tmp:
   directory = pathlib.Path(tmp)
   log = directory / 'homeproxy.log'; log.write_text('old log\n')
   untouched = directory / 'other.log'; untouched.write_text('keep\n')
   source = (ROOT / 'root/usr/share/rpcd/ucode/luci.homeproxy').read_text()
   source = source.replace("const RUN_DIR = '/var/run/homeproxy';", 'const RUN_DIR = ' + json.dumps(tmp) + ';')
   for name, success in [('homeproxy', True), ('sing-box-c', True), ('other', False)]:
    with self.subTest(name=name):
     script = directory / 'rpc.uc'
     call = "print(sprintf('%J', methods.log_clean.call({ args: { type: " + json.dumps(name) + " } })));\n"
     script.write_text(source.replace("return { 'luci.homeproxy': methods };", call))
     result = subprocess.run([UCODE, '-L', str(ROOT / 'root/usr/share/ucode/*.uc'), '-L', str(ROOT / 'tests/support/*.uc'), str(script)], capture_output=True, text=True)
     self.assertEqual(result.returncode, 0, result.stderr)
     self.assertEqual(json.loads(result.stdout)['result'], success)
   self.assertEqual(log.read_text(), '')
   self.assertEqual(untouched.read_text(), 'keep\n')
   self.assertFalse((directory / 'sing-box-c.log').exists())
