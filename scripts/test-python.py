#!/usr/bin/env python3
"""CI entry point: missing prerequisites or skipped tests are failures."""
import os,pathlib,shutil,subprocess,sys,unittest
root=pathlib.Path(__file__).resolve().parents[1]
os.chdir(root)
for key in ['UCODE','SING_BOX']:
 if not os.environ.get(key) or not os.access(os.environ[key],os.X_OK):
  sys.exit(f'{key} must identify an executable; refusing skipped regression tests')
for tool in ['curl','openssl']:
 if not shutil.which(tool):sys.exit(f'Missing test prerequisite: {tool}')
version=subprocess.check_output([os.environ['SING_BOX'],'version'],text=True).splitlines()[0]
if version!='sing-box version 1.14.0':sys.exit(f'Unexpected test core: {version}')
subprocess.run([os.environ['UCODE'],'-e',"import {mkstemp} from 'fs'; import {isnan} from 'math'; let f=mkstemp(); f.close();"],check=True)
suite=unittest.defaultTestLoader.discover(str(root/'tests'))
result=unittest.TextTestRunner(verbosity=2).run(suite)
if result.skipped:
 print('Skipped tests are forbidden in CI:',result.skipped,file=sys.stderr)
sys.exit(0 if result.wasSuccessful() and result.testsRun and not result.skipped else 1)
