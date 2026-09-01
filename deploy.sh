#!/bin/bash
# 同步 → 构建 → 停全部 worker → 起全部 worker。
# 必须原子：以前只重启改动相关的池子，别的池子继续跑旧代码，
# "改了没效果"反复出现（实测处理池比构建落后两小时）。
set -e
HOST=${DEPLOY_HOST:-barry@192.168.0.25}
ROOT=${DEPLOY_ROOT:-apps/crawl-platform-v4-parallel}
cd "$(dirname "$0")"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude 'apps/web/dist' \
  --exclude state --exclude logs --exclude runs --exclude exports \
  apps packages "$HOST:$ROOT/"
ssh -o BatchMode=yes "$HOST" "bash -s" <<REMOTE
set -e
export PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH
cd $ROOT
for w in capture-gnc capture-swanson capture-amazon capture-dtc text image unify finalize; do
  pkill -f "dist/workers/\$w.js" 2>/dev/null || true
done
pkill -f "sales-channel-egress-chrome" 2>/dev/null || true
pnpm -r --filter "@crawl-automation/contracts" --filter "@crawl-automation/backend" build 2>&1 | grep -E "error" || true
./start-workers.sh
stat -f "dist %Sm" -t "%H:%M:%S" apps/backend/dist/workers/text.js
REMOTE
