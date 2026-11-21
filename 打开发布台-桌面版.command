#!/bin/bash
# 双击打开「发布台」桌面版（Electron）。主路径已改为网页版：双击「打开发布台.command」。
# 这个文件保留作备用入口：网页版打不开、或需要窗口独立于浏览器时用。
#
# 打开后终端窗口会自动关掉，发布台作为独立窗口运行；
# 关闭发布台窗口（或 Cmd+Q）就完全退出，不会留后台进程。
set -e
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。请先安装 Node.js（https://nodejs.org）。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "缺少 Electron 运行时，正在安装（只装一次，约 100MB）…"
  npm install --no-audit --no-fund || { echo "安装失败，请检查网络。"; read -n 1 -s -r -p "按任意键关闭…"; exit 1; }
  if [ ! -x "$ELECTRON_BIN" ]; then
    ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js || true
  fi
fi

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron 安装不完整，请手动执行：npm install"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# 不在脚本里判断“是否已在运行”：应用自身有单实例锁，重复启动会激活已有窗口。
# 也不要使用 `tell application "Electron"` 之类的应用名脚本 —— 本机 B 站桌面端等
# 其它 Electron 应用同名，会误激活甚至误关别人的窗口。

# 后台启动，让终端窗口立刻回到可用状态；发布台是独立窗口。
# 用绝对路径启动：关闭脚本按完整应用路径识别，不会误关其它目录的同名进程。
ROOT="$(pwd -P)"
nohup "$ELECTRON_BIN" "$ROOT/desk/main.mjs" >/dev/null 2>&1 &
disown
exit 0
