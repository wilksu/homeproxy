"""Run the actual ucode generators with fixture UCI/ubus and the pinned core.
UCODE=/path/ucode SING_BOX=/path/sing-box python3 -m unittest discover -s tests
No router settings or external network are changed by these checks.
"""
import copy,json,os,pathlib,shutil,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
UCODE=os.environ.get('UCODE',shutil.which('ucode') or '')
CORE=os.environ.get('SING_BOX',shutil.which('sing-box') or '')
BASE={
 'config':{'.type':'homeproxy','main_node':'node1','main_udp_node':'same','routing_mode':'global','proxy_mode':'redirect_tproxy','ipv6_support':'1','dns_server':'8.8.8.8','china_dns_server':'223.5.5.5'},
 'infra':{'.type':'homeproxy','ntp_server':'nil'},
 'routing':{'.type':'homeproxy','default_outbound':'route1','default_outbound_dns':'default-dns'},
 'dns':{'.type':'homeproxy','default_server':'default-dns'},
 'observability':{'.type':'homeproxy','enabled':'0'},
 'node1':{'.type':'node','type':'socks','address':'192.0.2.1','port':'1080','socks_version':'5'},
 'route1':{'.type':'routing_node','node':'node1','enabled':'1','label':'Fixture node'},
}
@unittest.skipUnless(UCODE and CORE,'UCODE and SING_BOX are required')
class GeneratorTests(unittest.TestCase):
 def generate(self,cfg,instance='client',proxy_domains=''):
  with tempfile.TemporaryDirectory() as tmp:
   tmp=pathlib.Path(tmp);mods=tmp/'modules';shutil.copytree(ROOT/'root/etc/homeproxy/scripts',mods)
   hp=mods/'homeproxy.uc';s=hp.read_text().replace("'/etc/homeproxy'",repr(str(tmp))).replace("'/var/run/homeproxy'",repr(str(tmp)))
   # Fixture validation handles only types used by this controlled config.
   s=s.replace("const ret = system(`/sbin/validate_data ${shellQuote(datatype)} ${shellQuote(data)} 2>/dev/null`);\n\treturn (ret === 0);", "if (datatype === 'ip4addr') return !!match(data, /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/);\n\tif (datatype === 'ip6addr') return index(data, ':') >= 0;\n\treturn true;")
   hp.write_text(s)
   h=mods/'config114.uc';h.write_text(h.read_text().replace("'/etc/homeproxy/api.secret'",repr(str(tmp/'api.secret'))))
   (tmp/'api.secret').write_text('0'*64)
   (tmp/'resources').mkdir();(tmp/'resources/direct_list.txt').write_text('');(tmp/'resources/proxy_list.txt').write_text(proxy_domains)
   f=tmp/'uci.json';f.write_text(json.dumps(cfg));env={**os.environ,'HP_TEST_UCI':str(f),'HP_OUTPUT_DIR':str(tmp)}
   p=subprocess.run([UCODE,'-L',str(ROOT/'tests/support/*.uc'),'-L',str(mods/'*.uc'),'-S',str(mods/f'generate_{instance}.uc')],capture_output=True,text=True,env=env)
   self.assertEqual(p.returncode,0,p.stderr)
   result=tmp/('sing-box-c.json' if instance=='client' else 'sing-box-s.json')
   p=subprocess.run([CORE,'check','-c',str(result)],capture_output=True,text=True)
   self.assertEqual(p.returncode,0,p.stderr)
   self.assertNotIn('deprecated',p.stderr.lower(),p.stderr)
   sources=json.loads(result.with_suffix('.sources').read_text())
   self.assertEqual(sources['schema'],1)
   self.assertNotIn('test-password',json.dumps(sources))
   return json.loads(result.read_text())
 def test_proxy_and_routing_modes(self):
  for routing in ['global','gfwlist','bypass_mainland_china','proxy_mainland_china','custom']:
   for proxy in ['redirect_tproxy','redirect_tun','tun']:
    with self.subTest(routing=routing,proxy=proxy):
     c=copy.deepcopy(BASE);c['config'].update(routing_mode=routing,proxy_mode=proxy)
     r=self.generate(c,proxy_domains='example.com\n')
     self.assertFalse(any('sniff' in i or 'sniff_override_destination' in i for i in r['inbounds']))
     self.assertTrue(any(x.get('action')=='sniff' for x in r['route']['rules']))
 def test_common_udp_settings(self):
  for mode in ['global','gfwlist','bypass_mainland_china','proxy_mainland_china','custom']:
   for proxy in ['redirect_tproxy','redirect_tun','tun']:
    with self.subTest(mode=mode,proxy=proxy):
     c=copy.deepcopy(BASE);c['config'].update(routing_mode=mode,proxy_mode=proxy)
     c['routing'].update(udp_mapping='address_dependent',udp_filtering='address_dependent',udp_nat_max='2048',udp_timeout='123')
     r=self.generate(c)
     ins=[i for i in r['inbounds'] if i['type'] in ['tproxy','tun']]
     self.assertTrue(ins)
     for i in ins:
      self.assertEqual(i['udp_mapping'],'address_dependent');self.assertEqual(i['udp_filtering'],'address_dependent')
      self.assertEqual(i['udp_nat_max'],2048);self.assertEqual(i['udp_timeout'],'123s')
 def test_disabled_udp_has_no_tproxy_listener(self):
  c=copy.deepcopy(BASE);c['config']['main_udp_node']='nil'
  self.assertFalse(any(i['type']=='tproxy' for i in self.generate(c)['inbounds']))
 def test_fresh_defaults_custom_mode(self):
  import shlex
  cfg={};section=None
  for line in (ROOT/'root/etc/config/homeproxy').read_text().splitlines():
   fields=shlex.split(line,comments=True)
   if not fields:continue
   if fields[0]=='config':section=fields[2];cfg[section]={'.type':fields[1]}
   elif fields[0]=='option':cfg[section][fields[1]]=fields[2]
   elif fields[0]=='list':cfg[section].setdefault(fields[1],[]).append(fields[2])
  cfg['config']['routing_mode']='custom'
  result=self.generate(cfg)
  self.assertEqual(result['dns']['strategy'],'prefer_ipv4')
  self.assertEqual(result['route']['final'],'direct-out')
 def test_custom_dangling_subscription_references(self):
  for kind in ['default','routing_rule','dns_server','ruleset','group','detour']:
   with self.subTest(kind=kind):
    c=copy.deepcopy(BASE);c['config']['routing_mode']='custom';c.pop('route1');c['routing']['default_outbound']='direct-out'
    if kind=='default':c['routing']['default_outbound']='gone'
    elif kind=='group':c['node1']={'.type':'node','type':'selector','group_nodes':['gone']};c['routing']['default_outbound']='node1'
    elif kind=='detour':c['node1']['local_detour']='gone';c['routing']['default_outbound']='node1'
    else:
     c['ref']={'.type':kind,'enabled':'1','outbound':'gone'}
     if kind=='dns_server':c['ref'].update(type='udp',server='192.0.2.2');c['dns']['default_server']='ref'
     if kind=='ruleset':c['ref'].update(type='remote',format='binary',url='https://example.test/rules.srs')
     if kind=='routing_rule':c['ref'].update(action='route',domain=['example.test'])
    with self.assertRaisesRegex(AssertionError,'missing|Missing'):
     self.generate(c)
 def test_api(self):
  c=copy.deepcopy(BASE);c['observability']['enabled']='1';r=self.generate(c)
  self.assertEqual(r['services'][0]['listen_port'],5334)
  self.assertEqual(r['services'][0]['dashboard'],False)
  self.assertEqual(r['services'][0]['listen'],'127.0.0.1')
  c['observability'].update(external='1',listen='192.0.2.2',allowed_origins=['https://dashboard.example'])
  r=self.generate(c);self.assertEqual(r['services'][0]['listen'],'192.0.2.2')
  self.assertEqual(r['services'][0]['access_control_allow_origin'],['https://dashboard.example'])
 def test_dns_response_filter(self):
  c=copy.deepcopy(BASE);c['config']['routing_mode']='custom'
  c['dnsrule']={'.type':'dns_rule','enabled':'1','action':'route','server':'default-dns','ip_cidr':['192.0.2.0/24'],'domain_strategy':'ipv4_only'}
  r=self.generate(c);rules=r['dns']['rules']
  self.assertEqual(rules[0]['action'],'evaluate')
  self.assertTrue(rules[-1]['match_response'])
  self.assertEqual(rules[-1]['action'],'respond')
 def test_dns_excluded_ruleset_preserves_and_condition(self):
  c=copy.deepcopy(BASE);c['config']['routing_mode']='custom'
  for key in ['inside','outside']:
   c[key]={'.type':'ruleset','enabled':'1','type':'remote','format':'binary','url':'https://example.test/'+key+'.srs','outbound':'direct-out'}
  c['rule']={'.type':'dns_rule','enabled':'1','rule_set':['inside'],'rule_set_exclude':['outside'],'server':'default-dns','client_subnet':'114.114.114.114/24'}
  rule=self.generate(c)['dns']['rules'][0]
  self.assertEqual(rule['type'],'logical');self.assertEqual(rule['mode'],'and')
  self.assertEqual(rule['rules'],[{'rule_set':['cfg-inside-rule']},{'rule_set':['cfg-outside-rule'],'invert':True}])
  self.assertEqual(rule['server'],'default-dns');self.assertEqual(rule['client_subnet'],'114.114.114.114/24')
 def test_wireguard(self):
  c=copy.deepcopy(BASE);c['node1']={'.type':'node','type':'wireguard','address':'192.0.2.1','port':'51820','wireguard_local_address':['10.0.0.2/32'],'wireguard_private_key':'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=','wireguard_peer_public_key':'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='}
  r=self.generate(c);self.assertEqual(r['endpoints'][0]['type'],'wireguard')
 def test_servers(self):
  for protocol in ['socks','mixed','http','shadowsocks','vmess','vless','trojan','hysteria2','tuic','anytls']:
   with self.subTest(protocol=protocol):
    c=copy.deepcopy(BASE);c['server']={'.type':'homeproxy','enabled':'1'}
    c['listener']={'.type':'server','enabled':'1','type':protocol,'address':'127.0.0.1','port':'16666','uuid':'00000000-0000-4000-8000-000000000001','password':'test-password','username':'test','shadowsocks_encrypt_method':'aes-128-gcm'}
    if protocol in ['trojan','hysteria2','tuic','anytls']:
     # No certificates are needed during configuration checks if ACME supplies them.
     c['listener'].update(tls='1',tls_acme='1',tls_acme_domain=['example.com'],tls_acme_email='test@example.com')
    if protocol=='vmess':c['listener']['vmess_alterid']='2'
    result=self.generate(c,'server')
    if protocol=='vmess':self.assertEqual(result['inbounds'][0]['users'][0]['alterId'],2)
 def test_tailscale_endpoint_and_direct_library_selection(self):
  c=copy.deepcopy(BASE);c['config']['routing_mode']='custom';c['routing']['default_outbound']='node1';c.pop('route1')
  c['node1']={'.type':'node','type':'tailscale','label':'Tailnet','tailscale_hostname':'hp-test','tailscale_accept_routes':'1','tailscale_advertise_routes':['192.0.2.0/24'],'tailscale_ssh_server':'1','tailscale_ssh_disable_sftp':'1'}
  r=self.generate(c);self.assertEqual(r['route']['final'],'cfg-node1-out');t=r['endpoints'][0]
  self.assertEqual(t['type'],'tailscale');self.assertTrue(t['accept_routes']);self.assertTrue(t['ssh_server']['disable_sftp']);self.assertEqual(t['advertise_routes'],['192.0.2.0/24'])
 def test_library_group_dependency_closure(self):
  c=copy.deepcopy(BASE);c['config']['routing_mode']='custom';c['routing']['default_outbound']='group1';c.pop('route1')
  c['group1']={'.type':'node','type':'selector','group_nodes':['auto1','node1'],'group_default':'auto1'}
  c['auto1']={'.type':'node','type':'urltest','group_nodes':['node1'],'group_interval':'300'}
  r=self.generate(c);out={o['tag']:o for o in r['outbounds']}
  self.assertEqual(out['cfg-group1-out']['outbounds'],['cfg-auto1-out','cfg-node1-out']);self.assertIn('cfg-node1-out',out)
 def test_reference_materializes_and_loads_upstream_in_both_modes(self):
  for mode in ['custom','global']:
   with self.subTest(mode=mode):
    c=copy.deepcopy(BASE);c.pop('route1');c['config'].update(routing_mode=mode,main_node='variant')
    c['routing']['default_outbound']='variant'
    c['upstream']={'.type':'node','type':'socks','address':'192.0.2.2','port':'1080','socks_version':'5'}
    c['variant']={'.type':'node','node_mode':'reference','node_base':'node1','local_detour':'upstream','label':'Via upstream'}
    r=self.generate(c);out={o['tag']:o for o in r['outbounds']};v=out['cfg-variant-out' if mode=='custom' else 'main-out']
    self.assertEqual(v['type'],'socks');self.assertEqual(v['server'],'192.0.2.1');self.assertEqual(v['detour'],'cfg-upstream-out')
    self.assertIn('cfg-upstream-out',out);self.assertNotIn('cfg-node1-out',out)
 def test_plain_main_node_detour_loads_dependencies(self):
  c=copy.deepcopy(BASE);c['node1']['local_detour']='upstream'
  c['upstream']={'.type':'node','type':'socks','address':'192.0.2.2','port':'1080','socks_version':'5'}
  r=self.generate(c);self.assertTrue(any(o['tag']=='cfg-upstream-out' for o in r['outbounds']))
if __name__=='__main__':unittest.main()
