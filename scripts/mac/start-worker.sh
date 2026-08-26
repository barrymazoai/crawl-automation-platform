#!/bin/zsh
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
cd "${0:A:h}/../.."
set -a
source .env.mac-worker
set +a
if [[ ! -f apps/backend/dist/mac-worker.js ]]; then
  pnpm build
fi
exec pnpm --filter @crawl-automation/backend start:worker
