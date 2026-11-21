#!/bin/bash
# 双击打开发布台（网页版）：选项目 → 选分区 → 试运行 → 投稿。
#
# 为什么不再是独立 Electron 窗口：投稿逻辑本来就在 desk/ 里、不依赖 Electron，
# 网页工作台可以直接复用同一套。留两套界面只会让"两边字段不一致"变成可能。
# Electron 那版仍保留（npm run desk），但它是备用入口，不是主路径。
set -e
cd "$(dirname "$0")" || exit 1

PORT=8144
URL="http://127.0.0.1:$PORT/publish"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。请先安装 Node.js（https://nodejs.org）。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# 工作台没起就先起一个（后台），已经在跑就直接用。
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/_api/projects"; then
  echo "工作台已在运行：$URL"
else
  echo "正在启动工作台…"
  nohup node vh.mjs preview --port "$PORT" >/tmp/vh-preview.log 2>&1 &
  disown
  for _ in $(seq 1 40); do
    sleep 0.25
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/_api/projects"; then break; fi
  done
fi

open "$URL"
echo "已打开：$URL"
echo "关闭工作台：node vh.mjs stop"
