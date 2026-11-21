import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionFailure, durationOvershoot, reconsiderProductionStop } from '../lib/automation.mjs';

/* 真实事故：自动修复 2 轮额度，第 1 轮 build（元素没挂），第 2 轮时长
 * 493.74s。模型确实把片子削到 482.08s（省 11.66 秒），但「又超了」被记成
 * 第二次失败，额度耗尽后锁死 —— 明明只差 2.08 秒。 */

const duration = (sec, limit = 480) =>
  `【时长超限，禁止继续渲染】时间轴 ${sec.toFixed(2)} 秒，超过当前上限 ${limit} 秒 ${(sec - limit).toFixed(1)} 秒。两条路，选一条：① 删减内容；② 放宽上限。`;

test('时长在缩短时不重复扣修复额度，也不锁死', () => {
  let ledger = {};
  ledger = productionFailure(ledger, { stage: 'build', reason: 'FAIL 第 1 场: `eyebrow` 创建了但没 append', sourceSignature: 'S', maxRepairs: 2 });
  ledger = productionFailure(ledger, { stage: 'measure', reason: duration(493.74), sourceSignature: 'S', maxRepairs: 2 });
  assert.equal(ledger.history.length, 2);
  assert.equal(ledger.pending?.stage, 'measure');

  ledger = productionFailure(ledger, { stage: 'measure', reason: duration(482.08), sourceSignature: 'S', maxRepairs: 2 });
  assert.equal(ledger.stop, null, '已经削掉 11.66 秒，不该因为额度满额而锁死');
  assert.equal(ledger.pending?.converging, true);
  assert.equal(ledger.pending?.stage, 'measure');
});

test('时长变长或原样反复失败仍然按失败处理', () => {
  let ledger = {};
  ledger = productionFailure(ledger, { stage: 'measure', reason: duration(490), sourceSignature: 'S', maxRepairs: 1 });
  const worse = productionFailure(ledger, { stage: 'measure', reason: duration(495), sourceSignature: 'S', maxRepairs: 1 });
  assert.ok(worse.stop, '越改越长必须停下，不能无限重试');
  assert.equal(worse.pending, null);

  const same = productionFailure(ledger, { stage: 'measure', reason: duration(490), sourceSignature: 'S', maxRepairs: 1 });
  assert.ok(same.stop, '同一输入同一问题再次失败要停');
});

test('解析超限量用于判断是否在收敛，非时长失败不受影响', () => {
  assert.equal(durationOvershoot(duration(482.08)).over.toFixed(2), '2.08');
  assert.equal(durationOvershoot('对比度 1.05:1「额度」不足'), null);
  assert.equal(durationOvershoot('FAIL 第 1 场: 版式溢出'), null);
  // 没写明秒数的旧格式不能猜
  assert.equal(durationOvershoot('时间轴超限'), null);
  assert.equal(durationOvershoot('FAIL 版式溢出：画面写着时间轴 485 秒，超过当前上限 480 秒'), null);
  assert.equal(durationOvershoot('FAIL 版式溢出\n' + duration(485)), null);
});

test('收敛必须同阶段、同计量对象和上限；历史格式兼容但不信任无关文字', () => {
  const first = productionFailure({}, { stage: 'render', reason: duration(490), sourceSignature: 'a', maxRepairs: 1 });
  assert.equal(first.pending.durationIssue.code, 'duration-limit');
  for (const [stage, reason] of [
    ['measure', duration(485)],
    ['render', duration(485, 479)],
    ['render', '【时长超限，禁止继续渲染】配音时长 485.00 秒，超过当前上限 480 秒'],
    ['render', 'FAIL 版式溢出\n' + duration(485)],
  ]) {
    const result = productionFailure({ ...first, pending: null }, { stage, reason, sourceSignature: 'b', maxRepairs: 1 });
    assert.ok(result.stop, stage + ' ' + reason); assert.equal(result.pending, null);
  }
  const legacy = { ...first, pending: null, history: first.history.map(({ durationIssue, ...entry }) => entry) };
  const improved = productionFailure(legacy, { stage: 'render', reason: duration(485), sourceSignature: 'b', maxRepairs: 1 });
  assert.equal(improved.pending?.converging, true); assert.equal(improved.pending.durationIssue.basis, '时间轴');
  const damaged = { ...legacy, history: legacy.history.map(entry => ({ ...entry, durationIssue: { code: 'duration-limit', basis: '时间轴', duration: 490, limit: 480, over: 999 } })) };
  const rejected = productionFailure(damaged, { stage: 'render', reason: duration(485), sourceSignature: 'b', maxRepairs: 1 });
  assert.ok(rejected.stop, '损坏的结构化证据不能降级为旧文本并授权追加修复');
});

test('修正作者输入后仍可重新核验，不追加预算', () => {
  const ledger = { stop: '内容问题', stoppedSignature: 'A', stoppedKind: 'content' };
  assert.equal(reconsiderProductionStop(ledger, 'A'), ledger, '输入没变就不该解锁');
  assert.equal(reconsiderProductionStop(ledger, 'B').stop, null);
});
