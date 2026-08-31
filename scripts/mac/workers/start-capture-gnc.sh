#!/bin/zsh
# GNC 抓取（唯一带 IP 轮动与 Chrome 的进程）
# 对应入口：apps/backend/src/workers/capture-gnc.ts
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
cd "${0:A:h}/../../.."
set -a
source "${WORKER_ENV_FILE:-.env.worker}"
set +a
export NODE_ID="${NODE_ID:-$(hostname -s)-capture-gnc}"
export NODE_MAX_CONCURRENCY="1"
if /usr/bin/curl --noproxy "*" --fail --silent --max-time 10 "${CONTROL_PLANE_URL%/}/healthz" >/dev/null; then
  export NODE_USE_ENV_PROXY=0
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
fi
[[ -f apps/backend/dist/workers/capture-gnc.js ]] || pnpm build
exec pnpm --filter @crawl-automation/backend worker:capture-gnc
