#!/bin/sh
set -e
docker start pair-path-micro >/dev/null || true
docker exec pair-path-micro mkdir -p /usr/src/app/scripts
docker exec pair-path-micro rm -rf /usr/src/app/scripts/early-fav-rush
# Flatten if nested
if [ -d /tmp/early-fav-rush-deploy/early-fav-rush ]; then
  SRC=/tmp/early-fav-rush-deploy/early-fav-rush
else
  SRC=/tmp/early-fav-rush-deploy
fi
docker cp "$SRC" pair-path-micro:/usr/src/app/scripts/early-fav-rush
docker exec pair-path-micro ls -la /usr/src/app/scripts/early-fav-rush
# stop old dry only
docker exec pair-path-micro sh -c 'kill $(pgrep -f "node scripts/early-fav-rush/early-fav-rush-dry.js") 2>/dev/null' || true
sleep 1
docker exec -d pair-path-micro sh -c 'node scripts/early-fav-rush/early-fav-rush-dry.js --budget=5 --max-events=40 --fill=honest --poll-ms=50 --timeout=14400 --cross=majority --disaster=1 > /tmp/early-fav-rush-dry.log 2>&1'
sleep 3
echo "=== processes ==="
docker top pair-path-micro 2>/dev/null | grep -E 'early-fav|scalp-dry|sleep' || true
echo "=== log ==="
docker exec pair-path-micro tail -n 30 /tmp/early-fav-rush-dry.log || true
