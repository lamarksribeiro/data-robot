#!/bin/sh
# Reinicia só o early-fav-rush-dry (não toca no scalp-dry).
# Código esperado em /usr/src/app/scripts/early-fav-rush (já docker cp'd).

# Pattern específico do node (não do próprio pkill/sh -c).
docker exec pair-path-micro sh -c 'kill $(pgrep -f "node scripts/early-fav-rush/early-fav-rush-dry.js") 2>/dev/null' || true
sleep 1
docker exec -d pair-path-micro sh -c \
  'node scripts/early-fav-rush/early-fav-rush-dry.js --budget=5 --max-events=40 --fill=honest --poll-ms=50 --timeout=14400 --cross=majority --disaster=1 > /tmp/early-fav-rush-dry.log 2>&1'
sleep 3
echo "=== processes ==="
docker top pair-path-micro 2>/dev/null | grep -E 'early-fav|scalp-dry|sleep' || true
echo "=== log ==="
docker exec pair-path-micro tail -n 40 /tmp/early-fav-rush-dry.log || true
