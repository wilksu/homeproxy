"""Parser contracts: no core, services, network, or real UCI writes."""
import base64
import json
import pathlib
import subprocess
import tempfile
import unittest
from urllib.parse import quote
from support.ucode import ROOT, UCODE, ShareLinkProbe, modules

@unittest.skipUnless(UCODE, 'UCODE required')
class ShareLinkTests(ShareLinkProbe, unittest.TestCase):
 def test_insecure_values_match_across_rpc_and_subscription_parser(self):
  links=['hy2://fixture@192.0.2.1:443/?'+query+'#fixture' for query in
   ['','insecure=0','insecure=false','insecure=1','insecure=true','insecure=unexpected']]
  direct=self.parse(links)['individual']; rpc=self.parse(links,rpc=True)['nodes']
  self.assertEqual(rpc,direct)
  self.assertEqual([n['tls_insecure'] for n in rpc],['0','0','0','1','1','0'])

 def test_protocols_credentials_and_encoded_values(self):
  vmess={'v':'2','ps':'sale%20off','add':'192.0.2.1','port':443,
   'id':'00000000-0000-4000-8000-000000000001','net':'tcp','tls':'tls'}
  auth=base64.b64encode(b'aes-128-gcm:fixture').decode()
  cases=[
   ('anytls://p%40ss%3Aword@192.0.2.1:443/#Any', 'anytls', {'password':'p@ss:word'}),
   ('http://u%2Bser:p%40ss@192.0.2.1:1080/#HTTP','http',{'username':'u+ser','password':'p@ss'}),
   ('https://fixture@192.0.2.1:443/#TLS','http',{'tls':'1'}),
   ('socks4a://192.0.2.1:1080/#SOCKS','socks',{'socks_version':'4a'}),
   ('hysteria://192.0.2.1:443/?auth=fixture&upmbps=10&downmbps=10#Hy','hysteria',{'hysteria_auth_payload':'fixture'}),
   ('hy2://user:pass@192.0.2.1:443/?insecure=0#Hy2','hysteria2',{'password':'user:pass','tls_insecure':'0'}),
   ('ss://'+auth+'@192.0.2.1:443/?plugin=simple-obfs%3Bobfs%3Dhttp#SS','shadowsocks',{'password':'fixture','shadowsocks_plugin':'obfs-local'}),
   ('trojan://p%40ss@192.0.2.1:443/#Trojan','trojan',{'password':'p@ss'}),
   ('tuic://00000000-0000-4000-8000-000000000001:fixture@[2001:db8::1]:443/#TUIC','tuic',{'address':'2001:db8::1'}),
   ('vless://00000000-0000-4000-8000-000000000001@192.0.2.1:443/?type=ws&path=%2Ffoo%2520#VLESS','vless',{'ws_path':'/foo%20'}),
   ('vmess://'+base64.b64encode(json.dumps(vmess).encode()).decode(),'vmess',{'label':'sale%20off'}),
  ]
  direct=self.parse([c[0] for c in cases]); rpc=self.parse([c[0] for c in cases],rpc=True)
  self.assertEqual(rpc['nodes'],direct['individual'])
  for (_,protocol,fields),node in zip(cases,rpc['nodes']):
   self.assertIsNotNone(node);self.assertEqual(node['type'],protocol)
   for key,value in fields.items():self.assertEqual(node.get(key),value,key)
  self.assertEqual(len(rpc['nodes']),len(cases))
  for suffix in ['', '#', '?', '?#']:
   node=self.parse(['socks://192.0.2.1'+suffix],rpc=True)['nodes'][0]
   self.assertEqual(node['address'],'192.0.2.1');self.assertEqual(node['port'],'80')

 def test_batch_limits_deduplication_invalid_and_missing_capabilities(self):
  link='socks://192.0.2.1:1080#fixture'
  result=self.parse([link,link,'invalid','vmess://broken',''])['batch']
  self.assertEqual(result['total'],3);self.assertEqual(len(result['nodes']),1)
  self.assertEqual(self.parse(['hy2://fixture@192.0.2.1:443'],features={})['batch']['nodes'],[])
  self.assertIn('error',self.parse(['x'*(512*1024+1)],rpc=True))

 def test_manual_rpc_requires_write_access(self):
  acl=json.loads((ROOT/'root/usr/share/rpcd/acl.d/luci-app-homeproxy.json').read_text())['luci-app-homeproxy']
  self.assertNotIn('share_links_parse',acl['read']['ubus']['luci.homeproxy'])
  self.assertIn('share_links_parse',acl['write']['ubus']['luci.homeproxy'])

 def test_invalid_shadowsocks_methods_are_rejected_in_every_encoding(self):
  invalid=[]
  for method in ['invalid','','AES-128-GCM','aes-128-cfb']:
   auth=method+':fixture'
   invalid.extend(['ss://'+auth+'@192.0.2.1:443/',
    'ss://'+base64.b64encode(auth.encode()).decode()+'@192.0.2.1:443/',
    'ss://'+base64.b64encode((auth+'@192.0.2.1:443').encode()).decode()])
  self.assertEqual(self.parse(invalid)['individual'],[None]*len(invalid))
  self.assertEqual(self.parse(invalid,rpc=True)['nodes'],[])
  with tempfile.TemporaryDirectory() as tmp:
   mods=modules(tmp)
   objects=[{'nodetype':'sip008','server':'192.0.2.1','server_port':443,'method':m,'password':'fixture'} for m in ['invalid',None,'']]
   code="import{parseShareLink}from'share_links';printf('%J',map("+json.dumps(objects)+",n=>parseShareLink(n,{})));"
   result=subprocess.run([UCODE,'-L',str(mods/'*.uc'),'-L',str(ROOT/'tests/support/*.uc'),'-e',code],capture_output=True,text=True)
   self.assertEqual(result.returncode,0,result.stderr)
   self.assertEqual(json.loads(result.stdout),[None]*len(objects))

 def test_protocol_required_credentials_are_not_lost_when_parsers_are_unified(self):
  invalid=['anytls://192.0.2.1:443/','trojan://192.0.2.1:443/',
   'tuic://192.0.2.1:443/','vless://192.0.2.1:443/?type=tcp']
  self.assertEqual(self.parse(invalid)['individual'],[None]*len(invalid))
  self.assertEqual(self.parse(invalid,rpc=True)['nodes'],[])
  # A VLESS transport omitted from the link can use the core's TCP default.
  node=self.parse(['vless://00000000-0000-4000-8000-000000000001@192.0.2.1:443/'],rpc=True)['nodes'][0]
  self.assertEqual(node['type'],'vless');self.assertNotIn('transport',node)

 def test_default_ports_and_explicit_overrides(self):
  cases=[]
  for scheme,default,protocol in [('http',80,'http'),('https',443,'http'),('anytls',443,'anytls'),('hysteria2',443,'hysteria2'),('hy2',443,'hysteria2')]:
   for host in ['192.0.2.1','example.test','[2001:db8::1]']:
    for port in [None,'',80,443,8443]:
     suffix='' if port is None else ':'+str(port)
     cases.append((scheme+'://fixture@'+host+suffix+'/',str(port or default),protocol,scheme!='http'))
  result=self.parse([c[0] for c in cases])
  self.assertEqual(len(result['individual']),len(cases))
  self.assertEqual(result['batch']['nodes'],result['individual'])
  for node,(link,port,protocol,tls) in zip(result['individual'],cases):
   with self.subTest(link=link):
    self.assertIsNotNone(node)
    self.assertEqual(node['port'],port)
    self.assertEqual(node['type'],protocol)
    self.assertEqual(node['tls'],'1' if tls else '0')

 def test_nested_delimiters_and_percent_sequences_are_decoded_once(self):
  path='/relay/https://upstream.test/%20/%2F'
  label='香港 https://label.test / %20 %2F'
  links=[]
  for protocol,user in [('vless','00000000-0000-4000-8000-000000000001'),('trojan','fixture')]:
   # An encoded '%' must survive one decoding; it is not a space or slash.
   for encoded in [False,True]:
    value=quote(path,safe='') if encoded else path.replace('%','%25')
    links.append(protocol+'://'+user+'@192.0.2.1:443/?type=ws&path='+value+'#'+quote(label,safe=':/'))
  for node in self.parse(links)['individual']:
   self.assertIsNotNone(node)
   self.assertEqual(node['ws_path'],path)
   self.assertEqual(node['label'],label)

 def test_generated_shadowsocks_encodings_preserve_original_values(self):
  # Deterministic Cartesian cases: no network, random seed, or production
  # encoder supplies the expected values. Assert against the original strings.
  passwords=['fixture','a/b','a%20b','a?b','a#b','test/!@#:','密钥:+/%?#']
  label='香港 01 / %20 https://label.test'
  cases={}
  for host in ['192.0.2.1','example.test','[2001:db8::1]']:
   for password in passwords:
    auth='aes-128-gcm:'+password
    endpoint=host+':443'
    bodies=['aes-128-gcm:'+quote(password,safe='')+'@'+endpoint,
            '%61es-128-gcm:'+quote(password,safe='')+'@'+endpoint]
    for encoder in [base64.b64encode,base64.urlsafe_b64encode]:
     for padding in [True,False]:
      userinfo=encoder(auth.encode()).decode()
      full=encoder((auth+'@'+endpoint).encode()).decode()
      bodies.extend([(userinfo if padding else userinfo.rstrip('='))+'@'+endpoint,
                     full if padding else full.rstrip('=')])
    for body in bodies:
     cases['ss://'+body+'#'+quote(label,safe='')]=(host.strip('[]'),password)
  parsed=self.parse(list(cases))
  self.assertEqual(parsed['batch']['nodes'],parsed['individual'])
  self.assertEqual(len(parsed['individual']),len(cases))
  for link,node in zip(cases,parsed['individual']):
   with self.subTest(link=link):
    self.assertIsNotNone(node)
    host,password=cases[link]
    self.assertEqual(node['address'],host)
    self.assertEqual(node['password'],password)
    self.assertEqual(node['label'],label)
    self.assertEqual(node['shadowsocks_encrypt_method'],'aes-128-gcm')
    self.assertEqual(node['port'],'443')

 def test_batch_byte_boundary_and_bad_input(self):
  # ucode lengths are UTF-8 byte lengths, not Python character counts.
  link='socks://192.0.2.1:1080#'
  content=link+'x'*(512*1024-len(link))
  result=self.parse([content],rpc=True)
  self.assertNotIn('error',result)
  self.assertEqual(result['total'],1)
  self.assertEqual(len(result['nodes']),1)
  self.assertEqual(len(result['nodes'][0]['label']),512*1024-len(link))
  self.assertIn('error',self.parse([content+'x'],rpc=True))
  self.assertIn('error',self.parse(['中'*(512*1024//3+1)],rpc=True))

 def test_missing_quic_capability_rejects_only_quic_protocols(self):
  links=['anytls://fixture@192.0.2.1:443/',
         'hysteria://192.0.2.1:443/?auth=fixture&upmbps=10&downmbps=10',
         'hysteria2://fixture@192.0.2.1:443/',
         'hy2://fixture@192.0.2.1:443/',
         'tuic://00000000-0000-4000-8000-000000000001:fixture@192.0.2.1:443/',
         'socks://192.0.2.1:1080/']
  nodes=self.parse(links,features={})['individual']
  self.assertIsNotNone(nodes[0])
  self.assertEqual(nodes[1:5],[None]*4)
  self.assertIsNotNone(nodes[5])
