#!/bin/zsh
# v2 并行流水线 Pool 启动器（方案 4：一个 Pool = 一个独立 worker 进程）。
# 用法: start-v2-pool.sh <pool>
#   pool ∈ capture-gnc | capture-amazon | text | image | unify | finalize
# 每个 Pool 读取仓库根目录的 .env.v2-<pool>（模板见本目录 env-templates/）。
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
POOL="${1:?用法: start-v2-pool.sh <pool>}"
cd "${0:A:h}/../../.."
ENV_FILE=".env.v2-${POOL}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "缺少 ${ENV_FILE}（模板见 scripts/mac/v2/env-templates/）" >&2
  exit 1
fi
set -a
source "${ENV_FILE}"
set +a
if /usr/bin/curl --noproxy "*" --fail --silent --show-error --max-time 10 "${CONTROL_PLANE_URL%/}/healthz" >/dev/null; then
  export NODE_USE_ENV_PROXY=0
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
fi
if [[ ! -f apps/backend/dist/mac-worker.js ]]; then
  pnpm build
fi
exec pnpm --filter @crawl-automation/backend start:worker
