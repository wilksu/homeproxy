import os, pathlib, subprocess, tempfile, unittest
from test_generator import ROOT


class MaintenanceTests(unittest.TestCase):
 def test_cron_passes_resource_changes_without_a_second_restart(self):
  for statuses,changed in [('3333','0'),('1233','0'),('0333','1'),('3303','1'),('0000','1')]:
   with self.subTest(statuses=statuses),tempfile.TemporaryDirectory() as tmp:
    p=pathlib.Path(tmp)
    resources='''#!/bin/sh
echo "$1" >> "$FIXTURE/calls"
case "$1" in china_ip4) n=1;; china_ip6) n=2;; gfw_list) n=3;; china_list) n=4;; esac
exit "$(printf '%s' "$STATUSES" | cut -c "$n")"
'''
    subscription='#!/bin/sh\necho "$HP_RESOURCES_CHANGED" > "$FIXTURE/changed"\n'
    for name,body in [('update_resources.sh',resources),('subscription-transaction.sh',subscription)]:
     (p/name).write_text(body);(p/name).chmod(0o755)
    source=(ROOT/'root/etc/homeproxy/scripts/update_crond.sh').read_text().replace('/etc/homeproxy/scripts',tmp)
    r=subprocess.run(['sh','-c',source],env={**os.environ,'FIXTURE':tmp,'STATUSES':statuses},capture_output=True,text=True)
    self.assertEqual(r.returncode,0,r.stderr)
    self.assertEqual((p/'changed').read_text().strip(),changed)
    self.assertEqual(len((p/'calls').read_text().splitlines()),4)
