/* 真实事故：成片已完成、只缺发布文案时，用户在「指挥」里点继续并写下
 * 「在视频最后自然的衔接一个广告…」，第 9 次执行却只写了 发布文案.md，
 * 随后 validate 通过、任务标记完成 —— 脚本和画面一个字没动。
 *
 * 四个叠加根因：
 *   ① 通过"继续"带进来的新指令被 `!saved` 排除在"用户新要求"之外；
 *   ② 缺发布文案让 work.stage=publish，publishOnly 把写入限制在 发布文案.md；
 *   ③ "写成功即清改稿标记"把写发布文案也算成落实了修改；
 *   ④ addChange 不认识"片尾接一个广告"这类句子，指令不在待核验清单里。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../lib/agent.mjs';
import { writeCheckpoint, readCheckpoint } from '../lib/checkpoint.mjs';
import { currentArtifactInputs, hashFile } from '../lib/artifact-status.mjs';
import { addChange, isPureContinuation, isDiscussionOnly, pendingChanges } from '../lib/change-contract.mjs';
import { publishStatus } from '../lib/publish.mjs';
import { readEditFile } from '../lib/author-edits.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const call = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

/* 成片已完整、有音轨凭证，但故意不写 发布文案.md —— 与事故现场一致。 */
function finishedProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ad-after-done-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  for (const [name, content] of Object.entries({
    'PROJECT.json': JSON.stringify({ name: '已完成项目', durationLimit: { maxSeconds: 900, targetSeconds: 60 } }),
    '方案.md': '# 方案\n\n| 场 | 内容 |\n|---|---|\n| S1 | 开场 |\n',
    '脚本.md': '**主体**：测试窗口\n## S1 · 开场\n1. 这是第一句。\n← 依赖：无\n',
    'claims.json': '[]',
    'scenes.src.js': '// @layout 标题\nroot => { const el = mk("div","","测试窗口"); root.appendChild(el); return {render(){}}; }\n',
    'engine.tpl.html': "const ORIENT = 'landscape';",
    'scene.html': 'const scenes = []; addScene(0, 30, () => {}); const DURATION = 30;',
    'timing.json': JSON.stringify({ dur: 30, subs: [] }),
    'out/video.mp4': 'fake-video',
    'out/video-voice.mp4': 'fake-voice',
  })) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
function seedResume(dir, instruction) {
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'ad-resume', mode: 'article', status: 'paused',
    task: '把文章做成视频', pending: [], appliedInstructions: [], messages: [
      { role: 'system', content: '规则' }, { role: 'user', content: '把文章做成视频' }],
    changeContracts: [], pipelineState: { version: 1, turns: 0 } });
  return instruction;
}

test('真实回归：继续任务时带的新指令必须改到脚本，不能只写发布文案就完成', async t => {
  const dir = finishedProject(t);
  const instruction = seedResume(dir, '在视频最后自然的衔接一个广告展示一个链接：https://example.invalid/r/CODE 给出推广码');
  const requests = [], writes = [];
  const result = await runAgent(dir, '把文章做成视频', {
    mode: 'article', taskId: 'ad-resume', resume: true, providers, stepBudget: 8,
    instruction,
    request: async (_p, messages, tools) => {
      requests.push(messages.at(-1)?.content || '');
      const toolNames = (tools || []).map(schema => schema.function?.name);
      if (requests.length === 1) {
        assert.ok(toolNames.includes('patch_text') || toolNames.includes('append_file'),
          '带新指令继续时必须能改作者文件，实际工具：' + toolNames.join(','));
        assert.ok(!toolNames.includes('confirm_publish') || toolNames.includes('patch_text'),
          '不能只给发布文案工具');
        return call('script', 'patch_text', { path: '脚本.md', base_hash: readEditFile(dir, '脚本.md').base_hash,
          find: '1. 这是第一句。', replace: '1. 这是第一句。\n\n## S2 · 片尾\n1. 这条片子由某工具支持，链接在画面里。' });
      }
      writes.push(requests.length);
      return reply('已把片尾广告写进脚本。');
    },
  });
  assert.ok(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8').includes('片尾'),
    '指令必须真正落到 脚本.md，实际：' + fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'));
  assert.notEqual(result.status, 'completed', '只改了脚本、没重渲成片时不能自称已完成');
});

test('真实回归：只写 发布文案.md 不能满足"改片子"的指令', async t => {
  const dir = finishedProject(t);
  const instruction = seedResume(dir, '在片尾接一个广告');
  let requests = 0;
  const result = await runAgent(dir, '把文章做成视频', {
    mode: 'article', taskId: 'ad-resume', resume: true, providers, stepBudget: 4, instruction,
    request: async () => {
      requests++;
      // 事故中的行为：只写发布文案就想收工。
      return call('pub-' + requests, 'write_file', { path: '发布文案.md', content: '# 发布文案\n\n## 标题\n\n测试\n' });
    },
  });
  assert.ok(requests >= 2, '只写发布文案不能一次就收工，实际请求：' + requests);
  assert.notEqual(result.status, 'completed', '脚本和画面未改，不能标记完成');
});

test('普通恢复（没有新指令）不会被强行拉进改稿', async t => {
  const dir = finishedProject(t);
  seedResume(dir, '');
  let requests = 0;
  await runAgent(dir, '把文章做成视频', {
    mode: 'article', taskId: 'ad-resume', resume: true, providers, stepBudget: 2, instruction: '',
    request: async () => { requests++; return reply('核对完毕。'); },
  });
  assert.ok(requests <= 2, '普通恢复不应额外空转：' + requests);
});

test('意图判断是结构性的：任何新说法默认算要求，只有纯"继续"才豁免', () => {
  /* 不再维护"编辑动词词表"——那张表永远补不完。
   * 事故里的四种说法都必须被当成用户要求。 */
  for (const text of ['在视频最后自然的衔接一个广告', '片尾加链接和推广码', '把标题换短',
    '把开场第一句改得更具体', '在第三段后面加一句解释', '换一个更生活化的说法']) {
    assert.equal(isPureContinuation(text), false, text);
  }
  for (const text of ['继续', '请继续完成', '接着做', '继续原任务', 'retry', '']) {
    assert.equal(isPureContinuation(text), true, text);
  }
  // 明确要求先讨论时不能强行改稿。
  assert.equal(isDiscussionOnly('先讨论一下，不要修改文件'), true);
  assert.equal(isDiscussionOnly('片尾加广告'), false);
});
