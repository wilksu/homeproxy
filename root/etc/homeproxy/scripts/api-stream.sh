#!/bin/sh
# A bounded stream and a parent watchdog; no response buffering on disk.
job="$1"
parent="$2"
case "$job" in /tmp/homeproxy-api-streams/job.*) ;; *) exit 1;; esac
case "$parent" in ''|*[!0-9]*) exit 1;; esac
umask 077
/usr/bin/curl --config "$job/request" 2>"$job/error" &
child=$!
cleanup() {
 kill "$child" "$watcher" 2>/dev/null
 wait "$child" "$watcher" 2>/dev/null
 rm -rf "$job"
}
trap 'cleanup; exit' INT TERM HUP
(
 while kill -0 "$child" 2>/dev/null; do
  if ! kill -0 "$parent" 2>/dev/null; then kill "$child" 2>/dev/null; break; fi
  sleep 1
 done
) &
watcher=$!
wait "$child"
result=$?
cleanup
exit "$result"
