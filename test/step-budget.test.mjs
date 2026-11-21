import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, readStepBudget, DEFAULT_STEP_BUDGET } from '../lib/agent.mjs';
import { beginTask, updateTask, resumeTask, readTask, taskStatus, finishTask } from '../lib/task-status.mjs';
import { readCheckpoint } from '../lib/checkpoint.mjs';
import { loadWorklog, worklogBlock, recordTool } from '../lib/worklog.mjs';

const providers = [{ name: 'opendesign', key: 'fixture', base: 'http://fixture.invalid' }];
const tempProject = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-budget-'));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const toolCall = (id, name = 'list_files', args = { path: '.' }) => ({
  choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});

test('步数预算可配置，默认远高于旧的 120', () => {
  assert.equal(DEFAULT_STEP_BUDGET, 400);
  assert.equal(readStepBudget({}), 400);
  assert.equal(readStepBudget({ VH_AGENT_STEPS: '250' }), 250);
  assert.equal(readStepBudget({ VH_AGENT_STEPS: '0' }), 400);
  assert.equal(readStepBudget({ VH_AGENT_STEPS: 'abc' }), 400);
});

test('超过 120 步不再中断：达到预算后标记 paused，检查点可继续', async t => {
  const dir = tempProject(t);
  let calls = 0;
  const result = await runAgent(dir, '长任务', { taskId: 'budget-task', mode: 'edit-visual', stepBudget: 130,
    providers, request: async () => toolCall('c' + (++calls)) });
  assert.equal(calls, 130);
  assert.equal(result.status, 'paused');
  assert.equal(result.ok, false);
  assert.match(result.paused, /130 步上限/);
  const checkpoint = readCheckpoint(dir, 'budget-task');
  assert.equal(checkpoint.status, 'paused');
  assert.equal(checkpoint.messages.filter(m => m.role === 'tool').length, 130);
  assert.doesNotMatch(result.warns.join('\n'), /网络|额度/);
});

test('继续已暂停的任务：从原进度接着做，不重做已有步骤', async t => {
  const dir = tempProject(t), task = beginTask(dir, '原目标', 'edit-visual');
  // 第一次：暂停
  const first = await runAgent(dir, '原目标', { taskId: task.id, attemptId: task.attemptId, mode: 'edit-visual', stepBudget: 3,
    providers, request: async () => toolCall('a' + Math.random()) });
  assert.equal(first.status, 'paused');
  finishTask(dir, task.id, first, task.attemptId);
  assert.equal(taskStatus(dir).status, 'paused');
  assert.equal(taskStatus(dir).canResume, true);
  assert.match(taskStatus(dir).resumeNotice, /步数上限|继续/);
  // 第二次：继续并完成
  const resumed = resumeTask(dir);
  assert.equal(resumed.id, task.id);
  const seen = [];
  const second = await runAgent(dir, '原目标', { taskId: resumed.id, attemptId: resumed.attemptId, mode: 'edit-visual',
    resume: true, stepBudget: 50, providers, log: () => {},
    request: async (_p, messages) => { seen.push(messages.length); return { choices: [{ message: { role: 'assistant', content: '完成' } }] }; } });
  assert.equal(second.status, 'completed');
  const tools = readCheckpoint(dir, task.id).messages.filter(m => m.role === 'tool').length;
  assert.equal(tools, 3, '继续后没有重跑前面三步');
  assert.ok(seen[0] > 3);
});

test('暂停不算失败：错误为空、可继续，且不会被读成 interrupted', async t => {
  const dir = tempProject(t), task = beginTask(dir, '原目标', 'topic');
  updateTask(dir, task.id, { status: 'paused', pausedReason: '达到步数上限', finishedAt: Date.now() }, task.attemptId);
  const status = taskStatus(dir);
  assert.equal(status.status, 'paused');
  assert.equal(status.error, null);
  assert.equal(status.running, false);
  assert.equal(status.canResume, true);
  assert.match(status.resumeNotice, /步数上限/);
});

test('工作台账记录写入与命令，给模型的摘要不含用户正文', async t => {
  const dir = tempProject(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '一'.repeat(500));
  recordTool(dir, { taskId: 't1', tool: 'write_file', target: '脚本.md', ok: true });
  recordTool(dir, { taskId: 't1', tool: 'run', target: 'node vh.mjs measure', ok: true, note: 'exit=0' });
  const entries = loadWorklog(dir);
  assert.equal(entries.length, 2);
  const block = worklogBlock(dir);
  assert.match(block, /脚本\.md/); assert.match(block, /当前 1500 字节/);
  assert.match(block, /node vh\.mjs measure/);
  assert.doesNotMatch(block, /一一一一一/, '不把文件内容塞进台账');
});

test('同一目标连续动作只保留最新一条，台账不会线性膨胀', async t => {
  const dir = tempProject(t);
  for (let i = 0; i < 30; i++) recordTool(dir, { taskId: 't', tool: 'write_file', target: '脚本.md', ok: true });
  const entries = loadWorklog(dir).filter(e => e.target === '脚本.md');
  assert.equal(entries.length, 1);
});

test('系统提示带上台账，模型不必靠重读找状态', async t => {
  const dir = tempProject(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), 'x'.repeat(120));
  recordTool(dir, { taskId: 't', tool: 'write_file', target: '脚本.md', ok: true });
  let system = '';
  await runAgent(dir, '继续', { taskId: 'ledger-task', mode: 'edit-visual', providers,
    request: async (_p, messages) => { system = messages[0].content; return { choices: [{ message: { role: 'assistant', content: '好' } }] }; } });
  assert.match(system, /本任务已做过的动作/);
  assert.match(system, /脚本\.md.*当前 120 字节/);
});

test('未改动文件在最近几步内重复读取返回提示；隔得久了仍会真正返回内容', async t => {
  const dir = tempProject(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '固定内容');
  let calls = 0; const results = [];
  const result = await runAgent(dir, '读两次', { taskId: 'read-cache', mode: 'edit-visual', stepBudget: 20, providers,
    request: async (_p, messages) => {
      calls++;
      if (calls === 1) return toolCall('r1', 'read_file', { path: '脚本.md' });
      if (calls === 2) {
        results.push(messages.find(m => m.tool_call_id === 'r1').content);
        return toolCall('r2', 'read_file', { path: '脚本.md' });
      }
      if (calls === 3) {
        results.push(messages.find(m => m.tool_call_id === 'r2').content);
        return toolCall('r3', 'read_file', { path: '脚本.md' });
      }
      results.push(messages.find(m => m.tool_call_id === 'r3').content);
      return { choices: [{ message: { role: 'assistant', content: '完成' } }] };
    } });
  assert.equal(result.status, 'completed');
  assert.equal(results[0], '固定内容');
  assert.match(results[1], /未改动/);
  // 第三次与第二次只隔一步，仍可跳过；关键是永远不会返回"空内容"。
  assert.ok(results[2] === '固定内容' || /未改动/.test(results[2]));
});

test('画面修改对话可以结束，但缺少当前预览仍标记未交付，不被旧视频替代', async t => {
  const dir = tempProject(t), task = beginTask(dir, '检查产物', 'edit-visual');
  fs.writeFileSync(path.join(dir, '脚本.md'), '新脚本');
  fs.writeFileSync(path.join(dir, 'out/video-voice.mp4'), 'video');
  const old = Date.now() - 100000;
  fs.utimesSync(path.join(dir, 'out/video-voice.mp4'), new Date(old), new Date(old));
  const result = await runAgent(dir, '检查产物', { taskId: task.id, attemptId: task.attemptId, mode: 'edit-visual', providers,
    request: async () => ({ choices: [{ message: { role: 'assistant', content: '完成' } }] }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.deliverable.kind, 'preview');
  assert.equal(result.deliverable.stale, true);
  assert.match(result.deliverable.reason, /scene\.html 不存在/);
  finishTask(dir, task.id, result, task.attemptId);
  assert.match(taskStatus(dir).deliverableStale, /scene\.html 不存在/);
});

test('伪成片即使时间戳比源文件新，也不能通过媒体验收', async t => {
  const dir = tempProject(t), task = beginTask(dir, '检查产物', 'edit');
  fs.writeFileSync(path.join(dir, '脚本.md'), '旧脚本');
  const older = Date.now() - 100000;
  fs.utimesSync(path.join(dir, '脚本.md'), new Date(older), new Date(older));
  fs.writeFileSync(path.join(dir, 'out/video-voice.mp4'), 'video');
  const result = await runAgent(dir, '检查产物', { taskId: task.id, attemptId: task.attemptId, mode: 'edit', providers,
    request: async () => ({ choices: [{ message: { role: 'assistant', content: '完成' } }] }) });
  assert.equal(result.deliverable.stale, true);
  assert.match(result.deliverable.reason, /缺失|无效|损坏|渲染/);
});
