#!/bin/bash
# 同步 → 构建 → 停全部 worker → 起全部 worker。
# 必须原子：以前只重启改动相关的池子，别的池子继续跑旧代码，
# "改了没效果"反复出现（实测处理池比构建落后两小时）。
#
# 用法：
#   ./deploy.sh                 全量：同步+构建+重启全部 worker
#   ./deploy.sh --no-restart    只同步+构建，不碰任何正在跑的 worker
#   ./deploy.sh --only <name>   同步+构建，只重启 dist/workers/<name>.js 这一个 worker
#
# 这是部署的唯一入口，禁止手打 rsync/ssh 部署命令。
# rsync 永远不带 --delete：mini 上有本地不存在的活数据目录（.automation-runs 等），
# 2026-09-02 一条手打的 rsync --delete 删掉了 5563 个已抓取未处理的 Swanson 产品。
set -e
HOST=${DEPLOY_HOST:-barry@192.168.0.25}
ROOT=${DEPLOY_ROOT:-apps/crawl-platform-v4-parallel}
MODE=all
ONLY=
case "${1:-}" in
  --no-restart) MODE=none ;;
  --only) MODE=only; ONLY=${2:?"--only 需要 worker 名，如 capture-gnc-scraperapi"} ;;
  "") ;;
  *) echo "未知参数: $1" >&2; exit 1 ;;
esac
cd "$(dirname "$0")"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude 'apps/web/dist' \
  --exclude state --exclude logs --exclude runs --exclude exports \
  apps packages start-workers.sh start-workers-cloud.sh start-control-plane.sh "$HOST:$ROOT/"
ssh -o BatchMode=yes "$HOST" "bash -s" <<REMOTE
set -e
export PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH
cd $ROOT
if [ "$MODE" = all ]; then
  for w in capture-gnc capture-swanson capture-amazon capture-dtc capture-gnc-scraperapi text image unify finalize; do
    pkill -f "dist/workers/\$w.js" 2>/dev/null || true
  done
  pkill -f "sales-channel-egress-chrome" 2>/dev/null || true
elif [ "$MODE" = only ]; then
  pkill -f "dist/workers/$ONLY.js" 2>/dev/null || true
fi
pnpm -r --filter "@crawl-automation/contracts" --filter "@crawl-automation/runtime" --filter "@crawl-automation/backend" build 2>&1 | grep -E "error" || true
if [ "$MODE" = all ]; then
  ./start-control-plane.sh
  ./start-workers.sh
elif [ "$MODE" = only ]; then
  ./start-workers.sh "$ONLY"
fi
stat -f "dist 构建 %Sm" -t "%H:%M:%S" apps/backend/dist/workers/text.js
if [ "$MODE" != none ]; then
  echo "worker 启动时间："
  for pid in \$(pgrep -f "dist/workers/"); do echo "  \$(ps -o lstart= -p \$pid | xargs) \$(ps -o command= -p \$pid | grep -o 'workers/[a-z-]*')"; done
fi
REMOTE
