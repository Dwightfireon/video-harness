import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskStatus, activeTool, toolActive } from '../lib/task-status.mjs';
import { beginTask, updateTask } from '../lib/task-status.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-stall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out/.vh-tool-logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  return dir;
}
function staleMainLog(dir) {
  const log = path.join(dir, 'out/.vh-chat.log');
  fs.writeFileSync(log, '══ 用户 10:00:00（CLI ask · article）：做片\n· run_stage {"stage":"render"}\n');
  const old = Date.now() - 10 * 60 * 1000;
  fs.utimesSync(log, new Date(old), new Date(old));
}

test('长时间渲染会持续写工具日志：不能仅凭主日志静默就判卡住', t => {
  const dir = fixture(t), task = beginTask(dir, '改造片尾', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  staleMainLog(dir);
  const running = path.join(dir, 'out/.vh-tool-logs/123-abcd.log');
  fs.writeFileSync(running, '正在编码第 6 段…\n');
  fs.utimesSync(running, new Date(), new Date());
  const status = taskStatus(dir);
  assert.equal(status.stalled, false, '后台工具仍在写日志，不该报 90 秒无动作');
  assert.equal(status.activeTool?.recent, true);
  assert.equal(toolActive(dir), true);
});

test('工具日志也停止更新才判卡住，并保留最后活动时间供界面说明', t => {
  const dir = fixture(t), task = beginTask(dir, '改造片尾', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  staleMainLog(dir);
  const idle = path.join(dir, 'out/.vh-tool-logs/123-abcd.log');
  fs.writeFileSync(idle, '卡住了\n');
  const old = Date.now() - 5 * 60 * 1000;
  fs.utimesSync(idle, new Date(old), new Date(old));
  const status = taskStatus(dir);
  assert.equal(status.stalled, true, '主日志和工具日志都长时间无更新，应提示可能卡住');
  assert.equal(status.activeTool?.recent, false);
});

test('没有任何工具日志时退回主日志判定，不把刚启动的任务误判', t => {
  const dir = fixture(t), task = beginTask(dir, '改造片尾', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  const log = path.join(dir, 'out/.vh-chat.log');
  fs.writeFileSync(log, '刚启动\n');
  fs.utimesSync(log, new Date(), new Date());
  assert.equal(taskStatus(dir).stalled, false);
});
