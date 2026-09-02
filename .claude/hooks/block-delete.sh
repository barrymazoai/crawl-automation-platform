#!/bin/bash
# PreToolUse hook：任何带删除语义的 Bash 命令在执行前被拒绝（退出码 2）。
# 检查的是整条命令文本，ssh 远程命令、heredoc 里的 node/python 脚本一并覆盖。
# 2026-09-02 一条手打的 rsync --delete 删掉了 mini 上 5563 个已抓取的产品，此后删除一律由人手动执行。
cmd=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
[ -z "$cmd" ] && exit 0
patterns=(
  '(^|[[:space:];&|(`"'"'"'])(rm|rmdir|unlink|shred|srm|trash)([[:space:]]|$)'
  'rsync.*--del'
  'find.*[[:space:]]-delete'
  'git[[:space:]]+clean'
  'git[[:space:]]+checkout[[:space:]]+--[[:space:]]'
  'git[[:space:]]+reset[[:space:]]+--hard'
  '\.(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\('
  'rimraf|del-cli'
  'shutil\.rmtree|os\.(remove|unlink|rmdir|removedirs)|\.unlink\('
  '\bdelete[[:space:]]+from\b|\bdrop[[:space:]]+(table|database|schema|index)\b|\btruncate[[:space:]]+(table|only)?\b'
)
for p in "${patterns[@]}"; do
  if printf '%s' "$cmd" | grep -Eiq -- "$p"; then
    echo "拒绝执行：命令含删除语义（匹配 /$p/）。删除操作一律由用户手动执行，不由 Claude 代劳。" >&2
    exit 2
  fi
done
exit 0
