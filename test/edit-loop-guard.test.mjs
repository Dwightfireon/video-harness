import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAgent } from '../lib/agent.mjs';
import { beginTask, updateTask } from '../lib/task-status.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { saveState, hashFile } from '../lib/state.mjs';
import { currentArtifactInputs, createArtifactRecord } from '../lib/artifact-status.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const call = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

function film(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-edit-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  for (const [name, text] of Object.entries({
    'PROJECT.json': '{"deliveryTarget":"video"}', '方案.md': '受众基线：知道广告。', 'claims.json': '[]',
    '脚本.md': '## S1 · 开场\n1. 介绍一个产品。\n', 'scenes.src.js': 'root => ({ render() {} })',
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

test('用户新要求只武装一次：写入成功后能回到正常收尾，不会反复卡在改稿', async t => {
  const dir = film(t), task = beginTask(dir, '在片尾加广告', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid });
  let n = 0, authorEditTurns = 0;
  const result = await runAgent(dir, task.message, {
    taskId: task.id, attemptId: task.attemptId, mode: 'article', providers, stepBudget: 8,
    instruction: task.message,
    request: async (_p, messages) => {
      n++;
      const text = messages.map(m => m.content || '').join('\n');
      if (/【用户提出了新的修改要求】/.test(text)) authorEditTurns++;
      if (n === 1) return call('w', 'patch_text', { path: '脚本.md', base_hash: readEditFile(dir, '脚本.md').base_hash, find: '1. 介绍一个产品。', replace: '1. 介绍一个产品。\n2. 这是广告。' });
      return reply('已补上广告，仍需重新出片。');
    },
  });
  assert.equal(authorEditTurns, 1, '新要求只能触发一次改稿提示，实际 ' + authorEditTurns);
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /这是广告/);
  assert.equal(result.status, 'paused', '脚本已改但成片未重做，应停在待出片而不是报完成');
  assert.match(result.paused, /尚未交付|成片/);
});
