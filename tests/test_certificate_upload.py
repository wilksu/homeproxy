"""Validate real PEM/DER and ECH uploads without touching router files."""
import base64, json, os, pathlib, shutil, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
UCODE = os.environ.get('UCODE', shutil.which('ucode') or '')
CORE = os.environ.get('SING_BOX', shutil.which('sing-box') or '')

def pem(label, payload=b'abcd'):
 return f'-----BEGIN {label}-----\n{base64.b64encode(payload).decode()}\n-----END {label}-----\n'

@unittest.skipUnless(UCODE and CORE and shutil.which('openssl'), 'ucode, sing-box and openssl are required')
class CertificateUploadTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.fixture = tempfile.TemporaryDirectory(); cls.addClassCleanup(cls.fixture.cleanup)
  p = pathlib.Path(cls.fixture.name)
  subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=qa.local','-keyout',str(p/'key'),'-out',str(p/'cert')],check=True,capture_output=True)
  subprocess.run(['openssl','rsa','-in',str(p/'key'),'-traditional','-out',str(p/'rsa')],check=True,capture_output=True)
  subprocess.run(['openssl','ecparam','-name','prime256v1','-genkey','-noout','-out',str(p/'ec')],check=True,capture_output=True)
  cls.cert=(p/'cert').read_text();cls.key=(p/'key').read_text();cls.rsa=(p/'rsa').read_text();cls.ec=(p/'ec').read_text()
  cls.der=subprocess.check_output(['openssl','x509','-in',str(p/'cert'),'-outform','DER'])
  cls.ech=subprocess.check_output([CORE,'generate','ech-keypair','qa.local'],text=True).split('-----BEGIN ECH KEYS-----')[0].strip()+'\n'

 def upload(self,name,content,owner_failure=False,blocked=False):
  with tempfile.TemporaryDirectory() as tmp:
   directory=pathlib.Path(tmp);source=directory/'upload';source.write_bytes(content.encode() if isinstance(content,str) else content)
   target=directory/'certs';target.mkdir();destination=target/f'{name}.pem'
   if blocked:destination.mkdir()
   else:destination.write_text(self.cert)
   options={'upload':str(source),'directory':str(target),'owner':os.getuid(),'group':os.getgid()}
   if owner_failure:options['owner']='hp-nonexistent-test-account'
   script="import {installCertificate} from 'homeproxy_certificates'; print(sprintf('%J',installCertificate("+json.dumps(name)+','+json.dumps(options)+")));"
   r=subprocess.run([UCODE,'-L',str(ROOT/'root/usr/share/ucode/*.uc'),'-L',str(ROOT/'tests/support/*.uc'),'-e',script],capture_output=True,text=True)
   self.assertEqual(r.returncode,0,r.stderr)
   result=json.loads(r.stdout)
   self.assertFalse(list(target.glob('.upload.*')), 'staging directories must be cleaned on success and failure')
   return result,destination.read_text() if destination.is_file() else None,destination.stat().st_mode & 0o777

 def test_real_certificates_keys_and_ech(self):
  for name,content in [('server_publickey',self.cert*2),('client_ca',self.cert.replace('\n','\r\n')),('server_privatekey',self.key),('server_privatekey',self.rsa),('server_privatekey',self.ec),('client_ech_conf',self.ech)]:
   with self.subTest(name=name,header=content.splitlines()[0]):
    result,saved,mode=self.upload(name,content)
    if not result['result']:
     with tempfile.TemporaryDirectory() as debug:
      path=pathlib.Path(debug)/'input.pem';path.write_text(content)
      commands=[['/usr/bin/openssl','version'],['/usr/bin/openssl','x509','-inform','PEM','-in',str(path),'-noout'],['/usr/bin/openssl','pkey','-inform','PEM','-in',str(path),'-passin','pass:','-check','-noout']]
      script="import {execute} from 'homeproxy_runtime'; print(sprintf('%J',map("+json.dumps(commands)+",cmd=>execute(cmd,5000))));"
      probe=subprocess.run([UCODE,'-L',str(ROOT/'root/usr/share/ucode/*.uc'),'-L',str(ROOT/'tests/support/*.uc'),'-e',script],capture_output=True,text=True)
      self.fail(str(result)+'; command diagnostics: '+probe.stdout+' '+probe.stderr)
    self.assertEqual(saved,content.replace('\r\n','\n'));self.assertEqual(mode,0o600)

 def test_invalid_der_and_wrong_types_preserve_old_certificate(self):
  for name,content in [('server_publickey',pem('CERTIFICATE')),('server_publickey','junk -----BEGIN CERTIFICATE----- junk'),('server_publickey',self.cert+pem('CERTIFICATE')),('server_privatekey',pem('PRIVATE KEY')),('server_privatekey',self.cert),('client_ca',self.key),('client_ca',self.der),('client_ech_conf',pem('ECH CONFIGS')),('client_ca',''),('client_ca',b'\x00\xff')]:
   with self.subTest(name=name,content=content[:40]):
    result,saved,_=self.upload(name,content);self.assertFalse(result['result']);self.assertEqual(saved,self.cert)

 def test_ech_rejects_truncated_vectors_and_unsupported_config(self):
  raw=base64.b64decode(''.join(self.ech.splitlines()[1:-1]))
  for length in range(len(raw)):
   with self.subTest(length=length):
    result,saved,_=self.upload('client_ech_conf',pem('ECH CONFIGS',raw[:length]));self.assertFalse(result['result']);self.assertEqual(saved,self.cert)
  for offset in [2,3,7,8]: # ECH version or KEM identifier, preserving outer lengths
   corrupted=bytearray(raw);corrupted[offset]=0xff
   result,saved,_=self.upload('client_ech_conf',pem('ECH CONFIGS',corrupted));self.assertFalse(result['result']);self.assertEqual(saved,self.cert)

 def test_install_failures_and_unknown_target(self):
  result,saved,_=self.upload('unknown',self.cert);self.assertFalse(result['result']);self.assertEqual(saved,self.cert)
  result,saved,_=self.upload('server_publickey',self.cert,owner_failure=True);self.assertFalse(result['result']);self.assertEqual(saved,self.cert)
  result,saved,_=self.upload('server_publickey',self.cert,blocked=True);self.assertFalse(result['result']);self.assertIsNone(saved)
