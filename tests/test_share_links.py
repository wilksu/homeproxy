"""One parser serves manual RPC imports and subscription updates."""
import base64, copy, json, os, pathlib, re, shutil, subprocess, tempfile, unittest
from test_generator import ROOT, UCODE, CORE, BASE
import test_generator as generator
from urllib.parse import quote


def modules(directory):
 """Keep production URL/command logic; supply portable address primitives for CI."""
 destination = pathlib.Path(directory)/'modules'; destination.mkdir()
 source = (ROOT/'root/etc/homeproxy/scripts/homeproxy.uc').read_text()
 start = source.index('export function validation(')
 end = source.index('\n};', start)+3
 source = source[:start]+'''export function validation(kind, value) {
 if(value===null)return false;value=''+value;
 if(kind==='ip4addr')return !!match(value,/^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/);
 if(kind==='ip6addr')return !!match(value,/^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/);
 if(kind==='hostname')return !!validateHostname(value);
 if(kind==='host')return validation('ip4addr',value) || validation('ip6addr',value) || validation('hostname',value);
 if(kind==='port')return !!match(value,/^[0-9]+$/) && int(value)>0 && int(value)<=65535;
 return false;
};'''+source[end:]
 (destination/'homeproxy.uc').write_text(source)
 shutil.copy(ROOT/'root/etc/homeproxy/scripts/share_links.uc', destination/'share_links.uc')
 return destination


@unittest.skipUnless(UCODE, 'UCODE required')
class ShareLinkTests(unittest.TestCase):
 def parse(self, links, rpc=False, features=None):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp); mods=modules(path)
   content='\n'.join(links); (path/'input').write_text(content)
   features=features if features is not None else {'with_quic':True,'with_utls':True}
   prefix="import {readfile} from 'fs';\n"
   if rpc:
    source=(ROOT/'root/usr/share/rpcd/ucode/luci.homeproxy').read_text().replace(
     "'/etc/homeproxy/scripts/share_links.uc'",json.dumps(str(mods/'share_links.uc')))
    source=source.removeprefix('#!/usr/bin/ucode\n');prefix=''
    source=source.replace("return { 'luci.homeproxy': methods };",'')
    code=source+"\nbuiltinFeatures=()=>("+json.dumps(features)+");\nprint(sprintf('%J',methods.share_links_parse.call({args:{content:readfile("+json.dumps(str(path/'input'))+")}})));"
   else:
    code="import {parseShareLink,parseShareLinks} from 'share_links';\nconst input=readfile("+json.dumps(str(path/'input'))+");const features="+json.dumps(features)+";print(sprintf('%J',{batch:parseShareLinks(input,features),individual:map(split(input,'\\n'),link=>parseShareLink(link,features))}));"
   script=path/'probe.uc'; script.write_text(prefix+code)
   result=subprocess.run([UCODE,'-L',str(mods/'*.uc'),'-L',str(ROOT/'tests/support/*.uc'),
    '-L',str(ROOT/'root/usr/share/ucode/*.uc'),str(script)],capture_output=True,text=True,timeout=10)
   self.assertEqual(result.returncode,0,result.stderr)
   return json.loads(result.stdout)

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

 @unittest.skipUnless(CORE,'SING_BOX required')
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

 @unittest.skipUnless(CORE,'SING_BOX required')
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

 @unittest.skipUnless(CORE,'SING_BOX required')
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

 @unittest.skipUnless(CORE,'SING_BOX required')
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
