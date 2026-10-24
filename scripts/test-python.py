#!/usr/bin/env python3
"""Run isolated units, negative controls, integration tests, or all checks."""
import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import unittest


def leaves(suite):
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from leaves(test)
        else:
            yield test


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=['unit', 'guards', 'integration', 'all'], default='all')
    parser.add_argument('-k', metavar='PATTERN', help='Run matching test names (substring or glob)')
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[1]
    os.chdir(root)
    required = ['UCODE'] if args.suite in ['unit', 'guards'] else ['UCODE', 'SING_BOX']
    for key in required:
        if not os.environ.get(key) or not os.access(os.environ[key], os.X_OK):
            parser.error(f'{key} must identify an executable; refusing skipped regression tests')
    if 'SING_BOX' in required:
        for tool in ['curl', 'openssl']:
            if not shutil.which(tool):
                parser.error(f'Missing test prerequisite: {tool}')
        version = subprocess.check_output([os.environ['SING_BOX'], 'version'], text=True).splitlines()[0]
        if version != 'sing-box version 1.14.0':
            parser.error(f'Unexpected test core: {version}')
    subprocess.run([os.environ['UCODE'], '-e',
                    "import {mkstemp} from 'fs'; import {isnan} from 'math'; let f=mkstemp(); f.close();"],
                   check=True, timeout=10)
    loader = unittest.TestLoader()
    if args.k:
        loader.testNamePatterns = [args.k if '*' in args.k else '*' + args.k + '*']
    tests = root / 'tests'
    start = tests / args.suite if args.suite in ['unit', 'guards'] else tests
    suite = loader.discover(str(start), top_level_dir=str(tests))
    if args.suite == 'integration':
        suite = unittest.TestSuite(t for t in leaves(suite)
                                   if not t.id().startswith(('unit.', 'guards.')))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.skipped:
        print('Skipped tests are forbidden:', result.skipped, file=sys.stderr)
    if not result.testsRun:
        print('No tests selected; refusing an empty success', file=sys.stderr)
    return 0 if result.wasSuccessful() and result.testsRun and not result.skipped else 1


if __name__ == '__main__':
    sys.exit(main())
