#!/bin/bash
# 双击关闭「发布台」。平时直接关窗口就够了，这个只在窗口无响应时用。
#
# 只关闭本仓库这个 desk/main.mjs 进程，绝不使用应用名脚本：
# 本机 B 站桌面端同样是 Electron，按名字操作会误关别人的窗口（真实事故）。
# 同样不能只匹配 "desk/main.mjs" —— 其它目录下的同名启动脚本也不该被波及。
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd -P)"
TARGET="$ROOT/desk/main.mjs"

# pgrep -f 接收正则；把路径里的元字符转义，并要求完整路径两侧是空白/引号或行首尾。
# 只转义不够：`/x/desk/main.mjs-backup` 或 `/tmp/x/x/desk/main.mjs` 也会被子串命中。
ESCAPED=$(printf '%s' "$TARGET" | sed -e 's/[][\\.^$*+?(){}|]/\\&/g')
PATTERN="(^|[[:space:]\"'])$ESCAPED([[:space:]\"']|$)"
PIDS=$(pgrep -f -- "$PATTERN" 2>/dev/null)
if [ -z "$PIDS" ]; then
  echo "发布台没有在运行。"
  sleep 1
  exit 0
fi

# 先请它正常退出；3 秒内没退出才强制结束。
for PID in $PIDS; do kill -TERM "$PID" 2>/dev/null; done

for _ in 1 2 3 4 5 6; do
  pgrep -f -- "$PATTERN" >/dev/null 2>&1 || { echo "发布台已关闭。"; exit 0; }
  sleep 0.5
done

for PID in $PIDS; do kill -KILL "$PID" 2>/dev/null; done
sleep 1
pgrep -f -- "$PATTERN" >/dev/null 2>&1 && echo "仍有进程未退出，请手动检查。" || echo "发布台已关闭。"
