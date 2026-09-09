#!/usr/bin/env bash
# stop.sh — stop the omp web console.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/.server-pid"
PORT="${OMP_UI_PORT:-8090}"
stopped=""

if [[ -f $PID_FILE ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  PID=$(cat "$PID_FILE")
  CMD=$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)
  if [[ $CMD == *server.mjs* ]]; then
    kill "$PID" && stopped="pid $PID"
  fi
fi
if [[ -z $stopped ]]; then
  # fallback: find a node server.mjs listening on our port
  line=$(ss -tlnp 2>/dev/null | grep ":$PORT " | head -1 || true)
  pid=$(echo "$line" | grep -oP '(?<=pid=)\d+' | head -1 || true)
  if [[ -n $pid ]] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "server.mjs"; then
    kill "$pid" && stopped="pid $pid (port holder)"
  fi
fi
rm -f "$PID_FILE"
if [[ -n $stopped ]]; then
  echo "stopped ($stopped)"
else
  echo "not running"
fi
