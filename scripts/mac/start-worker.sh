#!/bin/zsh
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
cd "${0:A:h}/../.."
set -a
source .env.mac-worker
set +a
# Node 25 honors NODE_USE_ENV_PROXY. A stale local proxy can leave launchd alive
# while every register/heartbeat request fails. Prefer verified direct access;
# retain the configured proxy only when Railway cannot be reached directly.
if /usr/bin/curl --noproxy "*" --fail --silent --show-error --max-time 10 "${CONTROL_PLANE_URL%/}/healthz" >/dev/null; then
  export NODE_USE_ENV_PROXY=0
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
fi
if [[ ! -f apps/backend/dist/mac-worker.js ]]; then
  pnpm build
fi
exec pnpm --filter @crawl-automation/backend start:worker
