"""Check query destinations using the generated rules and two local DNS servers."""
import copy, json, pathlib, socket, socketserver, struct, subprocess, tempfile, threading, unittest
from test_generator import BASE, CORE, UCODE
import test_generator as generator


class Resolver(socketserver.UDPServer):
 def __init__(self,address):
  class Handler(socketserver.BaseRequestHandler):
   def handle(self):
    request,sock=self.request
    self.server.queries.append(request)
    header=request[:2]+struct.pack('!HHHHH',0x8180,1,1,0,0)
    answer=b'\xc0\x0c'+struct.pack('!HHIH',1,1,0,4)+socket.inet_aton(self.server.address)
    sock.sendto(header+request[12:]+answer,self.client_address)
  super().__init__(('127.0.0.1',0),Handler)
  self.address=address;self.queries=[]
  self.thread=threading.Thread(target=self.serve_forever,kwargs={'poll_interval':.02},daemon=True)
  self.thread.start()
 def close(self):
  self.shutdown();self.server_close();self.thread.join()


@unittest.skipUnless(UCODE and CORE,'UCODE and SING_BOX are required')
class DNSEvaluationTests(unittest.TestCase):
 def test_request_scope_with_real_core(self):
  for kind in ['domain','inverted','mixed-ruleset']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as tmp:
    c=copy.deepcopy(BASE);c['config']['routing_mode']='custom'
    c['eval']={'.type':'dns_server','enabled':'1','type':'udp','server':'127.0.0.1','outbound':'direct-out'}
    c['filter']={'.type':'dns_rule','enabled':'1','action':'route','server':'eval','domain_suffix':['corp.example'],'ip_cidr':['192.0.2.0/24'],'query_type':['A'],'source_ip_cidr':['127.0.0.0/8'],'dns_disable_cache':'1'}
    if kind=='inverted':c['filter'].update(invert='1',ip_cidr=['198.51.100.0/24'])
    if kind=='mixed-ruleset':
     c['filter'].update(rule_set=['mixed'])
     c['mixed']={'.type':'ruleset','enabled':'1','type':'remote','format':'source','url':'https://example.test/mixed.json','outbound':'direct-out'}
    generated=generator.GeneratorTests().generate(c)
    evaluation=generated['dns']['rules'][0]
    if kind=='domain':
     self.assertEqual(evaluation['domain_suffix'],['corp.example'])
     self.assertEqual(evaluation['source_ip_cidr'],['127.0.0.0/8'])
     self.assertEqual(evaluation['query_type'],['A'])
    else:
     self.assertNotIn('domain_suffix',evaluation)
     self.assertNotIn('invert',evaluation)
    self.assertNotIn('ip_cidr',evaluation)
    self.assertNotIn('rule_set',evaluation)
    selected=Resolver('192.0.2.8');fallback=Resolver('203.0.113.8')
    core=None
    try:
     with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
      sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
     cfg={'log':{'level':'error'},'inbounds':[{'type':'direct','listen':'127.0.0.1','listen_port':port,'network':'udp'}],
      'outbounds':[{'type':'direct','tag':'direct-out'}],
      'route':{'rules':[{'action':'hijack-dns'}],'default_domain_resolver':'default-dns'},
      'dns':{'rules':generated['dns']['rules'],'final':'default-dns','disable_cache':True,'servers':[
       {'type':'udp','tag':'cfg-eval-dns','server':'127.0.0.1','server_port':selected.server_address[1]},
       {'type':'udp','tag':'default-dns','server':'127.0.0.1','server_port':fallback.server_address[1]}]}}
     if kind=='mixed-ruleset':cfg['route']['rule_set']=[{'type':'inline','tag':'cfg-mixed-rule','rules':[{'domain_suffix':['other.example']}]}]
     path=pathlib.Path(tmp)/'config.json';path.write_text(json.dumps(cfg))
     core=subprocess.Popen([CORE,'run','-c',str(path)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
     def query(name):
      wire=b''.join(bytes([len(label)])+label.encode() for label in name.split('.'))+b'\x00'
      request=struct.pack('!HHHHHH',123,0x0100,1,0,0,0)+wire+struct.pack('!HH',1,1)
      with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
       sock.settimeout(.1)
       for _ in range(50):
        self.assertIsNone(core.poll(),'fixture core exited')
        sock.sendto(request,('127.0.0.1',port))
        try:return socket.inet_ntoa(sock.recv(4096)[-4:])
        except socket.timeout:pass
      self.fail('DNS response timed out')
     if kind=='domain':
      self.assertEqual(query('www.other.example'),'203.0.113.8')
      self.assertEqual(len(selected.queries),0,'unrelated query leaked to evaluation resolver')
      self.assertEqual(query('www.corp.example'),'192.0.2.8')
      self.assertEqual(len(selected.queries),1)
     else:
      # Whole-rule negation and merged rule-set groups can match outside the
      # literal domain gate: narrowing those to the domain would lose matches.
      self.assertEqual(query('www.other.example'),'192.0.2.8')
      self.assertEqual(len(selected.queries),1)
    finally:
     if core is not None:
      core.terminate();_,errors=core.communicate(timeout=5)
      self.assertIn(core.returncode,[0,-15],errors.decode())
     selected.close();fallback.close()
