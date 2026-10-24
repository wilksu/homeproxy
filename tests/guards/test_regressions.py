"""Temporary mutants must fail an existing behavior assertion, not crash or skip."""
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from support import ucode
from unit import test_command_output, test_node_import, test_share_links


# name, module, exact single replacement, existing behavior assertion
MUTATIONS = [
    ('unknown-ss-method', 'share_links.uc',
     "if (config.type === 'shadowsocks' && !(config.shadowsocks_encrypt_method in shadowsocksMethods))",
     'if (false)', test_share_links.ShareLinkTests,
     'test_invalid_shadowsocks_methods_are_rejected_in_every_encoding'),
    ('https-default-port', 'share_links.uc',
     "parseURL(uri[0] + '://' + uri[1])", "parseURL('http://' + uri[1])",
     test_share_links.ShareLinkTests, 'test_default_ports_and_explicit_overrides'),
    ('nested-scheme-delimiter', 'share_links.uc',
     "split(trim(uri), '://', 2)", "split(trim(uri), '://')",
     test_share_links.ShareLinkTests, 'test_nested_delimiters_and_percent_sequences_are_decoded_once'),
    ('insecure-string-truthiness', 'share_links.uc',
     "(params.insecure in ['true', '1'])", '(!!params.insecure)',
     test_share_links.ShareLinkTests, 'test_insecure_values_match_across_rpc_and_subscription_parser'),
    ('raw-base64-password-percent', 'share_links.uc',
     'urlencode(parts[2])', 'urlencode(urldecode(parts[2]))',
     test_share_links.ShareLinkTests, 'test_generated_shadowsocks_encodings_preserve_original_values'),
    ('base64-label-double-encoding', 'share_links.uc',
     "'#' + ss_suri[1]", "'#' + urlencode(ss_suri[1])",
     test_share_links.ShareLinkTests, 'test_generated_shadowsocks_encodings_preserve_original_values'),
    ('network-array-stored-verbatim', 'node_import.uc',
     'n.shadowsocks_network=network(v)', 'n.shadowsocks_network=value(v)',
     test_node_import.NodeImportTests, 'test_network_defaults_arrays_duplicates_and_null'),
    ('null-no-longer-unset', 'node_import.uc',
     'filter(keys(object || {}), key=>object[key]!==null)', 'keys(object || {})',
     test_node_import.NodeImportTests, 'test_network_defaults_arrays_duplicates_and_null'),
    ('truncated-output-accepted', 'homeproxy.uc',
     'outfd.read(limit + 1)', 'outfd.read(limit)',
     test_command_output.CommandOutputTests, 'test_command_output_boundary_never_returns_a_partial_prefix'),
]


@unittest.skipUnless(ucode.UCODE, 'UCODE required')
class RegressionGuardTests(unittest.TestCase):
    def test_removed_guards_are_detected_by_behavior_assertions(self):
        for name, filename, before, after, case, method in MUTATIONS:
            with self.subTest(guard=name), tempfile.TemporaryDirectory() as tmp:
                baseline = unittest.TestResult()
                case(method).run(baseline)
                self.assertTrue(baseline.wasSuccessful(), (baseline.failures, baseline.errors))
                self.assertEqual((baseline.testsRun, baseline.skipped), (1, []))
                directory = pathlib.Path(tmp)
                for source in ucode.SCRIPTS.glob('*.uc'):
                    shutil.copy(source, directory / source.name)
                (directory / 'digest.uc').write_text(
                    "export function md5(value) { die('Unexpected hashing in model conversion'); };")
                target = directory / filename
                source = target.read_text()
                if name == 'insecure-string-truthiness':
                    # Mutate Hy2 only; the other protocols keep their guards.
                    start = source.index("case 'hysteria2':")
                    end = source.index("\n\t\tcase 'socks':", start)
                    block = source[start:end]
                    self.assertEqual(block.count(before), 1)
                    mutated = source[:start] + block.replace(before, after) + source[end:]
                else:
                    self.assertNotEqual(before, after)
                    self.assertEqual(source.count(before), 1, f'{name}: update the mutation anchor')
                    mutated = source.replace(before, after)
                self.assertNotEqual(mutated, source)
                target.write_text(mutated)
                # Compile first: broken syntax or imports cannot count as a
                # successful control through a process-status assertion.
                compiled = subprocess.run([ucode.UCODE, '-L', str(directory / '*.uc'),
                    '-L', str(ucode.ROOT / 'tests/support/*.uc'), '-c', '-o', str(directory / 'probe.ucb'),
                    '-e', 'import * as subject from ' + json.dumps(str(target)) + ';'],
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(compiled.returncode, 0, compiled.stderr)
                result = unittest.TestResult()
                with patch.object(ucode, 'SCRIPTS', directory):
                    case(method).run(result)
                self.assertEqual(result.testsRun, 1)
                self.assertFalse(result.errors, result.errors)
                self.assertFalse(result.skipped, result.skipped)
                self.assertTrue(result.failures, f'{name}: regression survived its test')
