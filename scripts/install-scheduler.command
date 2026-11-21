#!/bin/bash
# 把定时派发装成 launchd 服务（macOS）。
#
#   ./scripts/install-scheduler.command          安装并立即注册
#   ./scripts/install-scheduler.command --uninstall  卸载
#
# 不写系统级目录，只装当前用户的 ~/Library/LaunchAgents，不需要 sudo。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="app.videoharness.schedule"
PLIST_SRC="$ROOT/scripts/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$ROOT/diagnostics/schedule-daemon.log"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "✓ 已卸载定时派发"
  echo "  队列与项目都保留；手动跑一轮：node scripts/schedule-daemon.mjs --once"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ 找不到 node。先确认 node 在 PATH 里。"
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

if ! command -v opencode >/dev/null 2>&1; then
  echo "✗ 找不到 opencode。定时派发要靠它写稿，先确认 opencode 可用。"
  exit 1
fi

# 队列为空时任务会直接退出，属于正常情况；这里只做一次预检，避免装完才发现路径错。
if ! node "$ROOT/scripts/schedule-daemon.mjs" --dry-run >/dev/null 2>&1; then
  echo "✗ 预检失败：schedule-daemon.mjs --dry-run 没有正常退出。"
  echo "  先手动跑一次看报错：node scripts/schedule-daemon.mjs --dry-run"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/diagnostics"

# 用真实路径重写 plist 里的 node 与仓库位置，避免换 nvm 版本后失效。
sed -e "s#__NODE_BIN__#$NODE_BIN#g" \
    -e "s#__ROOT__#$ROOT#g" \
    -e "s#__NODE_DIR__#$NODE_DIR#g" \
    -e "s#__HOME__#$HOME#g" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "✓ 已安装定时派发：每 30 分钟检查一次队列"
echo "  plist：$PLIST_DST"
echo "  日志：$LOG"
echo
echo "当前队列："
node "$ROOT/vh.mjs" schedule | sed 's/^/  /'
echo
echo "常用："
echo "  launchctl print gui/$(id -u)/$LABEL   看服务状态"
echo "  tail -f $LOG                         看运行日志"
echo "  ./scripts/install-scheduler.command --uninstall  卸载"
echo
echo "注意：只有队列里有 pending 选题、且未达每日上限时才会真的开工。"
echo "     发布仍需在发布台手动确认。"
