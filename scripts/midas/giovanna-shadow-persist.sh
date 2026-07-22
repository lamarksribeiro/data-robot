#!/bin/sh
# Roda dentro do container engine: shadow longo + finalize em volume persistente.
set -e
mkdir -p /usr/src/app/runs/midas-shadow
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG=/usr/src/app/runs/midas-shadow/sprint-${STAMP}.log
DONE=/usr/src/app/runs/midas-shadow/sprint-${STAMP}.done
PIDFILE=/usr/src/app/runs/midas-shadow/sprint-${STAMP}.pid

# encerra sprint anterior se existir (pid numérico apenas)
if [ -f /tmp/midas-shadow.pid ]; then
  OLD=$(cat /tmp/midas-shadow.pid)
  case "$OLD" in
    *[!0-9]*) ;;
    *)
      if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
        kill "$OLD" 2>/dev/null || true
        sleep 1
        kill -9 "$OLD" 2>/dev/null || true
      fi
      ;;
  esac
fi

nohup node scripts/midas/shadow-sprint.js --target=5 --timeout=28800 --interval=50 >"$LOG" 2>&1 &
SPID=$!
echo "$SPID" > /tmp/midas-shadow.pid
echo "$SPID" > "$PIDFILE"
printf '%s\n%s\n' "$STAMP" "$LOG" > /usr/src/app/runs/midas-shadow/LATEST

nohup sh -c "
  while kill -0 $SPID 2>/dev/null; do sleep 10; done
  sleep 2
  {
    echo stamp=$STAMP
    echo finished_at=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo log=$LOG
    echo lines=\$(wc -l < $LOG)
    echo enters=\$(grep -c ENTER $LOG || true)
    grep -E 'resultado|\"ok\"|ENTER' $LOG | tail -n 40 || true
    echo '--- tail ---'
    tail -n 80 $LOG
  } > $DONE
  cp -f $DONE /usr/src/app/runs/midas-shadow/LAST.done
  echo ready > /usr/src/app/runs/midas-shadow/READY
" >/usr/src/app/runs/midas-shadow/watcher-${STAMP}.log 2>&1 &
echo $! > /usr/src/app/runs/midas-shadow/watcher.pid

sleep 3
kill -0 "$SPID"
echo "SHADOW_OK pid=$SPID stamp=$STAMP"
echo "LOG=$LOG"
head -n 6 "$LOG"
