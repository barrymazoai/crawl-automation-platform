#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

readonly REPO_ROOT="/Users/barry/apps/crawl-platform-v3-test"
readonly SHARED_ADMIN_ENV="/Users/barry/apps/crawl-platform-v2/.env.mac"
readonly SHARED_WORKER_ENV="/Users/barry/apps/crawl-platform-v2/.env.mac-worker"

cd "${REPO_ROOT}"

# Reuse the existing local credentials without copying secrets into this repo.
set -a
source "${SHARED_ADMIN_ENV}"
source "${SHARED_WORKER_ENV}"
set +a

export BACKEND_MODE="control-plane"
export PORT="${LOCAL_CONTROL_PLANE_PORT:-8791}"
export LAN_UI_ENABLED="true"
export WEB_DIST_DIR="${REPO_ROOT}/apps/web/dist"
export DATABASE_URL="${LOCAL_CONTROL_PLANE_DATABASE_URL:-$(node -e 'const url=new URL(process.env.PRODUCT_DATABASE_URL);url.pathname="/crawl_control_plane_local";url.search="";url.hash="";process.stdout.write(url.toString())')}"
unset CONTROL_PLANE_URL CONTROL_PLANE_PROXY_URL
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NODE_USE_ENV_PROXY="0"

exec pnpm --filter @crawl-automation/backend start
