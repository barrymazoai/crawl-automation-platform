#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

readonly REPO_ROOT="/Users/barry/apps/crawl-platform-v3-test"
readonly SHARED_SECRET_ENV="/Users/barry/apps/crawl-platform-v2/.env.mac-worker"
readonly OUTPUT_ROOT="${REPO_ROOT}/reports/gnc-company-identity"

cd "${REPO_ROOT}"
set -a
source "${SHARED_SECRET_ENV}"
set +a

export CODEX_MODEL="gpt-5.6-luna"
export CODEX_REASONING_EFFORT="medium"
export NODE_USE_ENV_PROXY=1

exec pnpm --filter @crawl-automation/backend gnc:identity-agent -- \
  --state "${OUTPUT_ROOT}/state.sqlite" \
  --output-dir "${OUTPUT_ROOT}" \
  --matched-companies "${REPO_ROOT}/reports/gnc-company-matches.json" \
  --request-delay-ms "3000" \
  --idle-ms "30000" \
  --max-attempts "3"
