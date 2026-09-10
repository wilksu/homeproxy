"""Exercise ucode parsing and bounded command execution without router writes."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
UCODE = os.environ.get('UCODE', shutil.which('ucode') or '')

@unittest.skipUnless(UCODE, 'UCODE is required')
class RuntimeTests(unittest.TestCase):
 def probe(self, expression):
  with tempfile.TemporaryDirectory() as tmp:
   script = pathlib.Path(tmp) / 'probe.uc'
   source = (ROOT / 'root/usr/share/ucode/homeproxy_runtime.uc').read_text()
   script.write_text(source.replace('export function', 'function') + '\nprint(sprintf("%J", ' + expression + '));')
   p = subprocess.run([UCODE, '-L', str(ROOT / 'tests/support/*.uc'), str(script)], capture_output=True, text=True)
   self.assertEqual(p.returncode, 0, p.stderr)
   return json.loads(p.stdout)

 def test_valid_targets(self):
  for target, host in [('example.com', 'example.com'), ('https://[::1]:443/', '::1'), ('https://example.com/a?token=x', 'example.com')]:
   with self.subTest(target=target):
    self.assertEqual(self.probe('targetParts(' + json.dumps(target) + ')')['host'], host)

 def test_invalid_targets(self):
  for target in ['bad name', 'https://example.com:99999', 'https://user:pass@example.com', 'https://example.com/\n', 'file:///etc/passwd']:
   with self.subTest(target=target):
    self.assertIsNone(self.probe('targetParts(' + json.dumps(target) + ')'))

 def test_command_output_and_timeout(self):
  self.assertEqual(self.probe("execute(['/bin/echo', 'hello'], 1000)"), {'code': 0, 'stdout': 'hello\n', 'stderr': ''})
  self.assertNotEqual(self.probe("execute(['/bin/sleep', '2'], 50)")['code'], 0)
