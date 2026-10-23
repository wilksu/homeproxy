"""Import native subscriptions with the paired core, then validate generated UCI nodes."""
import copy, hashlib, json, os, pathlib, subprocess, tempfile, unittest
from test_generator import ROOT, UCODE, CORE, BASE
import test_generator as generator


@unittest.skipUnless(UCODE and CORE, 'UCODE and SING_BOX are required')
class SubscriptionImportTests(unittest.TestCase):
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
  for network in [None, 'tcp', 'udp']:
   with self.subTest(network=network):
    proxy = {'type':'shadowsocks', 'tag':'ss', 'server':'192.0.2.1', 'server_port':443,
     'method':'chacha20-ietf-poly1305', 'password':'fixture', 'plugin':'obfs-local',
     'plugin_opts':'obfs=http;obfs-host=example.test', 'udp_over_tcp':False}
    if network: proxy['network'] = network
    document = {'outbounds':[
     {'type':'selector', 'tag':'choose', 'outbounds':['automatic','direct'], 'default':'automatic'},
     {'type':'urltest', 'tag':'automatic', 'outbounds':['ss','anytls'], 'interval':'5m'},
     proxy,
     {'type':'anytls', 'tag':'anytls', 'server':'192.0.2.2', 'server_port':443, 'password':'fixture',
      'tls':{'enabled':True, 'server_name':'example.test', 'insecure':False, 'alpn':['h2','http/1.1']}},
     {'type':'direct', 'tag':'direct'}]}
    result = self.invoke(document)
    self.assertNotIn('error', result)
    nodes = result['result']; self.assertEqual(len(nodes), 5)
    ss = next(node for node in nodes if node['type']=='shadowsocks')
    self.assertEqual(ss.get('shadowsocks_network'), network)
    config = copy.deepcopy(BASE); config.pop('node1'); config.pop('route1')
    for node in nodes:
     config[node['node_id']] = {**node, '.type':'node', '.name':node['node_id']}
    config['config']['main_node'] = nodes[0]['node_id']
    generated = generator.GeneratorTests().generate(config)
    outbound = next(node for node in generated['outbounds'] if node['type']=='shadowsocks')
    self.assertEqual(outbound.get('network'), network)
    self.assertEqual(outbound['plugin_opts'], proxy['plugin_opts'])
    self.assertEqual(outbound['password'], 'fixture')

 def test_invalid_native_network_is_rejected_by_real_core(self):
  result = self.invoke({'outbounds':[{'type':'shadowsocks','tag':'bad','server':'192.0.2.1',
   'server_port':443,'method':'aes-128-gcm','password':'fixture','network':'invalid'}]})
  self.assertIn('core validation', result['error'])

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
