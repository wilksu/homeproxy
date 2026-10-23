"""Import native subscriptions with the paired core, then validate generated UCI nodes."""
import copy, hashlib, json, os, pathlib, subprocess, tempfile, unittest
from test_generator import ROOT, UCODE, CORE, BASE
import test_generator as generator


@unittest.skipUnless(UCODE and CORE, 'UCODE and SING_BOX are required')
class SubscriptionImportTests(unittest.TestCase):
 def proxy(self, protocol='shadowsocks', **options):
  node = {'type':protocol, 'tag':'proxy', 'server':'192.0.2.1', 'server_port':443}
  if protocol == 'shadowsocks': node.update(method='aes-128-gcm', password='fixture')
  if protocol in ['anytls', 'hysteria', 'hysteria2', 'shadowtls', 'tuic']:
   node['tls'] = {'enabled':True, 'server_name':'example.test'}
  if protocol in ['vless', 'vmess', 'tuic']: node['uuid'] = '00000000-0000-4000-8000-000000000001'
  node.update(options)
  return node

 def roundtrip(self, document):
  result = self.invoke(document)
  self.assertNotIn('error', result)
  nodes = result['result']
  config = copy.deepcopy(BASE); config.pop('node1'); config.pop('route1')
  for node in nodes:
   config[node['node_id']] = {**node, '.type':'node', '.name':node['node_id']}
  config['config']['main_node'] = nodes[0]['node_id']
  generated = generator.GeneratorTests().generate(config)
  return nodes, generated['outbounds']

 def invoke(self, document, parse=False):
  with tempfile.TemporaryDirectory() as tmp:
   directory = pathlib.Path(tmp)
   source = 'fixture-source'
   tags = [node.get('tag', '') for node in document.get('outbounds', [])] if isinstance(document, dict) else []
   hashes = {value: hashlib.md5(value.encode()).hexdigest() for value in [source, *[source+'\n'+tag for tag in tags]]}
   # CI ucode has no digest module; hashing is not the behavior under test.
   (directory/'digest.uc').write_text('export function md5(value) { return '+json.dumps(hashes)+'[value]; };')
   (directory/'input').write_text(document if parse else json.dumps(document))
   expression = 'subscriptionDocument(readfile('+json.dumps(str(directory/'input'))+'))' if parse else 'importNodes(json(readfile('+json.dumps(str(directory/'input'))+')), '+json.dumps(source)+')'
   script = "import {readfile} from 'fs'; import {importNodes,subscriptionDocument} from "+json.dumps(str(ROOT/'root/etc/homeproxy/scripts/node_import.uc'))+"; try {print(sprintf('%J',{result:"+expression+"}));} catch(e) {print(sprintf('%J',{error:''+e}));}"
   result = subprocess.run([UCODE, '-L', str(directory/'*.uc'), '-e', script], capture_output=True, text=True,
    env={**os.environ, 'HP_OUTPUT_DIR':tmp, 'PATH':str(pathlib.Path(CORE).parent)+os.pathsep+os.environ['PATH']})
   self.assertEqual(result.returncode, 0, result.stderr)
   return json.loads(result.stdout)

 def test_shadowsocks_network_survives_import_and_generation(self):
  missing = object()
  cases = [(missing, None), (None, None), ([], None), ('tcp', 'tcp'), ('udp', 'udp'),
   (['tcp'], 'tcp'), (['udp'], 'udp'), (['tcp','udp'], None), (['udp','tcp'], None),
   (['tcp','tcp'], 'tcp'), (['udp','udp'], 'udp'), (['tcp','udp','tcp'], None)]
  for network, expected in cases:
   with self.subTest(network=network):
    proxy = {'type':'shadowsocks', 'tag':'ss', 'server':'192.0.2.1', 'server_port':443,
     'method':'chacha20-ietf-poly1305', 'password':'fixture', 'plugin':'obfs-local',
     'plugin_opts':'obfs=http;obfs-host=example.test', 'udp_over_tcp':False}
    if network is not missing: proxy['network'] = network
    document = {'outbounds':[
     {'type':'selector', 'tag':'choose', 'outbounds':['automatic','direct'], 'default':'automatic'},
     {'type':'urltest', 'tag':'automatic', 'outbounds':['ss','anytls'], 'interval':'5m'},
     proxy,
     {'type':'anytls', 'tag':'anytls', 'server':'192.0.2.2', 'server_port':443, 'password':'fixture',
      'tls':{'enabled':True, 'server_name':'example.test', 'insecure':False, 'alpn':['h2','http/1.1']}},
     {'type':'direct', 'tag':'direct'}]}
    nodes, outbounds = self.roundtrip(document)
    self.assertEqual(len(nodes), 5)
    ss = next(node for node in nodes if node['type']=='shadowsocks')
    self.assertEqual(ss.get('shadowsocks_network'), expected)
    outbound = next(node for node in outbounds if node['type']=='shadowsocks')
    self.assertEqual(outbound.get('network'), expected)
    self.assertEqual(outbound['plugin_opts'], proxy['plugin_opts'])
    self.assertEqual(outbound['password'], 'fixture')

 def test_invalid_network_is_rejected(self):
  for network in ['invalid', '', ['tcp','invalid'], ['tcp',None], True, {}]:
   with self.subTest(network=network):
    result = self.invoke({'outbounds':[self.proxy(network=network)]})
    self.assertIn('error', result)

 def test_optional_nulls_do_not_become_strings(self):
  node = self.proxy('vless', detour=None, bind_interface=None, transport=None,
   multiplex={'enabled':None, 'protocol':None, 'brutal':None},
   tls={'enabled':True, 'server_name':None, 'alpn':None, 'min_version':None, 'max_version':None,
    'utls':None, 'ech':None, 'reality':None})
  nodes, outbounds = self.roundtrip({'outbounds':[node]})
  self.assertNotIn('null', json.dumps(nodes))
  self.assertEqual(next(o for o in outbounds if o['type']=='vless')['tls'], {'enabled':True})
  # Null must not bypass unknown-field validation by the paired core.
  self.assertIn('error', self.invoke({'outbounds':[self.proxy(unknown_option=None)]}))

 def test_utls_defaults_and_core_aliases_preserve_meaning(self):
  for options, expected in [({}, None), ({'enabled':None}, None), ({'enabled':False}, None),
   ({'enabled':True,'fingerprint':None}, 'chrome'), ({'enabled':True}, 'chrome'),
   *[({'enabled':True,'fingerprint':f}, 'chrome') for f in
    ['chrome_psk','chrome_psk_shuffle','chrome_padding_psk_shuffle','chrome_pq','chrome_pq_psk']]]:
   with self.subTest(options=options):
    _, outbounds = self.roundtrip({'outbounds':[self.proxy('vless',
     tls={'enabled':True,'server_name':'example.test','utls':options})]})
    tls = next(o for o in outbounds if o['type']=='vless')['tls']
    self.assertEqual(tls.get('utls'), {'enabled':True,'fingerprint':expected} if expected else None)

 def test_transport_host_headers_remain_lists(self):
  for transport in ['ws','http','httpupgrade']:
   for header in ['Host','host']:
    for host in [None, [], 'example.test', ['example.test'], ['first.test','second.test']]:
     with self.subTest(transport=transport, header=header, host=host):
      nodes, outbounds = self.roundtrip({'outbounds':[self.proxy('vless',
       transport={'type':transport,'path':'/fixture','headers':{header:host}})]})
      expected = (host if isinstance(host,list) else [host]) if host else None
      self.assertEqual(nodes[0].get('ws_host'), expected)
      value = next(o for o in outbounds if o['type']=='vless')['transport']
      self.assertEqual(value.get('headers',{}).get('Host'), expected)

 def test_normalization_does_not_bypass_native_validation(self):
  for node in [self.proxy(unknown_option=None), self.proxy(routing_mark=None),
   self.proxy('vless', tls={'enabled':True, 'handshake_timeout':None})]:
   with self.subTest(node=node):
    self.assertIn('core validation', self.invoke({'outbounds':[node]})['error'])

 def test_list_fields_are_canonical_and_do_not_silently_drop_items(self):
  for alpn, expected in [('h2',['h2']), (['h2','http/1.1'],['h2','http/1.1']), ([],None), (None,None)]:
   with self.subTest(alpn=alpn):
    nodes, outbounds = self.roundtrip({'outbounds':[self.proxy('vless',tls={'enabled':True,'alpn':alpn})]})
    self.assertEqual(nodes[0].get('tls_alpn'), expected)
    self.assertEqual(next(o for o in outbounds if o['type']=='vless')['tls'].get('alpn'), expected)
  for alpn in ['', [''], ['h2',''], ['h2',None]]:
   with self.subTest(alpn=alpn):
    self.assertIn('list', self.invoke({'outbounds':[self.proxy('vless',tls={'enabled':True,'alpn':alpn})]})['error'])

 def test_false_udp_fragment_is_preserved(self):
  for protocol in ['direct','hysteria2','tuic']:
   with self.subTest(protocol=protocol):
    node = self.proxy(protocol, udp_fragment=False)
    if protocol == 'direct': node = {'type':'direct','tag':'proxy','udp_fragment':False}
    _, outbounds = self.roundtrip({'outbounds':[node]})
    self.assertIs(next(o for o in outbounds if o['tag']=='main-out')['udp_fragment'], False)

 def test_vmess_padding_default_matches_native_core(self):
  nodes, outbounds = self.roundtrip({'outbounds':[self.proxy('vmess')]})
  self.assertEqual(nodes[0]['vmess_global_padding'], '0')
  self.assertFalse(next(o for o in outbounds if o['type']=='vmess').get('global_padding',False))

 def test_hysteria_obfuscation_is_not_dropped(self):
  _, outbounds = self.roundtrip({'outbounds':[self.proxy('hysteria',
   obfs='fixture-obfs', auth_str='fixture-auth', up_mbps=10, down_mbps=10)]})
  node = next(o for o in outbounds if o['type']=='hysteria')
  self.assertEqual(node['obfs'], 'fixture-obfs')
  self.assertEqual(node['auth_str'], 'fixture-auth')

 def test_protocol_options_survive_import_and_generation(self):
  cases = [
   self.proxy('http', username='fixture', password='fixture'),
   self.proxy('socks', version='4a', username='fixture', password='fixture'),
   self.proxy('shadowtls', version=3, password='fixture'),
   self.proxy('ssh', user='fixture', password='fixture', client_version='SSH-2.0-fixture',
    host_key_algorithms=['ssh-ed25519','rsa-sha2-256']),
   self.proxy('anytls', password='fixture', idle_session_check_interval='30s',
    idle_session_timeout='60s', min_idle_session=2),
   self.proxy('hysteria2', password='fixture', up_mbps=10, down_mbps=20,
    bbr_profile='conservative', obfs={'type':'gecko','password':'fixture','min_packet_size':100,'max_packet_size':200}),
   self.proxy('trojan', password='fixture', tls={'enabled':True,'server_name':'example.test'}),
   self.proxy('tuic', password='fixture', congestion_control='bbr', udp_relay_mode='quic', heartbeat='10s'),
   self.proxy('vless', packet_encoding='xudp', transport={'type':'grpc','service_name':'fixture',
    'idle_timeout':'30s','ping_timeout':'10s','permit_without_stream':True}),
   self.proxy('vmess', security='aes-128-gcm', alter_id=2, global_padding=False, authenticated_length=True,
    multiplex={'enabled':True,'protocol':'yamux','max_connections':2,'padding':True}),
  ]
  for node in cases:
   with self.subTest(protocol=node['type']):
    _, outbounds = self.roundtrip({'outbounds':[node]})
    outbound = next(o for o in outbounds if o['tag']=='main-out')
    for key, value in node.items():
     if key != 'tag':
      if value is False: self.assertFalse(outbound.get(key,False))
      else: self.assertEqual(outbound.get(key), value, key)

 def test_clash_and_mihomo_yaml_are_identified_explicitly(self):
  for content in ['port: 7890\nproxies:\n  - name: fixture\n', 'proxy-groups:\n  - name: fixture\n',
                  '# comment\nproxy-providers:\n  fixture: {}\n']:
   with self.subTest(content=content):
    self.assertIn('Clash/Mihomo YAML', self.invoke(content, parse=True)['error'])

 def test_json_and_share_link_detection_remain_supported(self):
  for document in [{'outbounds':[]}, {'servers':[]}, [{'server':'192.0.2.1','method':'none'}]]:
   with self.subTest(document=document):
    self.assertEqual(self.invoke(json.dumps(document), parse=True)['result'], document)
  for content in ['socks://192.0.2.1:1080', 'c29ja3M6Ly8xOTIuMC4yLjE6MTA4MA==']:
   self.assertIsNone(self.invoke(content, parse=True)['result'])
