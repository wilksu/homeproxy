"""Exercise the transaction state machine without touching real services or UCI."""
import os,pathlib,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class TransactionTests(unittest.TestCase):
 def test_lifecycle(self):
  for state in ['0 0','1 0','0 1','1 1']:
   for scenario in ['valid','noop','invalid','concurrent','fetch-failed','restart-failed','rollback-conflict','disabled']:
    for proxy,resources in [('0','0'),('1','0'),('0','1'),('1','1')]:
     with self.subTest(state=state,scenario=scenario,proxy=proxy,resources=resources),tempfile.TemporaryDirectory() as tmp:
      p=pathlib.Path(tmp);(p/'config').mkdir();(p/'config/homeproxy').write_text('original');(p/'bin').mkdir()
      source=(ROOT/'root/etc/homeproxy/scripts/subscription-transaction.sh').read_text().replace('/etc/config',str(p/'config')).replace('/var/run/homeproxy',str(p/'run')).replace('/etc/init.d/homeproxy',str(p/'service'))
      (p/'transaction').write_text(source)
      (p/'service').write_text('''#!/bin/sh
printf '%s:%s:%s\\n' "$1" "${HP_START_CLIENT:-}" "${HP_START_SERVER:-}" >> "$ACTIONS"
if [ "$1" = restart ]; then
 if [ "$SCENARIO" = rollback-conflict ]; then echo user-edit > "$ORIGINAL"; exit 1; fi
 [ "$SCENARIO" != restart-failed ] && [ "$SCENARIO" != disabled ] || exit 1
fi
exit 0
''');(p/'service').chmod(0o755)
      (p/'bin/uci').write_text('''#!/bin/sh
case "$*" in
 *changes*) exit 0;;
 *export*) cat "$HP_UCI_CONF_DIR/homeproxy";;
 *update_via_proxy*) echo "$VIA_PROXY";;
 *routing_mode*) echo custom;;
 *default_outbound*) if [ "$SCENARIO" = disabled ]; then echo nil; else echo node; fi;;
 *enabled*) echo 0;;
esac
''');(p/'bin/uci').chmod(0o755)
      (p/'bin/ucode').write_text('''#!/bin/sh
case "$*" in
 *"-e "*) echo "$SERVICE_STATE";;
 *update_subscriptions.uc*)
  [ "$SCENARIO" != fetch-failed ] || exit 1
  [ "$SCENARIO" != noop ] || exit 0
  echo candidate > "$HP_UCI_CONF_DIR/homeproxy"
  if [ "$SCENARIO" = concurrent ]; then echo user-edit > "$ORIGINAL"; fi;;
 *generate_client.uc*) echo '{}' > "$HP_OUTPUT_DIR/sing-box-c.json";;
 *validate.uc*) [ "$SCENARIO" != invalid ];;
esac
''');(p/'bin/ucode').chmod(0o755)
      r=subprocess.run(['sh',str(p/'transaction')],env={**os.environ,'PATH':str(p/'bin')+':'+os.environ['PATH'],'SCENARIO':scenario,'ORIGINAL':str(p/'config/homeproxy'),'ACTIONS':str(p/'actions'),'SERVICE_STATE':state,'VIA_PROXY':proxy,'HP_RESOURCES_CHANGED':resources},capture_output=True,text=True)
      client,server=state.split();activation=client=='1' and (scenario in ['valid','restart-failed','rollback-conflict','disabled'] or scenario=='noop' and resources=='1')
      failed=scenario in ['invalid','concurrent','fetch-failed'] or (activation and scenario not in ['valid','noop'])
      self.assertEqual(r.returncode!=0,failed,r.stderr)
      conflict=activation and scenario=='rollback-conflict'
      value='user-edit' if scenario=='concurrent' or conflict else 'original' if failed or scenario=='noop' else 'candidate'
      self.assertEqual((p/'config/homeproxy').read_text().strip(),value)
      actions=(p/'actions').read_text().splitlines() if (p/'actions').exists() else []
      expected=['stop::'] if client=='1' and proxy=='0' else []
      if activation:expected.append(f'restart:{client}:{server}')
      if activation and failed and not conflict:expected+=['stop::',f'start:{client}:{server}']
      elif client=='1' and proxy=='0' and not activation:expected.append(f'start:{client}:{server}')
      self.assertEqual(actions,expected)
      leftovers=list((p/'run').iterdir())
      self.assertEqual(bool(leftovers),conflict)
      self.assertFalse(list((p/'config').glob('.homeproxy-*')))
