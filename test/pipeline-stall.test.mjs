/* 两个真实事故的回归：
 *   ① 任务反复中断：模型写 claims.json 时不知道字段名，连续 4 轮翻 lib/claims.mjs 源码，
 *      被判定"偏离阶段"而暂停。字段规范必须写在提示里，翻源码要被拦下。
 *   ② 报错看不懂：「还没渲染过成片（vh render）」是进度状态，却被当成"收尾检查发现不一致"，
 *      用户以为坏了。文案要说明状态、缺什么、下一步做什么。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { touchesHarnessSource } from '../lib/agent.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';

const project = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-claims-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  return dir;
};
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test('回归：写证据表阶段不允许翻 harness 源码', t => {
  const p = project(t);
  // 真实日志里出现过的三种写法
  assert.equal(touchesHarnessSource(call('run', { command: 'sed -n 1,70p /Users/x/video_generation/lib/claims.mjs' }), p), true);
  assert.equal(touchesHarnessSource(call('run', { command: 'cd lib && grep -n replace claims.mjs' }), p), true);
  assert.equal(touchesHarnessSource(call('run', { command: 'grep -n assertion lib/claims.mjs' }), p), true);
  // 正常动笔与项目内操作必须放行
  assert.equal(touchesHarnessSource(call('append_file', { path: 'claims.json' }), p), false);
  assert.equal(touchesHarnessSource(call('read_file', { path: '脚本.md' }), p), false);
  assert.equal(touchesHarnessSource(call('run', { command: 'ls -la; ls out 2>/dev/null' }), p), false);
  assert.equal(touchesHarnessSource(call('run', { command: 'grep -n id claims.json' }), p), false);
});

test('回归：证据表阶段说明必须自带字段规范，不能让模型去源码里猜', async t => {
  const p = project(t);
  fs.writeFileSync(path.join(p, 'PROJECT.json'), JSON.stringify({ workflow: { profile: 'audited' } }));
  fs.writeFileSync(path.join(p, '方案.md'), '方案');
  fs.writeFileSync(path.join(p, '脚本.md'), '## S1\n1. 企业收入占比约 80%\n');
  const work = await nextPipelineWork(p, 'article', []);
  // 脚本写完后先补证据表（claims.json 缺失时 currentPipelineWork 会先给 draft_claims），
  // 所以这条断言必须是 draft_claims —— 它测的就是"证据表阶段"的提示内容。
  assert.equal(work.stage, 'draft_claims');
  // 必需字段名要出现在提示里
  for (const field of ['id', 'assertion', 'url', 'kind', 'scope']) {
    assert.ok(work.note.includes(field), `提示里必须写明 ${field} 字段`);
  }
  // 要给出可照抄的示例结构
  assert.match(work.note, /\[\{"id"/);
  // 要明确劝阻翻源码
  assert.match(work.note, /不要.*源码|源码.*不要/);
});

test('回归：「还没渲染成片」属于进度状态，文案要能读懂并指出下一步', async t => {
  const p = project(t);
  // 空项目：没有任何产物
  const { artifactStatus } = await import('../lib/artifact-status.mjs');
  const st = artifactStatus(p);
  assert.equal(st.deliverable.stale, true);
  const reason = st.deliverable.reason;
  assert.ok(reason, '要给出原因');
  // 不能只是把命令名丢给用户
  assert.ok(!/^还没渲染过成片（vh render）$/.test(reason), '旧文案不合格');
  // 要说清是正常状态 + 下一步做什么
  assert.match(reason, /成片还没生成|正常状态/);
  assert.match(reason, /vh build/);
  assert.match(reason, /vh render/);
});
