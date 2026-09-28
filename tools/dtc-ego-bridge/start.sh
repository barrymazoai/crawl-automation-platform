#!/bin/sh
# Manually start the DTC Ego bridge. Usage: start.sh <port> <stateDir> <pauseFile> [spaceName]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
port=$1; state=$2; pause=$3; space=${4:-dtc-bridge}
mkdir -p "$state"
[ -e "$state/STOP" ] && { echo "STOP file present in $state: a previous bridge has not finished stopping" >&2; exit 1; }
curl -sf -H "Host: 127.0.0.1:$port" "http://127.0.0.1:$port/bridge/health" >/dev/null && { echo "a bridge is already serving port $port" >&2; exit 1; }
env_json=$(printf '{"port":%s,"stateDir":"%s","pauseFile":"%s","spaceName":"%s"}' "$port" "$state" "$pause" "$space")
{ printf 'globalThis.BRIDGE_ENV = %s;\n' "$env_json"; cat "$here/bridge.js"; } > "$state/bridge.run.js"
nohup "$HOME/.local/bin/ego-browser" nodejs < "$state/bridge.run.js" >> "$state/bridge.out" 2>&1 &
# The script runs inside an ego Helper (Node) process, not this CLI; stop it with "$state/STOP".
echo $! > "$state/cli.pid"
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; curl -sf -H "Host: 127.0.0.1:$port" "http://127.0.0.1:$port/bridge/health" && { echo; echo "bridge serving http://127.0.0.1:$port/"; exit 0; }; done
echo "bridge did not come up; see $state/bridge.out" >&2; exit 1
