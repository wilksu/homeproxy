#!/bin/sh
# Run the source overlay on the archived development image.
set -eu
cd "$(dirname "$0")/.."

compose() {
 if [ -n "${HP_DEV_COMPOSE_OVERRIDE:-}" ]; then
  docker compose -f compose.yaml -f "$HP_DEV_COMPOSE_OVERRIDE" "$@"
 else
  docker compose -f compose.yaml "$@"
 fi
}

restore_image() {
 image=$(compose config --images)
 if docker image inspect "$image" >/dev/null 2>&1; then
  return
 fi
 snapshot=.dev/core-1.14
 if [ ! -f "$snapshot/image.tar" ] || [ ! -f "$snapshot/manifest.json" ]; then
  echo "Missing development image $image. Restore $snapshot from the previous machine." >&2
  return 1
 fi
 python3 - "$snapshot" "$image" <<'PY'
import hashlib
import json
import pathlib
import sys

snapshot = pathlib.Path(sys.argv[1])
image = sys.argv[2]
manifest = json.loads((snapshot / 'manifest.json').read_text())
if manifest['image'] != image:
    sys.exit(f'Missing development image {image}. Load the selected image first.')
with (snapshot / 'image.tar').open('rb') as archive:
    digest = hashlib.file_digest(archive, 'sha256').hexdigest()
if digest != manifest['artifacts']['image.tar']:
    sys.exit('Development image archive checksum mismatch.')
PY
 docker image load --input "$snapshot/image.tar"
 docker image inspect "$image" >/dev/null
}

case "${1:-up}" in
 up) docker version --format '{{.Server.Version}}' >/dev/null; restore_image; compose up -d --no-build --wait --wait-timeout 120 ;;
 status) compose ps -a ;;
 smoke) compose exec -T openwrt /bin/sh /opt/homeproxy-dev/smoke-core.sh ;;
 stop) compose stop ;;
 down) compose down ;;
 logs) compose logs --tail 100 -f ;;
 shell) compose exec openwrt /bin/sh ;;
 *) echo 'Usage: scripts/dev.sh up|status|smoke|stop|down|logs|shell' >&2; exit 1 ;;
esac
