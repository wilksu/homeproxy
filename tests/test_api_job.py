"""Direct stream children are reclaimed on cancellation or CGI parent exit."""
import os,pathlib,subprocess,tempfile,time,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class APIStreamTests(unittest.TestCase):
 def test_cancel_and_parent_exit_terminate_child(self):
  for parent_exit in [False,True]:
   with self.subTest(parent_exit=parent_exit),tempfile.TemporaryDirectory() as tmp:
    p=pathlib.Path(tmp);job=p/'job.fixture';job.mkdir();(job/'request').write_text('')
    pidfile=p/'child.pid';fake=p/'curl';fake.write_text(f'#!/bin/sh\necho $$ > "{pidfile}"\nexec sleep 60\n');fake.chmod(0o755)
    worker=p/'worker';worker.write_text((ROOT/'root/etc/homeproxy/scripts/api-stream.sh').read_text().replace('/tmp/homeproxy-api-streams',str(p)).replace('/usr/bin/curl',str(fake)))
    parent=subprocess.Popen(['sleep','60']);process=subprocess.Popen(['sh',str(worker),str(job),str(parent.pid)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
     for _ in range(100):
      if pidfile.exists():break
      time.sleep(.01)
     child=int(pidfile.read_text())
     if parent_exit:parent.terminate();parent.wait()
     else:process.terminate()
     process.wait(timeout=4)
     self.assertFalse(job.exists())
     with self.assertRaises(ProcessLookupError):os.kill(child,0)
    finally:
     if parent.poll() is None:parent.terminate();parent.wait()
     if process.poll() is None:process.terminate();process.wait()
