"""Run staging with fake packagers/translators: no package build or compilation."""
import json,os,pathlib,shutil,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class PackageLayoutTests(unittest.TestCase):
 def test_main_and_translation_are_separate(self):
  for manager in ['apk','ipk']:
   with self.subTest(manager=manager),tempfile.TemporaryDirectory() as tmp:
    p=pathlib.Path(tmp);repo=p/'repo';repo.mkdir();(repo/'.github').mkdir()
    for name in ['root','htdocs','po','scripts'] :shutil.copytree(ROOT/name,repo/name)
    for name in ['Makefile','pairing.mk']:shutil.copy(ROOT/name,repo/name)
    shutil.copy(ROOT/'.github/build-ipk.sh',repo/'.github/build-ipk.sh')
    bin=p/'bin';bin.mkdir();capture=p/'capture';capture.mkdir()
    fake='''#!/usr/bin/env python3
import sys,os,pathlib,shutil,json
name=pathlib.Path(sys.argv[0]).name;a=sys.argv[1:];out=pathlib.Path(os.environ['CAPTURE'])
if name=='po2lmo':pathlib.Path(a[1]).write_text('FAKE TRANSLATION');sys.exit()
if name=='apk':
 src=pathlib.Path(a[a.index('--files')+1]);dest=pathlib.Path(a[a.index('--output')+1])
else:
 src=pathlib.Path(a[-2]);control=(src/'CONTROL/control').read_text();fields=dict(x.split(': ',1) for x in control.splitlines() if ': ' in x);dest=pathlib.Path(a[-1])/(fields['Package']+'_'+fields['Version']+'_all.ipk')
shutil.copytree(src,out/src.name);(out/(src.name+'.args')).write_text(json.dumps(a));dest.touch()
'''
    for name in ['apk','ipkg-build','po2lmo']:(bin/name).write_text(fake);(bin/name).chmod(0o755)
    env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'CAPTURE':str(capture)}
    if manager=='apk':
     key=p/'signing.pem';key.write_text('test key')
     env['APK_SIGNING_KEY_FILE']=str(key)
    r=subprocess.run(['bash',str(repo/'.github/build-ipk.sh'),manager,'snapshot'],cwd=ROOT,env=env,capture_output=True,text=True)
    self.assertEqual(r.returncode,0,r.stderr)
    main=capture/'luci-app-homeproxy';lang=capture/'luci-i18n-homeproxy-zh-cn'
    self.assertTrue(main.exists());self.assertTrue(lang.exists())
    self.assertFalse(list(main.rglob('*.lmo')))
    self.assertTrue((lang/'usr/lib/lua/luci/i18n/homeproxy.zh-cn.lmo').exists())
    self.assertFalse((lang/'etc/config/homeproxy').exists())
    self.assertIn('luci.languages.zh_cn',(lang/'etc/uci-defaults/luci-i18n-homeproxy-zh-cn').read_text())
    self.assertEqual(len(list((repo/'.github').glob('*.'+manager))),2)
    if manager=='apk':
     self.assertEqual(len(list((repo/'.github').glob('luci-*-*.apk'))),2)
     args=json.loads((capture/'luci-app-homeproxy.args').read_text())
     self.assertEqual(args[args.index('--sign-key')+1],str(key))
