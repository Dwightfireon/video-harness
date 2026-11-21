/* 真实事故：成片做完后，用户在页面「指挥」里输入"片尾加一段广告"，
 * 进程 0.6 秒就回"已完成"退出，成片一个字没变 —— 指令根本没被读到。
 *
 * 根因是四个叠在一起：
 *   ① 页面「指挥」默认 article 模式，提示词是"把文章做成视频"，模型以为要从零做
 *   ② validate 阶段的机械检查只看"产物齐不齐"，不看"用户要什么"，直接 break
 *   ③ 判断"有没有新要求"写在 splice(0) 之后，永远看到空数组
 *   ④ 改稿阶段侦察无上限，模型可以一直读文件读到被判偏离
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../lib/agent.mjs';
import { taskStatus } from '../lib/task-status.mjs';
import { beginTask, updateTask } from '../lib/task-status.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture', model: 'deepseek-v4.1-flash' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const call = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

/* 造一个"成片已完整"的项目：有脚本、场景、带音轨的成片与有效凭证。 */
function filmProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-edit-after-done-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ name: '已完成项目', durationLimit: { maxSeconds: 900, targetSeconds: 60 } }));
  fs.writeFileSync(path.join(dir, '方案.md'), '受众基线：都写过代码。');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 开场\n\n1. 这是第一句。\n\n← 依赖：无\n');
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), '// @layout 标题\n// @transition cut\nroot => ({render(){}})\n');
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), "const ORIENT = 'landscape';");
  fs.writeFileSync(path.join(dir, 'scene.html'), "const ORIENT = 'landscape'; const scenes = []; addScene(0, 30, root => ({})); const DURATION = 30;");
  fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ dur: 30, subs: [] }));
  return dir;
}

test('回归：任务完成后，用户的新指令必须被真正执行，不能秒回"已完成"', async t => {
  const dir = filmProject(t);
  let requests = 0;
  let wroteScript = false;

  const result = await runAgent(dir, '在片尾加一段广告', {
    taskId: 'after-done',
    mode: 'article',
    providers,
    instruction: '在片尾加一段广告，介绍 example.com',
    stepBudget: 12,
    request: async () => {
      requests++;
      if (requests === 1) return reply('当前版本已通过交付物的机械检查。');   // 想空手收工
      if (!wroteScript) {
        wroteScript = true;
        return call('w1', 'patch_text', { path: '脚本.md', base_hash: 'x', find: '这是第一句。', replace: '这是第一句。\\n\\n## S2 · 广告\\n\\n1. 介绍一下 example.com。' });
      }
      return reply('已把广告加进片尾。');
    },
  });

  // 关键：不能在接受一次"已完成"后就收工；至少要有真实的写入尝试
  assert.ok(requests >= 2, '必须给模型真正动手的机会，不能一次回复就结束');
  assert.ok(wroteScript, '模型必须真的去改脚本');
  assert.notEqual(result.answer, '当前版本已通过交付物的机械检查。', '不能把旧的"已完成"当作本轮答案');
});

test('回归：有新的修改要求时，validate 的机械检查不能直接短路退出', async t => {
  const dir = filmProject(t);
  let requests = 0;
  await runAgent(dir, '改一下开场', {
    taskId: 'no-shortcut',
    mode: 'article',
    providers,
    instruction: '把开场第一句改得更具体',
    stepBudget: 6,
    request: async () => {
      requests++;
      return call('r' + requests, 'read_file', { path: '脚本.md' });
    },
  });
  assert.ok(requests > 0, '有新要求时必须至少发出一次模型请求，不能被 validate 短路');
});

test('回归：恢复已完成的任务不会被误判为"又有新要求"', async t => {
  const dir = filmProject(t);
  // 先放一个 paused 的检查点，模拟"继续原任务"
  const { writeCheckpoint } = await import('../lib/checkpoint.mjs');
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'resume-done', mode: 'article', status: 'paused',
    messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '做个片子' }],
    task: '做个片子', pending: [] });

  let requests = 0;
  await runAgent(dir, '做个片子', {
    taskId: 'resume-done', mode: 'article', providers, resume: true, stepBudget: 2,
    request: async () => { requests++; return reply('做完了。'); },
  });
  // 恢复不是"新要求"，不应该被强制拉进改稿流程
  assert.ok(requests <= 2, '恢复任务不应额外空转：' + requests);
});
