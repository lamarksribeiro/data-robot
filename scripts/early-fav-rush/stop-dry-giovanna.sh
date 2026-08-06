#!/bin/sh
# Para só o early-fav-rush-dry; não toca scalp-dry.
PID=$(docker exec pair-path-micro sh -c 'pgrep -f "node scripts/early-fav-rush/early-fav-rush-dry.js"' | head -1)
if [ -n "$PID" ]; then
  echo "killing container pid $PID"
  docker exec pair-path-micro kill "$PID"
  sleep 1
else
  echo "early-fav-rush-dry nao estava rodando"
fi
echo "=== remaining ==="
docker top pair-path-micro 2>/dev/null | grep -E 'early-fav|scalp-dry|sleep' || true
