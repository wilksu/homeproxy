import os,pathlib,subprocess,tempfile,unittest,json,socket,time,shutil
from test_generator import UCODE,CORE,ROOT
@unittest.skipUnless(UCODE and CORE,'UCODE and SING_BOX required')
class RelayTests(unittest.TestCase):
 def test_auth_and_native_grpc_web(self):
  self.run_relay(False)
 @unittest.skipUnless(shutil.which('openssl'), 'openssl is required for TLS fixture')
 def test_tls_relay_verifies_inline_certificate(self):
  self.run_relay(True)
 def test_tls_dns_name(self):
  self.run_relay(True,True)
 def run_relay(self,tls,dns=False):
  with tempfile.TemporaryDirectory() as tmp:
   p=pathlib.Path(tmp)
   with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
   cfg={'log':{'level':'warn'},'services':[{'type':'api','listen':'127.0.0.1','listen_port':port,'secret':'a'*64,'dashboard':False}]}
   if tls:
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=DNS:router.test' if dns else 'subjectAltName=IP:127.0.0.1','-keyout',str(p/'key.pem'),'-out',str(p/'cert.pem')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    cfg['services'][0]['tls']={'enabled':True,'certificate':[(p/'cert.pem').read_text()],'key':[(p/'key.pem').read_text()]}
   config=p/'sing-box-c.json';config.write_text(json.dumps(cfg))
   core=subprocess.Popen([CORE,'run','-c',str(config)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   try:
    for _ in range(100):
     try:
      with socket.create_connection(('127.0.0.1',port),timeout=.1):break
     except OSError:time.sleep(.02)
    worker=p/'api-stream.sh';worker.write_text((ROOT/'root/etc/homeproxy/scripts/api-stream.sh').read_text().replace('/tmp/homeproxy-api-streams',str(p/'jobs')))
    relay=p/'relay.uc';relay.write_text((ROOT/'root/www/cgi-bin/homeproxy-api').read_text().replace('/var/run/homeproxy',str(p)).replace('/tmp/homeproxy-api-streams',str(p/'jobs')).replace('/etc/homeproxy/scripts/api-stream.sh',str(worker)))
    (p/'ubus.uc').write_text("export function connect() { return { call: (object, method, args) => ({ access: args.function === 'api_read' }) }; }")
    (p/'uci.uc').write_text("export function cursor() { return { get: () => "+ ('"router.test"' if dns else 'null') +" }; }")
    env={**os.environ,'PATH_INFO':'/client/GetVersion','REQUEST_METHOD':'POST','CONTENT_TYPE':'application/grpc-web+proto','CONTENT_LENGTH':'5','HTTP_HOST':'router.test','HTTP_ORIGIN':'http://router.test'}
    def request(changes=None):
     return subprocess.run([UCODE,'-L',str(p/'*.uc'),str(relay)],input=b'\x00'*5,capture_output=True,env={**env,**(changes or {})},timeout=8)
    r=request();self.assertIn(b'401 Unauthorized',r.stdout,r.stderr)
    auth={'HTTP_COOKIE':'sysauth_http='+'b'*32}
    r=request({**auth,'HTTP_ORIGIN':'http://other.test'});self.assertIn(b'403 Forbidden',r.stdout)
    r=request({**auth,'PATH_INFO':'/client/CloseAllConnections'});self.assertIn(b'403 Forbidden',r.stdout)
    r=request({**auth,'PATH_INFO':'/client/NotAMethod'});self.assertIn(b'404 Not Found',r.stdout)
    for credentials in [{'HTTP_AUTHORIZATION':'LuCI '+'b'*32},auth]:
     r=request(credentials)
     self.assertEqual(r.returncode,0,r.stderr)
     self.assertIn(b'1.14.0',r.stdout);self.assertIn(b'grpc-status: 0',r.stdout)
     self.assertNotIn(b'a'*64,r.stdout)
     self.assertFalse(list((p/'jobs').glob('job.*')))
    # Admission limits and session isolation use private fixture jobs only.
    jobs=p/'jobs'
    for count in range(2):
     d=jobs/f'job.limit{count}';d.mkdir();(d/'owner').write_text(json.dumps({'session':'b'*32,'instance':'client','method':'SubscribeLog','persistent':True}))
    denied=request({**auth,'PATH_INFO':'/client/SubscribeLog'});self.assertIn(b'429 Too Many Requests',denied.stdout)
    for d in jobs.glob('job.limit*'):shutil.rmtree(d)
    # A revoked session cannot read an already-owned job.
    (p/'ubus.uc').write_text("export function connect() { return { call: () => ({ access: false }) }; }")
    denied=request({**auth,'QUERY_STRING':'start'});self.assertIn(b'403 Forbidden',denied.stdout)
   finally:core.terminate();core.wait(timeout=5)
