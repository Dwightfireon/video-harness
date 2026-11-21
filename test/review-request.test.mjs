import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { freshInstructionFor } from '../lib/cli-instruction.mjs';
import { isReviewRequest, reviewScopes } from '../lib/review-request.mjs';
import { runVisualReview, reviewSummary } from '../lib/visual-review.mjs';
import { runAgent, makeTools } from '../lib/agent.mjs';
import { beginTask, updateTask, readTask } from '../lib/task-status.mjs';
import { saveState, hashFile } from '../lib/state.mjs';
import { currentArtifactInputs, createArtifactRecord } from '../lib/artifact-status.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const copy = '## 标题\n测试标题\n## 简介\n介绍画面。\n## 置顶评论\n欢迎讨论。\n## 封面文案\n主：测试\n';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  for (const [file, text] of Object.entries({
    'PROJECT.json': '{"deliveryTarget":"video"}',
    '脚本.md': '## S1 · 窗口\n1. 观察一个窗口。\n', '方案.md': '受众基线：知道窗口。', 'claims.json': '[]',
    'scenes.src.js': 'root => { const a = mk("div", "", "窗口"); return { render() {} }; }',
    'engine.tpl.html': 'const ORIENT = "landscape";', 'scene.html': 'const DURATION = 1; const scenes = []; addScene(0,1,root=>({}));',
    'timing.json': '{}', 'timeline.mjs': 'export const scriptGroups=()=>[]; export const validateTiming=()=>({subs:[],total:1});',
    '发布文案.md': copy,
  })) fs.writeFileSync(path.join(dir, file), text);
  saveState(dir, { lastMeasure: { scriptHash: hashFile(path.join(dir, '脚本.md')) } });
  for (const [name, audio] of [['video.mp4', false], ['video-voice.mp4', true]]) {
    const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=64x36:rate=10:duration=1'];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast'); if (audio) args.push('-c:a', 'aac');
    args.push(path.join(dir, 'out', name)); assert.equal(spawnSync('ffmpeg', args).status, 0);
  }
  const inputs = currentArtifactInputs(dir);
  saveState(dir, { genStamp: { scriptHash: inputs.sourceHashes['脚本.md'], scenesHash: inputs.sourceHashes['scenes.src.js'], sourceHashes: inputs.sourceHashes },
    render: { artifact: createArtifactRecord(dir, 'render') }, voice: { artifact: createArtifactRecord(dir, 'voice') } });
  return dir;
}

test('新指令不能因为没有 --new 被丢弃；新任务带内部 ID 也必须送达；只有恢复才省略', () => {
  assert.equal(freshInstructionFor({ shouldResume: false, raw: '检查一下画面', resumeInstructions: [] }), '检查一下画面');
  assert.equal(freshInstructionFor({ shouldResume: false, raw: '在片尾加一段广告', resumeInstructions: [] }), '在片尾加一段广告');
  assert.equal(freshInstructionFor({ shouldResume: true, raw: '检查一下画面', resumeInstructions: [] }), '');
  assert.equal(freshInstructionFor({ shouldResume: true, raw: '旧的', resumeInstructions: [{ content: '新的要求' }] }), '新的要求');
});

test('审阅识别：检查画面是审阅；明确改画面仍是修改', () => {
  for (const text of ['你检查一下画面有没有显示不对的地方', '看看字幕有没有重叠', '复查成片排版']) assert.equal(isReviewRequest(text), true, text);
  for (const text of ['把开场画面改短一点', '检查画面后把标题改短', '删掉第 2 场']) assert.equal(isReviewRequest(text), false, text);
  assert.deepEqual(reviewScopes('检查画面和字幕'), ['visual', 'subtitle']);
});

test('真实画面体检只在项目内生成报告，包含检查项与边界说明', async t => {
  const dir = fixture(t);
  const result = await runVisualReview(dir);
  assert.ok(result.checks.length >= 4);
  assert.match(result.note, /不判断构图|不判断/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-visual-review.json'), 'utf8')).total, result.total);
  assert.match(reviewSummary(result), /画面机械体检/);
});

test('完成任务后说“检查画面”会实际执行审阅，不能直接走 validate 完成', async t => {
  const dir = fixture(t), task = beginTask(dir, '做这支片', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  let n = 0, sawReview = false;
  const result = await runAgent(dir, task.message, {
    taskId: task.id, attemptId: task.attemptId, mode: 'article', providers, resume: true,
    instruction: '你检查一下画面有没有显示不对的地方', stepBudget: 6,
    request: async (_p, messages) => {
      n++;
      const text = messages.map(m => m.content || '').join('\n');
      if (/【本轮审阅已执行】/.test(text)) sawReview = true;
      return reply('已根据机械体检报告回答；构图与审美仍须人工查看。');
    },
  });
  assert.equal(sawReview, true, '必须先把实际审阅结果交给模型');
  assert.equal(n, 1, '执行器先跑实际审阅，模型只需依据报告回答一次；不能跳过审阅直接完成');
  assert.equal(result.status, 'completed', result.paused);
  assert.ok(fs.existsSync(path.join(dir, 'out/.vh-visual-review.json')));
  assert.match(result.answer, /机械体检/);
});

test('审阅期间不能改稿、不能重做媒体；只能运行实际检查与只读查看', async t => {
  const dir = fixture(t), task = beginTask(dir, '审阅画面', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  let n = 0;
  const result = await runAgent(dir, task.message, {
    taskId: task.id, attemptId: task.attemptId, mode: 'article', providers, resume: true,
    instruction: '检查一下画面有没有显示不对的地方', stepBudget: 4,
    request: async () => n++ === 0 ? call('write', 'write_file', { path: '脚本.md', content: 'unrelated' }) : reply('完成'),
  });
  assert.equal(result.status, 'completed');
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /观察一个窗口/);
  assert.ok(fs.existsSync(path.join(dir, 'out/.vh-visual-review.json')));
});

test('体检失败不能宣称检查通过，也不能直接完成', async t => {
  const dir = fixture(t), task = beginTask(dir, '审阅画面', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  fs.unlinkSync(path.join(dir, 'scene.html'));
  const result = await runAgent(dir, task.message, {
    taskId: task.id, attemptId: task.attemptId, mode: 'article', providers, resume: true,
    instruction: '检查一下画面', stepBudget: 2, request: async () => reply('画面没问题'),
  });
  assert.equal(result.status, 'paused');
  assert.match(result.paused, /审阅|检查/);
});
