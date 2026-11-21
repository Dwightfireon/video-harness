#!/bin/bash
# 双击这个文件就能打开视频工作台（不用记命令）
# 如果服务已经在跑，就只打开浏览器。

cd "$(dirname "$0")" || exit 1

PORT=8144
URL="http://127.0.0.1:$PORT"

echo "== vh 视频工作台 =="
echo "目录：$(pwd)"
echo

# 已经在跑？直接开浏览器
if curl -s -o /dev/null --max-time 2 "$URL/"; then
  echo "服务已经在运行，正在打开浏览器：$URL"
  open "$URL"
  echo
  read -n 1 -s -r -p "按任意键关闭这个窗口（服务会继续运行）…"
  exit 0
fi

# 检查 node
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。请先安装 Node.js（https://nodejs.org），再双击本文件。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo "正在启动服务…（这个窗口不要关，关了服务就停了；按 Ctrl+C 停止）"
echo
node vh.mjs preview --port "$PORT" --open
