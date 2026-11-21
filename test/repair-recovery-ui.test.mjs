import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairRecovery, resumeWithRecovery } from '../www/repair-recovery.mjs';

const task = (extra = {}) => ({ taskId: 'task-current', attemptId: 'attempt-current', status: 'failed',
  repairRecovery: { blocked: true, canExtend: true, additionalRepairs: 2, used: 2, limit: 2, targetLimit: 4 }, ...extra });

test('恢复展示：预算耗尽显示追加与风险；5轮封顶、缺身份与异常预算均不可授权', () => {
  const model = repairRecovery(task());
  assert.match(model.label, /追加2轮修复并继续（会调用模型）/);
  assert.match(model.reason, /累计已用 2.*当前限额 2.*普通继续不会增加/);
  assert.match(model.detail, /未来任务.*8分钟.*验收.*模型、TTS 和渲染费用/);
  for (const recovery of [
    { blocked: true, canExtend: false, additionalRepairs: 0, used: 5, limit: 5, targetLimit: 5 },
    { blocked: true, canExtend: true, additionalRepairs: 2, used: 4, limit: 4, targetLimit: 6 },
    { blocked: true, canExtend: true, additionalRepairs: 2, used: 2, limit: 2, targetLimit: 3 },
  ]) assert.equal(repairRecovery(task({ repairRecovery: recovery })).canExtend, false);
  assert.equal(repairRecovery(task({ attemptId: null })).canExtend, false);
  assert.equal(repairRecovery(task({ running: true })).canExtend, false);
});

test('无确认、取消确认、陈旧任务或attempt均不提交费用操作', async () => {
  let posts = 0;
  const request = async () => { posts++; };
  await assert.rejects(resumeWithRecovery({ getTask: () => task(), request, confirmImpl: null }), /无法显示费用确认/);
  assert.equal(await resumeWithRecovery({ getTask: () => task(), request, confirmImpl: () => false }), null);
  for (const change of [{ taskId: 'other' }, { attemptId: 'new-attempt' }, { running: true }]) {
    let current = task();
    await assert.rejects(resumeWithRecovery({ getTask: () => current, request,
      confirmImpl: () => { current = { ...current, ...change }; return true; } }), /已变化/);
  }
  assert.equal(posts, 0);
});

test('确认后只发当前任务身份与追加数；实际新limit回证才认成功，累计已用保留', async () => {
  let prompt;
  const result = await resumeWithRecovery({ getTask: () => task(), confirmImpl: value => { prompt = value; return true; },
    request: async options => {
      assert.deepEqual(JSON.parse(options.body), { additionalRepairs: 2, taskId: 'task-current', attemptId: 'attempt-current' });
      return { task: { taskId: 'task-current', attemptId: 'new-attempt', automationSummary: { repairLimit: 4, repairUsed: 2 } } };
    } });
  assert.equal(result.task.automationSummary.repairLimit, 4);
  assert.match(prompt, /2→4.*轮/s); assert.match(prompt, /累计已用 2.*保留/);
  assert.match(prompt, /8分钟.*验收.*模型、TTS 和渲染费用/s);
  for (const actual of [{ ok: true }, { task: task() }, { task: { ...task(), repairRecovery: { limit: 4, used: 0 } } },
    { task: { ...task(), taskId: 'wrong-task', repairRecovery: { limit: 4, used: 2 } } }]) {
    await assert.rejects(resumeWithRecovery({ getTask: () => task(), confirmImpl: () => true, request: async () => actual }), /未确认.*重启工作台/);
  }
});

test('旧服务已耗尽但产物已就绪（旧暂停不成立）时不封锁普通继续', () => {
  const stale = { status: 'paused', taskId: 't', attemptId: 'a', staleStopNotice: '上一条暂停记录已不成立：render 的实际产物已就绪',
    automationSummary: { enabled: true, repairUsed: 2, repairLimit: 2, repairPhase: 'stopped' } };
  const model = repairRecovery(stale);
  assert.equal(model.blocked, false);
  assert.equal(model.canExtend, false);
  assert.equal(model.reason, '');
  assert.equal(model.label, '继续原任务（会调用模型）');
  // 没有该标记时，旧服务耗尽仍必须保守封锁。
  const { staleStopNotice, ...withoutFlag } = stale;
  assert.equal(repairRecovery(withoutFlag).blocked, true);
});

test('普通继续保持无body；旧服务已耗尽时失败关闭、不自动调用', async () => {
  let options;
  await resumeWithRecovery({ getTask: () => ({ taskId: 'normal' }), request: async value => { options = value; return { ok: true }; } });
  assert.deepEqual(options, { method: 'POST' });
  const old = { automationSummary: { enabled: true, repairUsed: 2, repairLimit: 2, repairPhase: 'stopped' } };
  assert.match(repairRecovery(old).reason, /重启工作台/);
  await assert.rejects(resumeWithRecovery({ getTask: () => old, request: () => assert.fail('不应派发') }), /重启工作台/);
});
