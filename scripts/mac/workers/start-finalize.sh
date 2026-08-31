#!/bin/zsh
# 收尾 / 入库 / 清理
# 对应入口：apps/backend/src/workers/finalize.ts
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
cd "${0:A:h}/../../.."
set -a
source "${WORKER_ENV_FILE:-.env.worker}"
set +a
export NODE_ID="${NODE_ID:-$(hostname -s)-finalize}"
export NODE_MAX_CONCURRENCY="1"
export CODEX_CONCURRENCY="1"
if /usr/bin/curl --noproxy "*" --fail --silent --max-time 10 "${CONTROL_PLANE_URL%/}/healthz" >/dev/null; then
  export NODE_USE_ENV_PROXY=0
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
fi
[[ -f apps/backend/dist/workers/finalize.js ]] || pnpm build
exec pnpm --filter @crawl-automation/backend worker:finalize
