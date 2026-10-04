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
node backend/scripts/bootstrap-admin.js
exec node backend/server.js
