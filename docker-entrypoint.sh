#!/bin/sh
# Container start: make the data volume writable (hosted disks are often mounted root-owned), drop to the unprivileged
# "node" user, then run migrations/seed/admin bootstrap and the server.
set -e
DATA_DIR="${MOULDCARE_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$0" "$@"
fi
if [ "$MOULDCARE_SEED_DEMO" = "true" ]; then node backend/scripts/seed.js; fi
# MouldCare Monitor in the same container (one service instead of two): it listens on 127.0.0.1:3300 with its database
# in $DATA_DIR/monitor, and this server forwards /monitor to it. It is restarted if it stops; the platform keeps running.
if [ "$MONITOR_EMBED" = "true" ]; then
  export MOULDCARE_MONITOR_URL="http://127.0.0.1:3300"
  export MONITOR_MOULDCARE_URL="${MONITOR_MOULDCARE_URL:-http://127.0.0.1:${PORT:-3100}}"
  ( while true; do PORT=3300 MONITOR_DATA_DIR="$DATA_DIR/monitor" node monitor/server/index.js; echo "MouldCare Monitor stopped; restarting in 5 s" >&2; sleep 5; done ) &
fi
node backend/scripts/bootstrap-admin.js
exec node backend/server.js
