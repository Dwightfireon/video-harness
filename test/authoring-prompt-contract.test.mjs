import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../lib/agent.mjs';
import { TASK_PROMPTS, composeTask } from '../lib/task-prompts.mjs';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const builder = read('.opencode/agents/vh-builder.md');

function explanationContract(text) {
  for (const pattern of [
    /主体首现[^\n]*做了什么或经历什么/,
    /必要[^\n]*例子[^\n]*条件[^\n]*变化[^\n]*结果[^\n]*不只列数字/,
    /假设[^\n]*简化算例[^\n]*设定条件[^\n]*不当实测/,
    /统计数字[^\n]*对象[^\n]*单位[^\n]*范围[^\n]*比较基准[^\n]*分母/,
    /方案中[^\n]*关键限定[^\n]*旁白/,
    /观察结果[^\n]*机制假说[^\n]*干预效果/,
    /不跨来源硬拼证据/,
    /证据不足[^\n]*收窄结论/,
  ]) assert.match(text, pattern);
}

function visualContract(text) {
  for (const pattern of [
    /同一(?:对象|主体)[^\n]*状态变化|状态变化[^\n]*同一(?:对象|主体)/,
    /位置[^\n]*编号[^\n]*颜色参照/,
    /曲线[^\n]*直接标[^\n]*名称[^\n]*单位[^\n]*必要条件/,
    /示意[^\n]*不[^\n]*实测/,
    /不反复读标题/,
    /已有 SVG[^\n]*transform\s*\/\s*opacity/,
    /VH_FILM\.sceneCue/,
    /不[^\n]*重型 FX\s*\/\s*3D[^\n]*默认素材搜索/,
    /不减画质|不[^\n]*降低画质/,
  ]) assert.match(text, pattern);
}

test('article/topic dispatch prompts teach concrete explanation and cheap continuous motion without new gates', () => {
  for (const mode of ['article', 'topic']) {
    const text = TASK_PROMPTS[mode];
    explanationContract(text);
    visualContract(text);
    assert.match(text, /默认不限时长，已有显式上限保留/);
    assert.match(text, /不设例子或动作配额/);
    assert.doesNotMatch(text, /必须.*(?:审稿|审核|样片)|每场至少|至少\s*\d+\s*(?:例|次|个动作)/);
  }
  assert.match(TASK_PROMPTS.article, /沿原文主题、判断与论述顺序/);
  assert.match(TASK_PROMPTS.article, /不自行增加多版试稿、审核表或诊断循环/);
  assert.match(TASK_PROMPTS.topic, /不为形式评分、两版试稿或审核手续扣住/);
});

test('narrow edits do not inherit full authoring work and composition preserves the exact user suffix', () => {
  for (const mode of ['edit', 'edit-copy', 'edit-script', 'edit-visual'])
    assert.doesNotMatch(TASK_PROMPTS[mode], /主体首现|简化算例|默认素材搜索/);
  const message = '保留原文主线\n只讲我的这个例子。\n';
  const task = composeTask({ project: 'fixture', repo: '.', mode: 'article', message });
  assert.ok(task.endsWith('用户的指令是：\n' + message));
  assert.match(TASK_PROMPTS['edit-visual'], /不动 脚本\.md \/ 方案\.md/);
});

test('OpenCode builder has the same explanation and visual contract, retaining article scope', () => {
  explanationContract(builder);
  visualContract(builder);
  assert.match(builder, /沿它的主题、核心判断、论述顺序讲/);
  assert.match(builder, /默认不限时长，已有显式上限保留/);
  assert.match(builder, /允许静止，不为指标加动效/);
});

test('the actual local system prompt carries the contract without model calls or production', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-authoring-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  let calls = 0, system = '', toolNames = [];
  const result = await runAgent(dir, '先讨论，不要写入。', {
    mode: 'topic', taskId: 'authoring-contract', instruction: '先讨论，不要写入。', stepBudget: 2,
    providers: [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture' }],
    request: async (_provider, messages, schemas) => {
      calls++;
      system = messages[0].content;
      toolNames = schemas.map(schema => schema.function.name);
      return { choices: [{ message: { role: 'assistant', content: '仅讨论，未制作。' }, finish_reason: 'stop' }] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'completed', result.error || result.paused);
  explanationContract(system);
  visualContract(system);
  assert.match(system, /默认沿原文主线/);
  assert.match(system, /默认时长由内容决定，不先设分钟数再削薄讲述/);
  assert.match(system, /不跨来源硬拼证据/);
  assert.match(system, /相关不当因果，机制猜想不当有效干预/);
  assert.match(system, /默认不自动调用模型内容审稿/);
  assert.match(system, /不作为默认制作关口/);
  assert.doesNotMatch(system, /集中一轮修稿与看帧|每场至少|至少一半/);
  assert.ok(!toolNames.some(name => ['write_file', 'write_scene', 'run_stage', 'review_content'].includes(name)), toolNames.join(', '));
  for (const file of ['方案.md', '脚本.md', 'scenes.src.js', 'scene.html', 'timing.json', 'out/video.mp4'])
    assert.equal(fs.existsSync(path.join(dir, file)), false, file);
});

test('cinematic reference prioritizes stable identity and direct labels using existing primitives', () => {
  const guidance = read('references/cinematic-direction.md').split('## 最小技术用法')[0];
  // The reference describes continuity before the code examples, not a new production recipe.
  assert.match(guidance, /同一对象的位置、编号或颜色参照/);
  assert.match(guidance, /曲线近旁直接标注名称、单位与必要条件/);
  assert.match(guidance, /示意曲线明说非实测/);
  assert.match(guidance, /已有 SVG、transform \/ opacity 与 `VH_FILM\.sceneCue`/);
  assert.match(guidance, /不设动作、曲线或例子配额/);
  assert.match(guidance, /不新增制作、审核或付费模型调用阶段/);
});
