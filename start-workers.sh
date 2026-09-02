#!/bin/bash
# 启动 worker 池（在 mini 部署根目录运行）。每个池一个进程、固定的 NODE_ID 与并发度。
# 用法：./start-workers.sh            起全部
#       ./start-workers.sh <池名>     只（重）起这一个
# 池的参数固化在这里，随仓库走；不要在命令行里临时拼。
set -e
# 固化 PATH：非交互 ssh 调用时 node 不在默认 PATH 里
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd "$(dirname "$0")"
ROOT="$PWD"
set -a; source "$ROOT/.env.worker"; set +a
cd "$ROOT/apps/backend"

# 池名:NODE_ID:并发度   （capture-gnc 走浏览器+住宅 IP 那条线已停用，GNC 改走 ScraperAPI）
POOLS="capture-swanson:barrydeMac-mini-capture-swanson:1 capture-gnc-scraperapi:barrydeMac-mini-gnc-scraperapi:1 text:barrydeMac-mini-text:12 image:barrydeMac-mini-image:3 unify:barrydeMac-mini-unify:2 finalize:barrydeMac-mini-finalize:1"
only="${1:-}"

for entry in $POOLS; do
  pool="${entry%%:*}"
  if [ -n "$only" ] && [ "$only" != "$pool" ]; then continue; fi
  pkill -f "dist/workers/$pool.js" 2>/dev/null || true
done
sleep 3

for entry in $POOLS; do
  pool="${entry%%:*}"; rest="${entry#*:}"
  node_id="${rest%%:*}"; conc="${rest##*:}"
  if [ -n "$only" ] && [ "$only" != "$pool" ]; then continue; fi
  NODE_ID="$node_id" NODE_NAME="$node_id" NODE_MAX_CONCURRENCY="$conc" \
    nohup node "dist/workers/$pool.js" >> "$ROOT/logs/$pool.log" 2>&1 &
  echo "$pool  NODE_ID=$node_id 并发=$conc  PID=$!"
  sleep 1
done
