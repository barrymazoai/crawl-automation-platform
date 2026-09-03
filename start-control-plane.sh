#!/bin/bash
# 启动本地控制面（在 mini 部署根目录运行）。端口与库在 .env.control-plane 里。
# 之前这个进程是手动 `ssh bash -s` 起的孤儿，改代码后没人记得重启，导致 worker 一直被旧校验拒绝。
set -e
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd "$(dirname "$0")"
ROOT="$PWD"
set -a; source "$ROOT/.env.control-plane"; set +a
PORT="${PORT:-8792}"
for pid in $(pgrep -f "dist/index.js"); do
  if ps -Eo command= -p "$pid" 2>/dev/null | grep -q "PORT=$PORT "; then kill "$pid" 2>/dev/null || true; fi
done
sleep 2
cd "$ROOT/apps/backend"
nohup node dist/index.js >> "$ROOT/logs/control-plane-v2.log" 2>&1 &
echo "control-plane PORT=$PORT PID=$!"
sleep 4
curl -s -m 5 "http://127.0.0.1:$PORT/healthz" && echo
