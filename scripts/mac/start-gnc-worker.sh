#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

readonly REPO_ROOT="/Users/barry/apps/crawl-platform-v3-test"
readonly SHARED_SECRET_ENV="/Users/barry/apps/crawl-platform-v2/.env.mac-worker"

cd "${REPO_ROOT}"

# Keep secrets on the Mac mini. The dedicated GNC worker reuses only the
# existing credentials/endpoints, then overrides its own non-secret scope.
set -a
source "${SHARED_SECRET_ENV}"
set +a

export CONTROL_PLANE_URL="${GNC_CONTROL_PLANE_URL:-http://127.0.0.1:8791}"
export NODE_ID="mac-mini-gnc-1"
export NODE_NAME="Mac mini GNC Worker"
export NODE_CAPABILITIES="gnc,cleanup"
export NODE_SOURCE_ADAPTERS="gnc"
export NODE_MAX_CONCURRENCY="1"
export CODEX_CONCURRENCY="1"
export OCR_IMAGE_CONCURRENCY="4"
export GNC_MAX_ITEMS="5000"
export WORK_ROOT="${REPO_ROOT}/runs/gnc"
export LOCAL_STATE_DB="${REPO_ROOT}/state/gnc-worker.sqlite"
export REPOSITORY_ROOT="${REPO_ROOT}"
export SALES_CHANNEL_CHROME_PROFILE_ROOT="${REPO_ROOT}/state/chrome-gnc"
export GNC_PDF_RENDER_SCRIPT="${REPO_ROOT}/scripts/mac/render-pdf-pages.swift"
export SALES_CHANNEL_EGRESS_ENABLED="true"
export SALES_CHANNEL_EGRESS_STATE_DB="${REPO_ROOT}/state/sales-channel-egress.sqlite"
export SALES_CHANNEL_EGRESS_PROFILE_ROOT="${REPO_ROOT}/state/sales-channel-egress-chrome"
export SALES_CHANNEL_CLASH_CONFIG_FILE="/Users/barry/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml"
export SALES_CHANNEL_CLASH_CONTROLLER_URL="http://127.0.0.1:9097"
export GNC_EGRESS_POOL="us-residential-4"
export GNC_EGRESS_SELECTOR="GNC出口"
export GNC_EGRESS_EXITS="texas=美国德州ip,washington=美国华盛顿ip,los-angeles=美国洛杉矶ip,redmond=美国雷德蒙德ip"
export GNC_EGRESS_BATCH_SIZE="20"
export GNC_EGRESS_CHALLENGE_COOLDOWN_MS="600000"
export GNC_EGRESS_NETWORK_FAILURE_COOLDOWN_MS="120000"
export GNC_EGRESS_MAX_FAILURE_RETRIES="4"

if /usr/bin/curl --noproxy "*" --fail --silent --show-error --max-time 10 "${CONTROL_PLANE_URL%/}/healthz" >/dev/null; then
  export NODE_USE_ENV_PROXY=0
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
fi

exec pnpm --filter @crawl-automation/backend start:worker
