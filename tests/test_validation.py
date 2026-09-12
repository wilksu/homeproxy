"""Validate startup compatibility checks with fixed, local core metadata."""
import json, os, pathlib, subprocess, tempfile, unittest
from test_generator import ROOT, UCODE

class PairingManifestTests(unittest.TestCase):
 def test_core_release_targets_are_pinned(self):
  pairing=json.loads((ROOT/'root/usr/share/homeproxy/compat.json').read_text())
  self.assertEqual(set(pairing['core_targets']), {
   'aarch64_cortex-a53', 'x86_64', 'aarch64_generic', 'aarch64_cortex-a72'})
  self.assertEqual(pairing['core_targets']['x86_64'], {'goarch':'amd64','tuning':'GOAMD64=v1'})
  for target in ['aarch64_cortex-a53','aarch64_generic','aarch64_cortex-a72']:
   self.assertEqual(pairing['core_targets'][target], {'goarch':'arm64','tuning':'GOARM64=v8.0'})
  recipe=(ROOT/'packages/sing-box/Makefile').read_text()
  tags=recipe.split('GO_PKG_TAGS:=',1)[1].split('\n',1)[0].split(',')
  self.assertEqual(tags, pairing['core_build_tags'][:len(tags)])

@unittest.skipUnless(UCODE, 'UCODE is required')
class ValidationTests(unittest.TestCase):
 def check(self, version, configs):
  with tempfile.TemporaryDirectory() as directory:
   tmp = pathlib.Path(directory)
   core = tmp / 'core'
   core.write_text('#!/bin/sh\nif [ "$1" = version ]; then cat <<\'VERSION\'\n' + version + '\nVERSION\nfi\n')
   core.chmod(0o700)
   script = tmp / 'validate.uc'
   script.write_text((ROOT / 'root/etc/homeproxy/scripts/validate.uc').read_text().replace('/usr/bin/sing-box', str(core)).replace('/usr/share/homeproxy/compat.json', str(ROOT / 'root/usr/share/homeproxy/compat.json')))
   (tmp / 'homeproxy.uc').write_text("export function shellQuote(s) { return \"'\" + replace(s, \"'\", \"'\\\\''\") + \"'\"; }")
   files = []
   for i, config in enumerate(configs):
    f = tmp / f'{i}.json'; f.write_text(json.dumps(config)); files.append(str(f))
   return subprocess.run([UCODE, '-L', str(tmp / '*.uc'), str(script), *files], capture_output=True, text=True)

 def test_wrong_version_is_rejected(self):
  result = self.check('sing-box version 1.12.25', [{}])
  self.assertNotEqual(result.returncode, 0)
  self.assertIn('requires sing-box 1.14.0', result.stderr)

 def test_each_required_build_tag_is_checked(self):
  config = {'outbounds': [{'type': 'hysteria2', 'tag': 'node', 'tls': {'utls': {'enabled': True}}}]}
  result = self.check('sing-box version 1.14.0\nTags: with_utls', [config])
  self.assertNotEqual(result.returncode, 0)
  self.assertIn('lacks with_quic', result.stderr)

 def test_cross_instance_api_port_collision_is_rejected(self):
  result = self.check('sing-box version 1.14.0', [
   {'services': [{'type': 'api', 'tag': 'api', 'listen': '127.0.0.1', 'listen_port': 5334}]},
   {'inbounds': [{'type': 'mixed', 'tag': 'mixed', 'listen': '::', 'listen_port': 5334}]}])
  self.assertNotEqual(result.returncode, 0)
  self.assertIn('conflicts', result.stderr)

 def test_valid_pairing_passes(self):
  result = self.check('sing-box version 1.14.0', [{}])
  self.assertEqual(result.returncode, 0, result.stderr)
