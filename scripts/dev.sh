#!/bin/sh
# Operate the stock baseline only; no builds or development substitutions.
set -eu
cd "$(dirname "$0")/.."
case "${1:-up}" in
 up) docker compose up -d --no-build --wait --wait-timeout 120 ;;
 stop) docker compose stop ;;
 down) docker compose down ;;
 logs) docker compose logs --tail 100 -f ;;
 shell) docker compose exec openwrt /bin/sh ;;
 *) echo 'Usage: scripts/dev.sh up|stop|down|logs|shell' >&2; exit 1 ;;
esac
