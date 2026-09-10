"""Actual curl fetch: direct HTTP versus SOCKS5 remote name resolution."""
import json,os,pathlib,socket,subprocess,threading,unittest
from test_generator import ROOT,UCODE
@unittest.skipUnless(UCODE,'UCODE required')
class FetchTests(unittest.TestCase):
 def test_explicit_download_paths(self):
  source=(ROOT/'root/etc/homeproxy/scripts/update_subscriptions.uc').read_text();a=source.index('const proxyArgs');b=source.index('\n\t\tif (isEmpty(res))',a);body=source[a:b]
  for proxy in ['0','1']:
   with self.subTest(proxy=proxy),socket.socket() as listener:
    listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(5);port=listener.getsockname()[1];observed=[]
    def server():
     with listener.accept()[0] as c:
      c.settimeout(5)
      def recv(n):
       data=b''
       while len(data)<n:
        chunk=c.recv(n-len(data))
        if not chunk:raise RuntimeError('short SOCKS request')
        data+=chunk
       return data
      if proxy=='1':
       hello=recv(2);recv(hello[1]);observed.append(hello);c.sendall(b'\x05\x00');header=recv(5);size=header[4];data=b''
       while len(data)<size+2:data+=c.recv(size+2-len(data))
       observed.append(data[:-2].decode());c.sendall(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x50')
      observed.append(c.recv(4096));c.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture')
    t=threading.Thread(target=server,daemon=True);t.start()
    url='http://subscription.test/feed' if proxy=='1' else f'http://127.0.0.1:{port}/feed'
    script="import {executeCommand,shellQuote} from 'homeproxy';const uciconfig='homeproxy';const user_agent='fixture';const via_proxy="+json.dumps(proxy)+";const url="+json.dumps(url)+";const uci={get:()=>"+str(port)+"};"+body+"print(res);"
    p=subprocess.run([UCODE,'-L',str(ROOT/'tests/support/*.uc'),'-L',str(ROOT/'root/etc/homeproxy/scripts/*.uc'),'-e',script],capture_output=True,text=True,timeout=8)
    t.join(timeout=5);self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(p.stdout,'fixture')
    if proxy=='1':self.assertEqual(observed[1],'subscription.test')
    self.assertIn(b'GET /feed',observed[-1])
