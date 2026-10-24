"""Exercise the exported model conversion, without invoking a core or updater."""
import json
import pathlib
import subprocess
import tempfile
import unittest
from support import ucode
from support.ucode import UCODE


@unittest.skipUnless(UCODE, 'UCODE required')
class NodeImportTests(unittest.TestCase):
    def convert(self, inputs):
        # importNode does not hash, validate with a core, or write UCI. Fail if
        # that boundary changes, rather than silently pretending a core passed.
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp)
            (path / 'digest.uc').write_text(
                "export function md5(value) { die('Unexpected hashing in model conversion'); };")
            (path / 'input.json').write_text(json.dumps(inputs))
            code = """
import {readfile} from 'fs';
import {importNode} from %s;
printf('%%J', map(json(readfile(%s)), input => {
 try { return {node: importNode(input, tag => 'ref-' + tag)}; }
 catch(e) { return {error: '' + e}; }
}));
""" % (json.dumps(str(ucode.SCRIPTS / 'node_import.uc')),
       json.dumps(str(path / 'input.json')))
            result = subprocess.run([UCODE, '-L', str(path / '*.uc'), '-e', code],
                                    capture_output=True, text=True, timeout=5)
            if result.returncode:
                raise RuntimeError(result.stderr)
            return json.loads(result.stdout)

    def test_network_defaults_arrays_duplicates_and_null(self):
        missing = object()
        cases = [(missing, None), (None, None), ([], None), ('tcp', 'tcp'), ('udp', 'udp'),
                 (['tcp'], 'tcp'), (['udp'], 'udp'), (['tcp', 'udp'], None),
                 (['udp', 'tcp'], None), (['tcp', 'tcp'], 'tcp'),
                 (['udp', 'udp'], 'udp'), (['tcp', 'udp', 'tcp'], None)]
        inputs = [{'type': 'shadowsocks', 'tag': 'fixture',
                   **({} if value is missing else {'network': value})} for value, _ in cases]
        results = self.convert(inputs)
        self.assertEqual(len(results), len(cases))
        for result, (_, expected) in zip(results, cases):
            with self.subTest(result=result):
                self.assertIn('node', result)
                self.assertEqual(result['node'].get('shadowsocks_network'), expected)
                if expected is None:
                    self.assertNotIn('shadowsocks_network', result['node'])

    def test_invalid_network_types_and_entries_are_rejected(self):
        inputs = [{'type': 'shadowsocks', 'tag': 'fixture', 'network': value}
                  for value in ['', 'invalid', ['tcp', 'invalid'], ['tcp', None], True, 1, {}]]
        for result in self.convert(inputs):
            self.assertIn('Invalid Shadowsocks network', result.get('error', ''))

    def test_optional_nulls_and_false_have_distinct_meanings(self):
        result, = self.convert([{'type': 'vless', 'tag': 'fixture', 'detour': None,
            'transport': None, 'bind_interface': None, 'udp_fragment': False,
            'tls': {'enabled': True, 'insecure': False, 'server_name': None, 'alpn': None},
            'multiplex': {'enabled': None, 'protocol': None, 'brutal': None}}])
        self.assertEqual(result, {'node': {'type': 'vless', 'label': 'fixture',
            'source_tag': 'fixture', 'udp_fragment': '0', 'tls': '1', 'tls_insecure': '0'}})

    def test_ordered_lists_are_preserved_and_invalid_entries_fail(self):
        cases = [(None, None), ([], None), ('h2', ['h2']), (['h2', 'http/1.1'], ['h2', 'http/1.1'])]
        results = self.convert([{'type': 'vless', 'tls': {'alpn': value}} for value, _ in cases])
        for result, (_, expected) in zip(results, cases):
            self.assertIn('node', result)
            self.assertEqual(result['node'].get('tls_alpn'), expected)
        invalid = ['', [''], ['h2', ''], ['h2', None], {}]
        for result in self.convert([{'type': 'vless', 'tls': {'alpn': value}} for value in invalid]):
            self.assertIn('error', result)

    def test_host_headers_use_the_same_ordered_model_for_all_transports(self):
        inputs = [{'type': 'vless', 'transport': {'type': transport,
                   'headers': {header: ['example.test:8443', '[2001:db8::1]:443']}}}
                  for transport in ['ws', 'http', 'httpupgrade'] for header in ['Host', 'host']]
        for result in self.convert(inputs):
            self.assertIn('node', result)
            self.assertEqual(result['node']['ws_host'], ['example.test:8443', '[2001:db8::1]:443'])
        result, = self.convert([{'type': 'vless', 'transport': {'type': 'ws',
                                'headers': {'Host': 'example.test', 'X-Unsupported': 'x'}}}])
        self.assertIn('headers other than Host', result.get('error', ''))

    def test_utls_disabled_defaults_and_aliases(self):
        cases = [({}, None), ({'enabled': None}, None), ({'enabled': False}, None),
                 ({'enabled': True}, 'chrome'), ({'enabled': True, 'fingerprint': None}, 'chrome'),
                 ({'enabled': True, 'fingerprint': 'firefox'}, 'firefox')]
        cases += [({'enabled': True, 'fingerprint': value}, 'chrome') for value in
                  ['chrome_psk', 'chrome_psk_shuffle', 'chrome_padding_psk_shuffle', 'chrome_pq', 'chrome_pq_psk']]
        results = self.convert([{'type': 'vless', 'tls': {'utls': value}} for value, _ in cases])
        for result, (_, expected) in zip(results, cases):
            self.assertIn('node', result)
            self.assertEqual(result['node'].get('tls_utls'), expected)

    def test_empty_references_auth_precedence_and_vmess_default(self):
        cases = [({'type': 'socks', 'detour': ''}, {}),
                 ({'type': 'selector', 'default': ''}, {}),
                 ({'type': 'socks', 'detour': 'up'}, {'node_detour': 'ref-up'}),
                 ({'type': 'selector', 'default': 'up'}, {'group_default': 'ref-up'}),
                 ({'type': 'vmess'}, {'vmess_global_padding': '0'}),
                 ({'type': 'hysteria', 'auth': 'YmFzZQ==', 'auth_str': 'plain'},
                  {'hysteria_auth_type': 'string', 'hysteria_auth_payload': 'plain'}),
                 ({'type': 'hysteria', 'auth_str': 'plain', 'auth': 'YmFzZQ=='},
                  {'hysteria_auth_type': 'string', 'hysteria_auth_payload': 'plain'}),
                 ({'type': 'hysteria', 'auth_str': '', 'auth': 'YmFzZQ=='},
                  {'hysteria_auth_type': 'base64', 'hysteria_auth_payload': 'YmFzZQ=='})]
        for result, (input_, expected) in zip(self.convert([c[0] for c in cases]), cases):
            self.assertEqual(result, {'node': {'type': input_['type'], **expected}})

    def test_unrepresentable_fields_fail_instead_of_silently_disappearing(self):
        cases = [({'type': 'socks', 'unknown_field': 'x'}, 'not supported'),
                 ({'type': 'tailscale'}, 'configured locally'),
                 ({'type': 'unsupported'}, 'Unsupported node type'),
                 ({'type': 'socks', 'password': {}}, 'scalar'),
                 ({'type': 'socks', 'domain_resolver': 'remote-dns'}, 'resolver dependency')]
        for result, (_, error) in zip(self.convert([c[0] for c in cases]), cases):
            self.assertIn(error, result.get('error', ''))
