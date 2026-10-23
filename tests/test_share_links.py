"""One parser serves manual RPC imports and subscription updates."""
import base64, json, os, pathlib, shutil, subprocess, tempfile, unittest
from test_generator import ROOT, UCODE


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
