"""Exercise ucode runtime helpers and Clash API validation without router writes."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
UCODE = os.environ.get('UCODE', shutil.which('ucode') or '')

@unittest.skipUnless(UCODE, 'UCODE is required')
class RuntimeTests(unittest.TestCase):
 def probe(self, expression, run_dir=None):
  with tempfile.TemporaryDirectory() as tmp:
   script = pathlib.Path(tmp) / 'probe.uc'
   source = (ROOT / 'root/usr/share/ucode/homeproxy_runtime.uc').read_text()
   if run_dir is not None:
    source = source.replace("const RUN_DIR = '/var/run/homeproxy';", 'const RUN_DIR = ' + json.dumps(str(run_dir)) + ';')
   script.write_text(source.replace('export function', 'function') + '\nprint(sprintf("%J", ' + expression + '));')
   p = subprocess.run([UCODE, '-L', str(ROOT / 'tests/support/*.uc'), str(script)], capture_output=True, text=True)
   self.assertEqual(p.returncode, 0, p.stderr)
   return json.loads(p.stdout)

 def test_command_output_and_timeout(self):
  self.assertEqual(self.probe("execute(['/bin/echo', 'hello'], 1000)"), {'code': 0, 'stdout': 'hello\n', 'stderr': ''})
  self.assertNotEqual(self.probe("execute(['/bin/sleep', '2'], 50)")['code'], 0)

 def test_command_with_many_open_descriptors(self):
  result = self.probe("(function() { const held = map([0,1,2,3,4,5,6,7,8,9,10,11], () => mkstemp()); const result = execute(['/bin/sh', '-c', 'printf output; printf error >&2; exit 17'], 1000); for (let file in held) file.close(); return result; })()")
  self.assertEqual(result, {'code': 17, 'stdout': 'output', 'stderr': 'error'})

 def test_api_validation_and_error_guards(self):
  with tempfile.TemporaryDirectory() as run:
   run_path = pathlib.Path(run)
   self.assertEqual(self.probe("apiRead('bogus', 'snapshot')", run_path), {'error': 'Invalid instance'})
   self.assertEqual(self.probe("apiRead('client', 'snapshot')", run_path), {'error': 'No running configuration'})
   (run_path / 'sing-box-c.json').write_text(json.dumps({'experimental': {}}))
   self.assertEqual(self.probe("apiRead('client', 'snapshot')", run_path), {'error': 'Clash API is disabled'})
   (run_path / 'sing-box-c.json').write_text(json.dumps({'experimental': {'clash_api': {'external_controller': '127.0.0.1:5334'}}}))
   self.assertEqual(self.probe("apiRead('client', 'bogus')", run_path), {'error': 'Unknown API resource'})
   self.assertEqual(self.probe("apiControl('client', 'bogus', '', '')", run_path), {'error': 'Unknown API action'})
   self.assertEqual(self.probe("apiControl('client', 'select', '', '')", run_path), {'error': 'Group and outbound name required'})
   self.assertEqual(self.probe("apiControl('client', 'delay', '', '')", run_path), {'error': 'Proxy or group name required'})
   self.assertEqual(self.probe("apiControl('client', 'close', '', '')", run_path), {'error': 'Connection ID required'})

 def test_log_reads_are_restricted_to_the_most_recent_complete_lines(self):
  with tempfile.TemporaryDirectory() as run:
   run_path = pathlib.Path(run)
   self.assertEqual(self.probe("readLog('../other')", run_path), {'error': 'Illegal log type'})
   self.assertEqual(self.probe("readLog('sing-box-c')", run_path), {'missing': True})
   log = run_path / 'sing-box-c.log'
   log.write_text('short log\n')
   self.assertEqual(self.probe("readLog('sing-box-c')", run_path), {'text': 'short log\n'})
   line = '线路日志 ' + 'x' * 200 + '\n'
   log.write_text('old log\n' + line * 1600 + '最后一行\n')
   text = self.probe("readLog('sing-box-c')", run_path)['text']
   self.assertLessEqual(len(text.encode()), 262144)
   self.assertTrue(text.startswith(line))
   self.assertTrue(text.endswith('最后一行\n'))
   self.assertNotIn('old log', text)
