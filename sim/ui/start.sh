#!/usr/bin/env bash
# start.sh — start the omp web console as a background service (idempotent).
#   ui/start.sh                 start if not running
#   ui/start.sh --foreground    run in the foreground (Ctrl+C stops)
#   ui/stop.sh                  stop it
# Env: OMP_UI_PORT=8090  OMP_UI_HOST=127.0.0.1  OMP_UI_TOKEN=<hex>
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/.server-pid"
LOG_FILE="$DIR/console.log"
PORT="${OMP_UI_PORT:-8090}"

pidAlive() { [[ -f $PID_FILE ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

if pidAlive; then
  echo "already running (pid $(cat "$PID_FILE")) — http://localhost:$PORT"
  echo "stop it with: ui/stop.sh"
  exit 0
fi
rm -f "$PID_FILE"
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  # port busy — is it our own console (pidfile lost / older version without one)?
  pid=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP '(?<=pid=)\d+' | head -1 || true)
  if [[ -n $pid ]] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "server.mjs"; then
    echo "already running (pid $pid) — http://localhost:$PORT"
    echo "stop it with: ui/stop.sh"
    exit 0
  fi
  echo "ERROR: port $PORT is in use by another process." >&2
  echo "  stop it first, or run with OMP_UI_PORT=<other port>" >&2
  exit 1
fi

if [[ ${1:-} == "--foreground" ]]; then
  exec node "$DIR/server.mjs"
fi

nohup node "$DIR/server.mjs" >>"$LOG_FILE" 2>&1 &
PID=$!
sleep 1
if ! kill -0 "$PID" 2>/dev/null; then
  echo "failed to start — last log lines:" >&2
  tail -5 "$LOG_FILE" >&2
  exit 1
fi
echo "omp console running: http://localhost:$PORT  (pid $PID)"
echo "token: $(cat "$DIR/.ui-token" 2>/dev/null || echo '(printed in the log)')"
echo "logs:  tail -f $LOG_FILE"
echo "stop:  ui/stop.sh"
