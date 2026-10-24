"""Share-link models must survive generation and the actual paired core."""
import base64, copy, re, unittest
from urllib.parse import quote
from test_generator import CORE, BASE
import test_generator as generator
from support.ucode import ROOT, UCODE, ShareLinkProbe

@unittest.skipUnless(UCODE and CORE, 'UCODE and SING_BOX required')
class ShareLinkGenerationTests(ShareLinkProbe, unittest.TestCase):
 def test_protocol_defaults_and_explicit_ports_survive_generation(self):
  cases=[]
  for scheme,default,protocol in [('http',80,'http'),('https',443,'http'),('anytls',443,'anytls'),('hysteria2',443,'hysteria2'),('hy2',443,'hysteria2')]:
   for host in ['192.0.2.1','example.test','[2001:db8::1]']:
    for port in [None,'',80,443,8443]:
     suffix='' if port is None else ':'+str(port)
     auth='fixture:password' if protocol=='http' else 'fixture'
     cases.append((scheme+'://'+auth+'@'+host+suffix+'/',port or default,scheme!='http',protocol))
  nodes=self.parse([c[0] for c in cases],rpc=True)['nodes']
  self.assertEqual(nodes,self.parse([c[0] for c in cases])['individual'])
  config=copy.deepcopy(BASE);config.pop('node1');config.pop('route1')
  for i,(node,(_,port,tls,protocol)) in enumerate(zip(nodes,cases)):
   self.assertEqual(int(node['port']),port,cases[i][0]);self.assertEqual(node['tls'],'1' if tls else '0')
   self.assertEqual(node['type'],protocol)
   config['fixture'+str(i)]={**node,'.type':'node'}
  config['all']={'.type':'node','type':'selector','group_nodes':['fixture'+str(i) for i in range(len(nodes))]}
  config['config']['main_node']='all'
  outbounds={n['tag']:n for n in generator.GeneratorTests().generate(config)['outbounds']}
  for i,(_,port,tls,protocol) in enumerate(cases):
   out=outbounds['cfg-fixture'+str(i)+'-out']
   self.assertEqual(out['server_port'],port);self.assertEqual(bool(out.get('tls',{}).get('enabled')),tls)
  invalid=[scheme+'://192.0.2.1:'+port+'/' for scheme in ['http','https'] for port in ['invalid','-1','65536']]
  self.assertEqual(self.parse(invalid,rpc=True)['nodes'],[])

 def test_every_editor_shadowsocks_method_is_accepted_and_passes_the_core(self):
  source=(ROOT/'htdocs/luci-static/resources/homeproxy.js').read_text()
  block=re.search(r'shadowsocks_encrypt_methods:\s*\[([^]]+)\]',source).group(1)
  methods=re.findall(r"'([^']+)'",block)
  self.assertTrue(methods)
  links=[]
  for method in methods:
   password=base64.b64encode(b'x'*(16 if 'aes-128' in method else 32)).decode() if method.startswith('2022-') else 'fixture'
   links.append('ss://'+base64.b64encode((method+':'+password).encode()).decode()+'@192.0.2.1:443/')
  nodes=self.parse(links,rpc=True)['nodes']
  self.assertEqual([n['shadowsocks_encrypt_method'] for n in nodes],methods)
  config=copy.deepcopy(BASE);config.pop('node1');config.pop('route1')
  for i,node in enumerate(nodes):config['fixture'+str(i)]={**node,'.type':'node'}
  config['all']={'.type':'node','type':'selector','group_nodes':['fixture'+str(i) for i in range(len(nodes))]}
  config['config']['main_node']='all'
  outbounds={n['tag']:n for n in generator.GeneratorTests().generate(config)['outbounds']}
  self.assertEqual([outbounds['cfg-fixture'+str(i)+'-out']['method'] for i in range(len(nodes))],methods)

 def test_nested_scheme_delimiters_in_paths_and_labels_are_preserved(self):
  path='/relay/https://upstream.test/resource'
  label='relay https://label.test'
  links=[]
  for protocol,user in [('vless','00000000-0000-4000-8000-000000000001'),('trojan','fixture')]:
   for encoded in [False,True]:
    links.append(protocol+'://'+user+'@192.0.2.1:443/?type=ws&path='+
     (quote(path,safe='') if encoded else path)+'#'+quote(label,safe=':/'))
  nodes=self.parse(links,rpc=True)['nodes']
  self.assertEqual(len(nodes),len(links))
  config=copy.deepcopy(BASE);config.pop('node1');config.pop('route1')
  for i,node in enumerate(nodes):
   self.assertEqual(node['ws_path'],path);self.assertEqual(node['label'],label)
   config['fixture'+str(i)]={**node,'.type':'node'}
  config['all']={'.type':'node','type':'selector','group_nodes':['fixture'+str(i) for i in range(len(nodes))]}
  config['config']['main_node']='all'
  outbounds={n['tag']:n for n in generator.GeneratorTests().generate(config)['outbounds']}
  for i in range(len(nodes)):self.assertEqual(outbounds['cfg-fixture'+str(i)+'-out']['transport']['path'],path)

 def test_shadowsocks_encodings_preserve_raw_credentials_and_encoded_labels(self):
  label='香港 01 / %20 https://label.test'
  passwords=['fixture','a/b','a%20b','a?b','a#b','test/!@#:','密钥:+/%?#']
  links=[];expected=[]
  for password in passwords:
   auth='aes-128-gcm:'+password
   bodies=['aes-128-gcm:'+quote(password,safe='')+'@192.0.2.1:443',
    '%61es-128-gcm:'+quote(password,safe='')+'@192.0.2.1:443',
    base64.urlsafe_b64encode(auth.encode()).decode().rstrip('=')+'@192.0.2.1:443',
    base64.b64encode((auth+'@192.0.2.1:443').encode()).decode().rstrip('='),
    base64.urlsafe_b64encode((auth+'@192.0.2.1:443').encode()).decode().rstrip('=')]
   for body in dict.fromkeys(bodies):
    links.append('ss://'+body+'#'+quote(label,safe=''))
    expected.append(password)
  nodes=self.parse(links,rpc=True)['nodes']
  self.assertEqual(len(nodes),len(expected))
  config=copy.deepcopy(BASE);config.pop('node1');config.pop('route1')
  for i,(node,password) in enumerate(zip(nodes,expected)):
   self.assertEqual(node['password'],password);self.assertEqual(node['label'],label)
   self.assertEqual(node['shadowsocks_encrypt_method'],'aes-128-gcm')
   config['fixture'+str(i)]={**node,'.type':'node'}
  config['all']={'.type':'node','type':'selector','group_nodes':['fixture'+str(i) for i in range(len(nodes))]}
  config['config']['main_node']='all'
  outbounds={n['tag']:n for n in generator.GeneratorTests().generate(config)['outbounds']}
  for i,password in enumerate(expected):self.assertEqual(outbounds['cfg-fixture'+str(i)+'-out']['password'],password)
