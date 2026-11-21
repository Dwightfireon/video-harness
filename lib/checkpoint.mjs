/* 完整执行现场只保存在项目私有状态中；工具开始/结果分别落盘，不自动重放不确定副作用。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const taskDir = (project, id) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id || '')) throw new Error('无效任务身份');
  return path.join(project, 'out', '.vh-tasks', id);
};
export const checkpointPath = (project, id) => path.join(taskDir(project, id), 'checkpoint.json');
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
export function readCheckpoint(project, id) {
  const file = checkpointPath(project, id);
  if (!fs.existsSync(file)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('任务检查点无法读取，已停止；不会静默从头生成'); }
  if (data.schemaVersion !== 1 || data.taskId !== id || !Array.isArray(data.messages) || !data.messages.length ||
      !Array.isArray(data.pending) || data.pending.some(p => !p.call?.id || !['planned', 'executing', 'done'].includes(p.status))) {
    throw new Error('任务检查点格式无效，已停止；不会静默从头生成');
  }
  const awaiting = new Set();
  for (const message of data.messages) {
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role) ||
        (message.content != null && typeof message.content !== 'string')) throw new Error('检查点消息格式无效，未恢复');
    if (message.role === 'tool') {
      if (!awaiting.delete(message.tool_call_id)) throw new Error('检查点工具结果不匹配，未恢复');
    } else {
      if (awaiting.size) throw new Error('检查点工具消息链不完整，未恢复');
      for (const call of message.tool_calls || []) {
        if (!call.id || awaiting.has(call.id)) throw new Error('检查点工具身份无效，未恢复');
        awaiting.add(call.id);
      }
    }
  }
  const unfinished = data.pending.filter(p => p.status !== 'done').map(p => p.call.id);
  if (awaiting.size !== unfinished.length || unfinished.some(id => !awaiting.has(id))) throw new Error('检查点待执行工具不匹配，未恢复');
  return data;
}
export function writeCheckpoint(project, data) {
  if (!fs.existsSync(project)) throw new Error('项目已移走或删除，停止写入检查点');
  // 同一逻辑任务可有多次执行；上一进程不得覆盖新 attempt 的现场。
  if (data.attemptId) {
    let task;
    try { task = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8')); } catch {}
    if (!task || task.id !== data.taskId || task.attemptId !== data.attemptId) throw new Error('任务已被新的执行接管，停止旧进程');
    if (!['starting', 'running'].includes(task.status)) throw new Error('任务已停止，旧进程不再推进');
  }
  atomicJSON(checkpointPath(project, data.taskId), { ...data, updatedAt: Date.now() });
}

/* Completion is a two-part commit: the agent first persists a `finalizing`
 * checkpoint with the answer, then the worker registers the task as completed.
 * Only after that must the checkpoint claim to be completed. A crash between
 * the two leaves a resumable/finalizable task instead of "canResume but 原任务已结束". */
export function commitCheckpointCompletion(project, id, attemptId) {
  const cp = readCheckpoint(project, id);
  if (!cp || cp.attemptId !== attemptId || cp.status !== 'finalizing') return null;
  let task;
  try { task = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8')); } catch { return null; }
  if (!task || task.id !== id || task.attemptId !== attemptId || task.status !== 'completed') return null;
  const next = { ...cp, status: 'completed', completionPending: false, updatedAt: Date.now() };
  atomicJSON(checkpointPath(project, id), next);
  return next;
}

export function fileRecoveryContext(project) {
  const names = ['materials/选题.md', 'materials/原文.md', 'PROGRESS.md', '方案.md', '脚本.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', 'scene.html', 'timing.json', 'out/video.mp4', 'out/video-voice.mp4'];
  const inventory = names.map(name => {
    try { const s = fs.statSync(path.join(project, name)); return name + '：存在，' + s.size + ' 字节'; }
    catch { return name + '：尚无'; }
  });
  return '【旧任务接续：没有可用的历史执行检查点，不是精确恢复】\n' +
    '这是原项目和原目标的继续，不要创建新项目，不要重新初始化或从头改写脚本。\n' +
    '先只读检查 materials/ 中的原始材料、PROGRESS.md、现有文件与 vh status，以实际文件为准，不盲信进度勾选；识别已完成与过期步骤，只推进缺失或确需重做的部分。\n' +
    '旧工具执行结果无法确认时，先检查产物，不能假定没执行并直接重放。\n现有产物清单：\n' + inventory.join('\n');
}
