"""Exercise the transaction state machine without touching real services or UCI."""
import os,pathlib,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class TransactionTests(unittest.TestCase):
 def test_lifecycle(self):
  for state in ['0 0','1 0','0 1','1 1']:
   for scenario in ['valid','noop','no-subscriptions','invalid','concurrent','fetch-failed','restart-failed','core-exited','rollback-conflict','disabled']:
    for proxy,resources in [('0','0'),('1','0'),('0','1'),('1','1')]:
     with self.subTest(state=state,scenario=scenario,proxy=proxy,resources=resources),tempfile.TemporaryDirectory() as tmp:
      p=pathlib.Path(tmp);(p/'config').mkdir();(p/'config/homeproxy').write_text('original');(p/'bin').mkdir()
      source=(ROOT/'root/etc/homeproxy/scripts/subscription-transaction.sh').read_text().replace('/etc/config',str(p/'config')).replace('/var/run/homeproxy',str(p/'run')).replace('/etc/init.d/homeproxy',str(p/'service'))
      (p/'transaction').write_text(source)
      (p/'service').write_text('''#!/bin/sh
printf '%s:%s:%s\\n' "$1" "${HP_START_CLIENT:-}" "${HP_START_SERVER:-}" >> "$ACTIONS"
if [ "$1" = restart ]; then
 if [ "$SCENARIO" = rollback-conflict ]; then echo user-edit > "$ORIGINAL"; exit 1; fi
 if [ "$SCENARIO" = core-exited ]; then printf '0 %s' "${SERVICE_STATE#* }" > "$RUNTIME_STATE"; fi
 [ "$SCENARIO" != restart-failed ] && [ "$SCENARIO" != disabled ] || exit 1
fi
if [ "$1" = start ]; then rm -f "$RUNTIME_STATE"; fi
exit 0
''');(p/'service').chmod(0o755)
      (p/'bin/uci').write_text('''#!/bin/sh
case "$*" in
 *changes*) exit 0;;
 *export*) cat "$HP_UCI_CONF_DIR/homeproxy";;
 *update_via_proxy*) echo "$VIA_PROXY";;
 *subscription_url*) [ "$SCENARIO" = no-subscriptions ] || echo 'https://fixture.invalid/subscription';;
 *routing_mode*) echo custom;;
 *default_outbound*) if [ "$SCENARIO" = disabled ]; then echo nil; else echo node; fi;;
 *enabled*) echo 0;;
esac
''');(p/'bin/uci').chmod(0o755)
      (p/'bin/ucode').write_text('''#!/bin/sh
case "$*" in
 *"-e "*) if [ -f "$RUNTIME_STATE" ]; then cat "$RUNTIME_STATE"; else echo "$SERVICE_STATE"; fi;;
 *update_subscriptions.uc*)
  if [ "$SCENARIO" != no-subscriptions ] && [ "${SERVICE_STATE% *}" = 1 ] && [ "$VIA_PROXY" != 1 ]; then
   [ "$(cat "$ACTIONS")" = "stop::" ] || exit 1
  else
   [ ! -s "$ACTIONS" ] || exit 1
  fi
  [ "${HP_SUBSCRIPTION_SOURCE:-}" = "$EXPECTED_SOURCE" ] || exit 1
  [ "$SCENARIO" != fetch-failed ] || exit 1
  case "$SCENARIO" in noop|no-subscriptions) exit 0;; esac
  echo candidate > "$HP_UCI_CONF_DIR/homeproxy"
  if [ "$SCENARIO" = concurrent ]; then echo user-edit > "$ORIGINAL"; fi;;
 *generate_client.uc*) echo '{}' > "$HP_OUTPUT_DIR/sing-box-c.json";;
 *validate.uc*) [ "$SCENARIO" != invalid ];;
esac
''');(p/'bin/ucode').chmod(0o755)
      (p/'bin/sleep').write_text('#!/bin/sh\nexit 0\n');(p/'bin/sleep').chmod(0o755)
      unchanged=scenario in ['noop','no-subscriptions']
      target='src_fixture' if resources=='1' and scenario!='no-subscriptions' else ''
      r=subprocess.run(['sh',str(p/'transaction'),*([target] if target else [])],env={**os.environ,'PATH':str(p/'bin')+':'+os.environ['PATH'],'SCENARIO':scenario,'ORIGINAL':str(p/'config/homeproxy'),'ACTIONS':str(p/'actions'),'SERVICE_STATE':state,'RUNTIME_STATE':str(p/'runtime'),'VIA_PROXY':proxy,'HP_RESOURCES_CHANGED':resources,'EXPECTED_SOURCE':target},capture_output=True,text=True,timeout=10)
      client,server=state.split();activation=client=='1' and (scenario in ['valid','restart-failed','core-exited','rollback-conflict','disabled'] or unchanged and resources=='1')
      failed=scenario in ['invalid','concurrent','fetch-failed'] or (activation and scenario!='valid' and not unchanged)
      self.assertEqual(r.returncode!=0,failed,r.stderr)
      conflict=activation and scenario=='rollback-conflict'
      value='user-edit' if scenario=='concurrent' or conflict else 'original' if failed or unchanged else 'candidate'
      self.assertEqual((p/'config/homeproxy').read_text().strip(),value)
      actions=(p/'actions').read_text().splitlines() if (p/'actions').exists() else []
      stopped=client=='1' and proxy=='0' and scenario!='no-subscriptions'
      expected=['stop::'] if stopped else []
      if activation:expected.append(f'restart:{client}:{server}')
      if activation and failed and not conflict:expected+=['stop::',f'start:{client}:{server}']
      elif stopped and not activation:expected.append(f'start:{client}:{server}')
      self.assertEqual(actions,expected)
      leftovers=list((p/'run').iterdir())
      self.assertEqual(bool(leftovers),conflict)
      self.assertFalse(list((p/'config').glob('.homeproxy-*')))
