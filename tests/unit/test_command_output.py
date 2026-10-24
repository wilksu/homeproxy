"""The output capture contract uses temporary files and harmless child commands."""
import json, pathlib, subprocess, tempfile, unittest
from support import ucode
from support.ucode import ROOT, UCODE
LIMIT=512*1024

@unittest.skipUnless(UCODE, 'UCODE required')
class CommandOutputTests(unittest.TestCase):
 def test_command_output_boundary_never_returns_a_partial_prefix(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp)
   for length in [LIMIT-1,LIMIT,LIMIT+1]:
    with self.subTest(length=length):
     feed=path/'feed';feed.write_text('x'*length)
     code="import{mkstemp}from'fs';import{executeCommand,shellQuote}from'homeproxy';const held=map([1,2,3,4,5,6,7,8,9,10,11,12],()=>mkstemp());let r=executeCommand('cat '+shellQuote("+json.dumps(str(feed))+"));print(sprintf('%J',{length:r.stdout===null?null:length(r.stdout),truncated:r.truncated,exitcode:r.exitcode}));"
     p=subprocess.run([UCODE,'-L',str(ROOT/'tests/support/*.uc'),'-L',str(ucode.SCRIPTS/'*.uc'),'-e',code],capture_output=True,text=True,timeout=5)
     if p.returncode: raise RuntimeError(p.stderr)
     self.assertEqual(json.loads(p.stdout),{'length':length if length<=LIMIT else None,'truncated':length>LIMIT,'exitcode':0})
