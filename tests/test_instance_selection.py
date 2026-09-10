"""Execute the real init preparation and firewall generator with isolated inputs."""
import json, os, pathlib, subprocess, tempfile, unittest
from test_generator import ROOT, UCODE


class InstanceSelectionTests(unittest.TestCase):
 def test_prepare_skips_dormant_invalid_instance(self):
  source=(ROOT/'root/etc/init.d/homeproxy').read_text()
  prepare=source[source.index('prepare_configs_inner()'):source.index('install_configs()')]
  for client,server,bad,success in [('1','0','server',True),('0','1','client',True),('1','1','server',False),('1','1','client',False),('unset','unset','server',False)]:
   with self.subTest(client=client,server=server,bad=bad),tempfile.TemporaryDirectory() as tmp:
    p=pathlib.Path(tmp);(p/'scripts').mkdir();(p/'run').mkdir()
    (p/'scripts/prepare.sh').write_text('#!/bin/sh\nexit 0\n');(p/'scripts/prepare.sh').chmod(0o755)
    script='''set -eu
CONF=homeproxy
HP_DIR="$FIXTURE"
RUN_DIR="$FIXTURE/run"
LOG_PATH="$FIXTURE/log"
HP_PREPARED_DIR=''
config_load() { :; }
config_get() { case "$3" in routing_mode) eval "$1=global";; main_node) eval "$1=node";; esac; }
config_get_bool() { eval "$1=1"; }
log() { :; }
ucode() {
 case "$2" in
  *generate_client.uc) instance=client;;
  *generate_server.uc) instance=server;;
  *validate.uc) return 0;;
 esac
 echo "$instance" >> "$FIXTURE/generated"
 [ "$instance" != "$BAD" ] || return 1
 echo '{}' > "$HP_OUTPUT_DIR/sing-box-$instance.json"
}
'''+prepare+'\nprepare_configs\n'
    env={**os.environ,'FIXTURE':tmp,'BAD':bad}
    for key,value in [('HP_START_CLIENT',client),('HP_START_SERVER',server)]:
     env.pop(key,None)
     if value!='unset':env[key]=value
    r=subprocess.run(['sh','-c',script],env=env,capture_output=True,text=True)
    self.assertEqual(r.returncode==0,success,r.stderr)
    generated=(p/'generated').read_text().splitlines()
    if success:self.assertEqual(generated,['server' if client=='0' else 'client'])

 @unittest.skipUnless(UCODE,'UCODE is required')
 def test_firewall_uses_same_instance_selection_and_clears_stale_files(self):
  for client,server in [('1','0'),('0','1'),('0','0'),('1','1'),('unset','unset')]:
   with self.subTest(client=client,server=server),tempfile.TemporaryDirectory() as tmp:
    p=pathlib.Path(tmp)
    (p/'homeproxy.uc').write_text("export const RUN_DIR="+json.dumps(tmp)+"; export function isEmpty(v) { return !length(v); }")
    cfg={'config':{'.type':'homeproxy','routing_mode':'custom','proxy_mode':'tun'},'routing':{'.type':'homeproxy','default_outbound':'node'},'server':{'.type':'homeproxy','enabled':'1'},'listener':{'.type':'server','enabled':'1','firewall':'1','port':'16666'}}
    (p/'uci.json').write_text(json.dumps(cfg))
    for name in ['input','forward']:(p/f'fw4_{name}.nft').write_text('stale')
    env={**os.environ,'HP_TEST_UCI':str(p/'uci.json')}
    for key,value in [('HP_START_CLIENT',client),('HP_START_SERVER',server)]:
     env.pop(key,None)
     if value!='unset':env[key]=value
    r=subprocess.run([UCODE,'-L',str(ROOT/'tests/support/*.uc'),'-L',str(p/'*.uc'),str(ROOT/'root/etc/homeproxy/scripts/firewall_pre.uc')],env=env,capture_output=True,text=True)
    self.assertEqual(r.returncode,0,r.stderr)
    contents='\n'.join(f.read_text() for f in p.glob('*.nft'))
    self.assertEqual('singtun0' in contents,client!='0')
    self.assertEqual('16666' in contents,server!='0')
    self.assertNotIn('stale',contents)
