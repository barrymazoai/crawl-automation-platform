#!/bin/bash
# 部署到 Mac mini：同步 → 构建 → 停全部 worker → 起全部 worker。
#
# 必须是原子的：以前每次只重启改动相关的那个池子，别的池子继续跑旧代码，
# 于是"改了没效果"反复出现——2026-09-01 实测处理池比构建落后了两个小时。
set -e
HOST=${DEPLOY_HOST:-barry@192.168.0.25}
ROOT=${DEPLOY_ROOT:-~/apps/crawl-platform-v4-parallel}
cd "$(dirname "$0")"

echo "▸ 本地测试"
npx vitest run --root apps/backend 2>&1 | tail -3

echo "▸ 同步代码"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude 'apps/web/dist' \
  --exclude state --exclude logs --exclude runs --exclude exports \
  apps packages "$HOST:$ROOT/"

ssh -o BatchMode=yes "$HOST" "bash -s" <<REMOTE
set -e
export PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH
cd $ROOT

echo "▸ 停全部 worker（等在跑的 job 交回租约）"
for w in capture-gnc capture-swanson capture-amazon capture-dtc text image unify finalize; do
  pkill -f "dist/workers/\$w.js" 2>/dev/null || true
done
pkill -f "sales-channel-egress-chrome" 2>/dev/null || true
sleep 5

echo "▸ 构建"
pnpm -r --filter "@crawl-automation/contracts" --filter "@crawl-automation/backend" build 2>&1 | grep -E "Build complete|error" | tail -3

echo "▸ 重启控制面"
pkill -f "dist/index.js" 2>/dev/null || true
sleep 2
set -a; source .env.control-plane; set +a
cd apps/backend && nohup node dist/index.js >> ../../logs/control-plane-v2.log 2>&1 &
cd $ROOT
sleep 4

echo "▸ 起全部 worker"
./start-workers.sh

sleep 8
echo "▸ 版本核对（构建时间 vs 各进程启动时间，必须一致）"
stat -f "  dist            %Sm" -t "%H:%M:%S" apps/backend/dist/workers/text.js
for w in capture-gnc capture-swanson text image unify finalize; do
  pid=\$(pgrep -f "dist/workers/\$w.js" | head -1)
  [ -n "\$pid" ] && echo "  \$(printf '%-16s' \$w) \$(ps -p \$pid -o lstart= | awk '{print \$4}')"
done
REMOTE
echo "▸ 部署完成"
