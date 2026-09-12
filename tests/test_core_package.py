"""Validate standalone core APK metadata without compiling sing-box."""
import json, os, pathlib, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class CorePackageTests(unittest.TestCase):
 def test_signed_package_contains_only_core_and_metadata(self):
  with tempfile.TemporaryDirectory() as directory:
   tmp=pathlib.Path(directory); payload=tmp/'payload'; output=tmp/'output'; tools=tmp/'bin'
   (payload/'usr/bin').mkdir(parents=True); output.mkdir(); tools.mkdir()
   binary=payload/'usr/bin/sing-box'; binary.write_text('binary'); binary.chmod(0o755)
   key=tmp/'key.pem'; key.write_text('key')
   capture=tmp/'args.json'
   apk=tools/'apk'; apk.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys
args=sys.argv[1:]
pathlib.Path(os.environ['CAPTURE']).write_text(json.dumps(args))
pathlib.Path(args[args.index('--output')+1]).touch()
'''); apk.chmod(0o755)
   env={**os.environ,'PATH':str(tools)+':'+os.environ['PATH'],
        'APK_SIGNING_KEY_FILE':str(key),'CAPTURE':str(capture)}
   result=subprocess.run([str(ROOT/'scripts/build-core-package.sh'),str(payload),
                          'aarch64_cortex-a53','1.14.0-r1',str(output)],
                         env=env,capture_output=True,text=True)
   self.assertEqual(result.returncode,0,result.stderr)
   self.assertTrue((output/'sing-box-1.14.0-r1-aarch64_cortex-a53.apk').exists())
   args=json.loads(capture.read_text())
   info=[args[i+1] for i,value in enumerate(args) if value=='--info']
   self.assertIn('name:sing-box',info)
   self.assertIn('version:1.14.0-r1',info)
   self.assertIn('arch:aarch64_cortex-a53',info)
   self.assertIn('depends:ca-bundle kmod-inet-diag kmod-netlink-diag kmod-tun libc',info)
   self.assertEqual(args[args.index('--sign-key')+1],str(key))
   files=set((payload/'lib/apk/packages/sing-box.list').read_text().splitlines())
   self.assertEqual(files,{'/usr/bin/sing-box','/lib/apk/packages/sing-box.list',
                           '/lib/apk/packages/sing-box.rusers'})
