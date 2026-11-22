"""Exercise legacy node migration with isolated configuration records."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_generator import BASE, ROOT, UCODE


@unittest.skipUnless(UCODE, 'ucode is required')
class NodeMigrationTests(unittest.TestCase):
    def migrate(self, config):
        with tempfile.TemporaryDirectory() as work:
            source = Path(work) / 'source.json'
            output = Path(work) / 'migrated.json'
            source.write_text(json.dumps(config))
            scripts = ROOT / 'root/etc/homeproxy/scripts'
            result = subprocess.run(
                [UCODE, '-L', str(ROOT / 'tests/support/*.uc'), '-L', str(scripts / '*.uc'),
                 str(scripts / 'migrate_config.uc')],
                env={**os.environ, 'HP_TEST_UCI': str(source), 'HP_TEST_UCI_SAVE': str(output)},
                capture_output=True, text=True, timeout=10,
            )
            return result, json.loads(output.read_text()) if output.exists() else None

    def fixture(self):
        config = copy.deepcopy(BASE)
        config['migration'] = {'.type': 'homeproxy', 'crontab': '1'}
        config['source'] = {'.type': 'subscription_source', 'url': 'https://fixture.invalid/feed#name'}
        config['node1'].update(
            source_id='source', source_tag='Base', grouphash='previous',
            node_detour='upstream', local_detour='_direct', local_bind_interface='eth0',
        )
        config['upstream'] = {'.type': 'node', 'type': 'socks', 'address': '192.0.2.2', 'port': '1080'}
        config['alias1'] = {'.type': 'node', 'label': 'Alias', 'node_mode': 'reference', 'node_base': 'node1'}
        config['alias2'] = {'.type': 'node', 'label': 'Nested', 'node_mode': 'reference',
                            'node_base': 'alias1', 'local_detour': 'upstream'}
        config['legacy_route'] = {'.type': 'routing_node', 'enabled': '1', 'node': 'alias2', 'outbound': 'direct-out'}
        config['legacy_auto'] = {'.type': 'routing_node', 'enabled': '1', 'node': 'urltest',
                                 'urltest_nodes': ['alias2', 'alias1'], 'urltest_interval': '180'}
        config['routing']['default_outbound'] = 'legacy_route'
        return config

    def test_preserves_stable_ids_overrides_groups_and_source_metadata(self):
        result, migrated = self.migrate(self.fixture())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('source', migrated)
        self.assertEqual(migrated['node1']['grouphash'], hashlib.md5(b'https://fixture.invalid/feed').hexdigest())
        self.assertEqual(json.loads(migrated['node1']['source_dial_options']), {'node_detour': 'upstream'})
        self.assertNotIn('node_detour', migrated['node1'])
        self.assertEqual(migrated['alias1']['node_bind_interface'], 'eth0')
        self.assertNotIn('grouphash', migrated['alias1'])
        self.assertEqual(migrated['alias2']['node_detour'], 'upstream')
        self.assertEqual(migrated['routing']['default_outbound'], 'legacy_route')
        self.assertEqual(migrated['legacy_route']['.type'], 'node')
        self.assertEqual(migrated['legacy_route']['address'], '192.0.2.1')
        self.assertNotIn('node_detour', migrated['legacy_route'])
        self.assertEqual(migrated['legacy_auto']['group_nodes'], ['alias2', 'alias1'])
        self.assertEqual(migrated['legacy_auto']['group_interval'], '180')
        result, repeated = self.migrate(migrated)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(repeated, migrated)

    def test_unresolvable_legacy_references_never_commit(self):
        for base in ('missing', 'alias2'):
            with self.subTest(base=base):
                config = self.fixture()
                config['alias1']['node_base'] = base
                result, migrated = self.migrate(config)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Cannot migrate node reference', result.stderr)
                self.assertIsNone(migrated)
