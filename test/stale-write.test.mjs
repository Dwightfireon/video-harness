import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAgent } from '../lib/agent.mjs';
import { beginTask, updateTask } from '../lib/task-status.mjs';
import { saveState, hashFile } from '../lib/state.mjs';
import { currentArtifactInputs, createArtifactRecord } from '../lib/artifact-status.mjs';
import { readEditFile } from '../lib/author-edits.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const call = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

/* 复现真实日志：模型拿旧 base_hash 做 patch_text，被拒后没再改，却直接收工。 */
function finishedFilm(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-stale-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  for (const [name, text] of Object.entries({
    'PROJECT.json': '{"deliveryTarget":"video"}', '方案.md': '受众基线：知道广告。',
    '脚本.md': '## S1 · 开场\n1. 介绍一个产品。\n', 'claims.json': '[]',
    'scenes.src.js': 'root => ({ render() {} })',
    'engine.tpl.html': 'const ORIENT = "landscape";',
    'scene.html': 'const DURATION = 1; const scenes = []; addScene(0,1,root=>({}));',
    'timing.json': '{}', 'timeline.mjs': 'export const scriptGroups=()=>[]; export const validateTiming=()=>({subs:[],total:1});',
    '发布文案.md': '## 标题\n测试\n## 简介\n介绍。\n## 置顶评论\n欢迎。\n## 封面文案\n主：测试\n',
  })) fs.writeFileSync(path.join(dir, name), text);
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

test('写入被 stale base_hash 拒绝后，不能把这轮当作已改稿并完成', async t => {
  const dir = finishedFilm(t), original = fs.readFileSync(path.join(dir, '脚本.md'), 'utf8');
  const task = beginTask(dir, '在片尾加一段广告', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  const staleHash = readEditFile(dir, '脚本.md').base_hash;
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n2. 外部已改。\n');   // 让读到的指纹过期（模拟日志里那次 stale base_hash）
  let n = 0, sawRejection = false;
  const result = await runAgent(dir, task.message, {
    taskId: task.id, attemptId: task.attemptId, mode: 'article', providers, stepBudget: 4,
    instruction: task.message,
    request: async (_p, messages) => {
      n++;
      sawRejection ||= messages.some(m => m.role === 'tool' && /stale base_hash|未成功/.test(m.content || ''));
      if (n === 1) return call('bad-patch', 'patch_text', { path: '脚本.md', base_hash: staleHash, find: '1. 介绍一个产品。', replace: '1. 介绍一个产品。\n\n## S2 · 广告\n1. 这是广告。' });
      return reply('已在片尾加上广告。');
    },
  });
  assert.equal(sawRejection, true, '失败的写入必须反馈给模型');
  assert.equal(result.status, 'paused', '写失败不能报完成：' + JSON.stringify({ status: result.status, answer: result.answer }));
  assert.match(result.paused, /没有变化|尚未交付|写入/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /## S2 · 广告/, '文件确实没有被改');
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /外部已改/, '原有外部改动不能丢');
});

test('写入成功后必须继续出片，不能拿旧成片报完成', async t => {
  const dir = finishedFilm(t), task = beginTask(dir, '在片尾加一段广告', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  let n = 0;
  const result = await runAgent(dir, task.message, {
    taskId: task.id, attemptId: task.attemptId, mode: 'article', providers, stepBudget: 6,
    instruction: task.message,
    request: async () => {
      n++;
      if (n === 1) return call('good-patch', 'patch_text', { path: '脚本.md', base_hash: readEditFile(dir, '脚本.md').base_hash, find: '1. 介绍一个产品。', replace: '1. 介绍一个产品。\n2. 这是补充说明。' });
      return reply('已经补上说明。');
    },
  });
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /补充说明/, '写入应当成功');
  assert.equal(result.status, 'paused', '脚本改了但成片未重做，不能报完成');
  assert.match(result.paused, /尚未交付|成片/);
});
