#!/usr/bin/env node
/* 只读监测：跟踪当前任务的阶段变化、卡住、结束与发布包状态。
 * 不写项目文件、不重启任务、不取消进程；只把变化写到指定的日志里。 */
import fs from 'node:fs';
import path from 'node:path';
import { taskStatus } from '../lib/task-status.mjs';
import { publishStatus } from '../lib/publish.mjs';
import { artifactStatus } from '../lib/artifact-status.mjs';

const project = process.argv[2];
if (!project || !fs.existsSync(path.join(project, 'PROJECT.json'))) {
  console.error('用法：node scripts/watch-project.mjs <项目目录> [最多分钟]');
  process.exit(2);
}
const minutes = Math.min(180, Math.max(1, Number(process.argv[3]) || 40));
const deadline = Date.now() + minutes * 60000;
const logFile = process.argv[4] ? path.resolve(process.argv[4]) : null;
const say = line => { const text = `[${new Date().toLocaleTimeString('zh-CN')}] ${line}`; console.log(text); if (logFile) try { fs.appendFileSync(logFile, text + '\n'); } catch {} };

let last = null, lastStage = null, lastStalled = false, lastStatus = null, done = false;
const snapshot = () => {
  const task = taskStatus(project), pub = publishStatus(project), video = artifactStatus(project).deliverable;
  return { task, pub, video };
};

say(`开始监测 ${path.basename(project)}（最多 ${minutes} 分钟；只读，不改文件、不取消任务）`);
const first = snapshot();
say(`初始：${first.task.status} · 阶段 ${first.task.stage || '—'} · 发布文案 ${first.pub.revision?.state || '—'} · 视频 ${first.video.stale ? '过期/' + first.video.reason : '有效'}`);
lastStatus = first.task.status; lastStage = first.task.stage;

while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 10000));
  let snap;
  try { snap = snapshot(); } catch (e) { say('读取状态失败：' + e.message + '（继续观察，不视为任务失败）'); continue; }
  const { task, pub, video } = snap;
  if (task.stage && task.stage !== lastStage) { say(`阶段切换：${lastStage || '—'} → ${task.stage}`); lastStage = task.stage; }
  if (!!task.stalled !== lastStalled) {
    say(task.stalled ? '⚠ 主日志与工具日志都超过 90 秒没有更新：可能真的卡住' : '恢复活动：后台工具或日志重新有更新');
    lastStalled = !!task.stalled;
  }
  if (task.status !== lastStatus) {
    say(`任务状态：${lastStatus} → ${task.status}` + (task.error?.message ? `；原因：${task.error.message}` : ''));
    lastStatus = task.status;
  }
  last = snap;
  if (!task.running && task.status !== 'starting') { done = true; break; }
}

const final = last || snapshot();
say('监测结束。最终状态：' + final.task.status
  + ' · 阶段 ' + (final.task.stage || '—')
  + ' · 视频 ' + (final.video.stale ? '未通过：' + final.video.reason : '有效')
  + ' · 发布文案 ' + (final.pub.ok ? '机械检查通过' : '未通过：' + final.pub.errors.map(e => e.message).join('；'))
  + ' · 文案版本 ' + (final.pub.revision?.state || '—'));
if (!done) say('（到达监测时限，任务仍在运行；没有中断它）');
if (final.pub.revision?.state === 'stale') say('提示：文案仍关联旧稿。确认内容后可点「已核对文案，关联当前稿」，只关联版本、不改正文。');
process.exit(0);
