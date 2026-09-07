#!/usr/bin/env bash
# start.sh — launch the omp web console from any directory.
# Env: OMP_UI_PORT=8090  OMP_UI_HOST=127.0.0.1  OMP_UI_TOKEN=<hex>
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/server.mjs"
