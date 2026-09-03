#!/bin/bash
# 启动"连云端控制面"的那套 worker（DTC 线用）。本地那套走 start-workers.sh，两套互不干扰：
# 不同的 NODE_ID、不同的 WORK_ROOT（~/crawl-data/runs-cloud）、不同的 env 文件。
# 用法：./start-workers-cloud.sh            起全部
#       ./start-workers-cloud.sh <池名>     只（重）起这一个
set -e
# 固化 PATH：非交互 ssh 调用时 node 不在默认 PATH 里
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd "$(dirname "$0")"
ROOT="$PWD"
set -a; source "$ROOT/.env.worker.cloud"; set +a
cd "$ROOT/apps/backend"

# 池名:NODE_ID:节点并发:Codex并发   （抓取在美国的 Windows 上，这里只做 DTC 转换和处理线）
# 第 4 段是 CODEX_CONCURRENCY，含义见 start-workers.sh。两条线共用同一个 Codex 账号，云端线给小一点。
POOLS="capture-dtc:mini-cloud-dtc:1:2 text:mini-cloud-text:6:4 image:mini-cloud-image:3:2 unify:mini-cloud-unify:2:2 finalize:mini-cloud-finalize:1:2"
only="${1:-}"

# 只杀本套（NODE_ID=mini-cloud-*）的进程：NODE_ID 是环境变量不在命令行里，pkill -f 匹配不到，
# 得逐个 PID 看 ps -E 的环境。之前这里用 pkill 匹配 NODE_ID，一次都没杀掉，攒了三份重复进程互相抢租约。
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
    nohup node "dist/workers/$pool.js" >> "$ROOT/logs/cloud-$pool.log" 2>&1 &
  echo "$pool  NODE_ID=$node_id 节点并发=$conc Codex并发=$codex  PID=$!"
  sleep 1
done
