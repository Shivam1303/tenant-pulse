#!/usr/bin/env bash
# Starts the Tenant Pulse API service and the Next.js web app together.
#
#   ./run.sh          development mode (hot reload)
#   ./run.sh prod     production build, then start
#
# Ports: WEB_PORT (default 3000) and API_PORT (default 4174).
set -euo pipefail

cd "$(dirname "$0")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found in $NVM_DIR. Install nvm or set NVM_DIR." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
nvm use 24

if [ ! -d web/node_modules ]; then
  echo "Installing web dependencies…"
  npm --prefix web install
fi

case "${1:-dev}" in
  dev)
    exec npm run dev
    ;;
  prod | start)
    npm run build
    exec npm start
    ;;
  *)
    echo "Usage: ./run.sh [dev|prod]" >&2
    exit 1
    ;;
esac
