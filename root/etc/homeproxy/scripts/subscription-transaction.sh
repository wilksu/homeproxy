#!/bin/sh
# Stage and validate updates; preserve stopped instances and roll back activation errors.
set -eu
umask 077
scripts=/etc/homeproxy/scripts
root=/var/run/homeproxy
mkdir -p "$root"
lock="$root/subscription-update.lock"
mkdir "$lock" 2>/dev/null || { echo 'Subscription update already running' >&2; exit 1; }
work='' install_file='' stopped=0 committed=0 activating=0 keep_recovery=0
client_was_running=0 server_was_running=0
restore_instances() {
 HP_START_CLIENT="$client_was_running" HP_START_SERVER="$server_was_running" /etc/init.d/homeproxy start
}
replace_config() {
 install_file=$(mktemp /etc/config/.homeproxy-subscription.XXXXXX) || return 1
 cat "$1" > "$install_file" || return 1
 chmod 600 "$install_file" || return 1
 mv "$install_file" /etc/config/homeproxy || return 1
 install_file=''
}
finish() {
 result=$?
 trap - EXIT HUP INT TERM
 unset HP_UCI_CONF_DIR HP_UCI_SAVE_DIR HP_OUTPUT_DIR HP_SUBSCRIPTION_STAGED
 if [ "$committed" = 1 ]; then
  if cmp -s /etc/config/homeproxy "$work/config/homeproxy" && [ -z "$(uci changes homeproxy)" ]; then
   if ! replace_config "$work/original"; then keep_recovery=1; result=1; fi
  elif ! cmp -s /etc/config/homeproxy "$work/original"; then
   echo 'Configuration changed during activation; rollback will not overwrite newer edits' >&2
   keep_recovery=1; result=1
  fi
 fi
 if [ "$keep_recovery" = 0 ] && { [ "$stopped" = 1 ] || [ "$activating" = 1 ]; }; then
  if [ "$activating" = 1 ]; then /etc/init.d/homeproxy stop || true; fi
  if ! restore_instances; then keep_recovery=1; result=1; fi
 fi
 [ -z "$install_file" ] || rm -f "$install_file"
 if [ "$keep_recovery" = 1 ]; then echo "Recovery configuration retained at $work/original" >&2
 elif [ -n "$work" ]; then rm -rf "$work"; fi
 rmdir "$lock"
 exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
work=$(mktemp -d "$root/subscription.XXXXXX")
mkdir "$work/config" "$work/save" "$work/output"
[ -z "$(uci changes homeproxy)" ] || { echo 'Save or discard pending HomeProxy changes first' >&2; exit 1; }
cp /etc/config/homeproxy "$work/original"
cp "$work/original" "$work/config/homeproxy"
state=$(ucode -e 'import {connect} from "ubus"; const services=connect().call("service","list",{name:"homeproxy"}); if(type(services)!=="object")die("Unable to read service state"); const s=services.homeproxy?.instances; printf("%d %d",s?.["sing-box-c"]?.running ? 1 : 0,s?.["sing-box-s"]?.running ? 1 : 0);')
case "$state" in '0 0'|'0 1'|'1 0'|'1 1') ;; *) echo 'Unable to determine service state' >&2; exit 1;; esac
client_was_running=${state% *}; server_was_running=${state#* }
export HP_UCI_CONF_DIR="$work/config" HP_UCI_SAVE_DIR="$work/save" HP_OUTPUT_DIR="$work/output" HP_SUBSCRIPTION_STAGED=1
uci -c "$HP_UCI_CONF_DIR" -P "$HP_UCI_SAVE_DIR" export homeproxy > "$work/original.export"
via_proxy=$(uci -c "$HP_UCI_CONF_DIR" -q get homeproxy.subscription.update_via_proxy || true)
if [ "$via_proxy" != 1 ] && [ "$client_was_running" = 1 ]; then
 stopped=1
 /etc/init.d/homeproxy stop
fi
ucode "$scripts/update_subscriptions.uc"
uci -c "$HP_UCI_CONF_DIR" -P "$HP_UCI_SAVE_DIR" export homeproxy > "$work/candidate.export"
if cmp -s "$work/original.export" "$work/candidate.export"; then
 echo 'Subscription configuration unchanged'
 # Resource lists feed DNS/firewall generation even when the nodes are unchanged.
 if [ "${HP_RESOURCES_CHANGED:-0}" = 1 ] && [ "$client_was_running" = 1 ]; then
  unset HP_UCI_CONF_DIR HP_UCI_SAVE_DIR HP_OUTPUT_DIR HP_SUBSCRIPTION_STAGED
  activating=1
  HP_START_CLIENT="$client_was_running" HP_START_SERVER="$server_was_running" /etc/init.d/homeproxy restart
  activating=0 stopped=0
 fi
 exit 0
fi
mode=$(uci -c "$HP_UCI_CONF_DIR" -P "$HP_UCI_SAVE_DIR" -q get homeproxy.config.routing_mode)
if [ "$mode" = custom ]; then node=$(uci -c "$HP_UCI_CONF_DIR" -P "$HP_UCI_SAVE_DIR" -q get homeproxy.routing.default_outbound)
else node=$(uci -c "$HP_UCI_CONF_DIR" -P "$HP_UCI_SAVE_DIR" -q get homeproxy.config.main_node); fi
[ "$node" = nil ] || ucode "$scripts/generate_client.uc"
enabled=$(uci -c "$HP_UCI_CONF_DIR" -P "$HP_UCI_SAVE_DIR" -q get homeproxy.server.enabled || true)
[ "$enabled" != 1 ] || ucode "$scripts/generate_server.uc"
set --
for candidate in "$HP_OUTPUT_DIR"/sing-box-*.json; do [ ! -f "$candidate" ] || set -- "$@" "$candidate"; done
[ "$#" -eq 0 ] || ucode "$scripts/validate.uc" "$@"
# Check again just before atomic replacement; never restore over concurrent edits.
install_file=$(mktemp /etc/config/.homeproxy-subscription.XXXXXX)
cat "$work/config/homeproxy" > "$install_file"
chmod 600 "$install_file"
cmp -s /etc/config/homeproxy "$work/original" && [ -z "$(uci changes homeproxy)" ] || { echo 'Configuration changed during update; retry' >&2; exit 1; }
committed=1
mv "$install_file" /etc/config/homeproxy
install_file=''
unset HP_UCI_CONF_DIR HP_UCI_SAVE_DIR HP_OUTPUT_DIR HP_SUBSCRIPTION_STAGED
# Updating a stopped service must not start it, including fully disabled setups.
if [ "$client_was_running" = 1 ]; then
 activating=1
 HP_START_CLIENT="$client_was_running" HP_START_SERVER="$server_was_running" /etc/init.d/homeproxy restart
fi
committed=0 activating=0 stopped=0
