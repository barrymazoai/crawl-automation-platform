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

# 池名:NODE_ID:节点并发:Codex并发   （capture-gnc 走浏览器+住宅 IP 那条线已停用，GNC 改走 ScraperAPI）
# 第 4 段是 CODEX_CONCURRENCY——每个 worker 进程同时能跑的 Codex 调用数（codex.ts 里的 Semaphore）。
# 以前没设，一直是默认值 2：文字线领 24 个任务也只有 2 个在跑 Codex，其余 22 个排在闸门前空等，
# 提节点并发只会把单批耗时拉长（24 → 100 分钟），吞吐纹丝不动（2026-09-03 实测）。
# 节点并发要和闸门匹配：领了却跑不了的任务只是占着租约。
POOLS="capture-swanson:barrydeMac-mini-capture-swanson:1:2 capture-gnc-scraperapi:barrydeMac-mini-gnc-scraperapi:1:2 text:barrydeMac-mini-text:12:8 image:barrydeMac-mini-image:3:2 unify:barrydeMac-mini-unify:2:2 finalize:barrydeMac-mini-finalize:1:2"
only="${1:-}"

# 只杀本套（NODE_ID=barrydeMac-mini-*）的进程：云端那套 worker 入口文件同名，
# 按文件名 pkill 会把它们一起杀掉（2026-09-03 提并发时误杀过 mini-cloud-text）。
for entry in $POOLS; do
  IFS=: read -r pool node_id conc codex <<<"$entry"
  if [ -n "$only" ] && [ "$only" != "$pool" ]; then continue; fi
  for pid in $(pgrep -f "dist/workers/$pool.js"); do
    if ps -Eo command= -p "$pid" 2>/dev/null | grep -q "NODE_ID=$node_id "; then kill "$pid" 2>/dev/null || true; fi
  done
done
sleep 3

for entry in $POOLS; do
  IFS=: read -r pool node_id conc codex <<<"$entry"
  if [ -n "$only" ] && [ "$only" != "$pool" ]; then continue; fi
  NODE_ID="$node_id" NODE_NAME="$node_id" NODE_MAX_CONCURRENCY="$conc" CODEX_CONCURRENCY="$codex" \
    nohup node "dist/workers/$pool.js" >> "$ROOT/logs/$pool.log" 2>&1 &
  echo "$pool  NODE_ID=$node_id 节点并发=$conc Codex并发=$codex  PID=$!"
  sleep 1
done
