/* 真实事故：用户带新指令继续改片，模型把 shell 命令塞进 run_stage 的 stage 字段，
 * 被拒绝后记成 blocker；而"强制动手"要求 blocker 为空 → 永久关闭 →
 * 模型只能反复读文件 → 撞上"连续 12 轮未完成"→ 用户再点继续，同一循环重演。
 *
 * 三层都按结构修：
 *   ① 被拒绝的工具调用不是阶段失败，不写 blocker，改为可照做的用法纠正；
 *   ② "连续 N 轮未完成"只在**没有产出推进**时累计，有推进就清零；
 *   ③ 阶段声明的 allowed 真正决定模型看到的工具，改稿阶段看不到 run_stage。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../lib/agent.mjs';
import { readCheckpoint } from '../lib/checkpoint.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const call = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
  { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

function film(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-stage-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  for (const [name, content] of Object.entries({
    'PROJECT.json': JSON.stringify({ deliveryTarget: 'video', durationLimit: { maxSeconds: 900, targetSeconds: 60 } }),
    '方案.md': '# 方案\n\n| 场 | 内容 |\n|---|---|\n| S1 | 开场 |\n',
    '脚本.md': '**主体**：测试窗口\n## S1 · 开场\n1. 这是第一句。\n← 依赖：无\n',
    'claims.json': '[]',
    'scenes.src.js': '// @layout 标题\nroot => { const el = mk("div","","测试窗口"); root.appendChild(el); return {render(){}}; }\n',
    'engine.tpl.html': "const ORIENT = 'landscape';",
    'scene.html': 'const scenes = []; addScene(0, 30, () => {}); const DURATION = 30;',
    'timing.json': JSON.stringify({ dur: 30, subs: [] }),
    '发布文案.md': '## 标题\n测试\n## 简介\n介绍。\n## 置顶评论\n欢迎。\n## 封面文案\n主：测试\n',
  })) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('真实回归：误用 run_stage 被拒后，不能关掉强制动手、也不能累计成"连续12轮未完成"', async t => {
  const dir = film(t);
  let requests = 0, sawUsageHint = false;
  const result = await runAgent(dir, '在片尾加一段广告', {
    mode: 'article', taskId: 'stage-loop', providers, stepBudget: 16,
    instruction: '在片尾加一段广告，介绍 example.com',
    request: async (_p, messages) => {
      requests++;
      sawUsageHint ||= messages.some(m => m.role === 'tool' && /run_stage 的 stage 只接受/.test(m.content || ''));
      // 前 4 轮模仿事故：把 shell 命令塞进 run_stage
      if (requests <= 4) return call('bad-' + requests, 'run_stage', { stage: 'grep -n "^//---" scenes.src.js' });
      // 之后一直只读（事故里就是这样被 12 轮上限打死的）
      return call('read-' + requests, 'read_file', { path: '脚本.md', max_lines: 20 });
    },
  });
  // ① 误用被拒后给出可照做的用法纠正，而不是"未知制作阶段"
  assert.ok(sawUsageHint, '被拒绝的 run_stage 必须返回可照做的用法纠正，而不是沉默');
  /* ② 用错工具不能算"连续未完成"：旧实现在第 4 轮就以
   * "连续 4 轮没有执行规定动作"停住，模型一次都没机会改对。
   * 现在它会被允许继续，最终因**真正的重复读取**（同一文件反复读）停下。 */
  assert.ok(requests > 5, '用错工具不该在第 4 轮就被判偏离：' + requests);
  assert.doesNotMatch(result.paused || '', /没有执行阶段 author_edit 的规定动作/,
    '用错工具不能被记成"没执行规定动作"：' + (result.paused || ''));
  // 真正空转（重复读同一文件）仍必须停，不能无限消耗。
  assert.equal(result.status, 'paused');
  assert.ok(requests < 16, '应在用尽步数前拦住真实空转');
  assert.match(result.paused || '', /重复同一步|没有推进任何产出|不符合本轮工具契约|重复|没有任何落盘/,
    '真实空转仍要停：' + (result.paused || ''));
});

test('有产出推进时，同一小步骤的"连续未完成"计数必须清零', async t => {
  const dir = film(t);
  // Keep a genuine authoring transaction open. Once a submitted edit finishes,
  // subsequent unsolicited writes during build are now correctly rejected.
  fs.mkdirSync(path.join(dir, 'out/.vh-author-drafts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/.vh-author-drafts/脚本.md.json'), JSON.stringify({ version: 1, status: 'writing' }));
  let requests = 0;
  const { readEditFile } = await import('../lib/author-edits.mjs');
  const result = await runAgent(dir, '分段改脚本', {
    mode: 'article', taskId: 'productive-turns', providers, stepBudget: 22,
    instruction: '在片尾加两句话，分两次改',
    request: async () => {
      requests++;
      // 每 3 轮改一次脚本（真实产出），中间夹杂只读；总轮次远超 12。
      if (requests % 3 === 0 && requests <= 18) {
        const current = readEditFile(dir, '脚本.md');
        return call('append-' + requests, 'patch_text', { path: '脚本.md', base_hash: current.base_hash,
          find: '1. 这是第一句。', replace: '1. 这是第一句。' + ' 补充' + requests + '。' });
      }
      return call('read-' + requests, 'read_file', { path: '脚本.md', max_lines: 20 });
    },
  });
  assert.ok(requests > 12, '本次回归需要超过旧上限的轮次，实际：' + requests);
  assert.doesNotMatch(result.paused || '', /连续.*轮没有推进产物|连续12轮未完成/,
    '持续有产出时不能以"连续未完成"暂停：' + (result.paused || ''));
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /补充\d+/, '脚本应被真实修改');
});

test('真正空转（长期无任何产出）仍要停下，不能因为放宽而无限消耗', async t => {
  const dir = film(t);
  let requests = 0;
  const result = await runAgent(dir, '只读不改', {
    mode: 'article', taskId: 'real-idle', providers, stepBudget: 40,
    instruction: '在片尾加一段广告',
    request: async () => { requests++; return call('read-' + requests, 'read_file', { path: '脚本.md', max_lines: 10 }); },
  });
  assert.equal(result.status, 'paused');
  assert.ok(requests < 40, '空转必须在预算前停下：' + requests);
});
