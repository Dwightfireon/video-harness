/* 真实事故：渲染被质量闸门拦住 3 次，模型完全不知道卡在哪。
 * 工具结果只回第一行「exit=1 ✗ 未通过：3 个 FAIL」，而 FAIL 明细在输出末尾。
 * 模型只好反复 sed 读脚本猜原因，连续几轮不动手 → 被判"偏离阶段"暂停。
 * 用户看到的就是「成片还没生成」反复出现，永远走不到渲染。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolOutcome } from '../lib/tool-result.mjs';

const gateLog = `阶段 render；完整日志 out/.vh-tool-logs/x.log

════ check-layout.mjs ════
  FAIL 有 7 场没标 @layout（第 1,2,3,4,5,6,7 场）
  用到的骨架种类：0 种  →

════ check-script.mjs ════
  WARN 第 1 句 24 汉字：你手上大概有一张表
  FAIL 脚本里没写 **主体**：<名字> —— 没有主体就没有锚，补上再谈别的
  FAIL 7 个数字在来源表里找不到（表里没有这个值）：
    百万（值 100）
    五倍（值 5）
  FAIL 前 3 句没有一句交代"这条片子讲什么"—— 观众会摸不着头脑，不知道要往哪走
       修法：开场里写一句"这一期讲清楚：______"或等价说法；只出现主体名不算交代

✗ 未通过：3 个 FAIL（另有 54 个 WARN）`;

test('回归：闸门失败要把 FAIL 明细带回给模型，而不是只给 exit=1', () => {
  const r = toolOutcome('exit=1\n' + gateLog);
  assert.equal(r.ok, false);
  // 关键：模型必须知道"改什么"
  assert.match(r.summary, /没标 @layout/);
  assert.match(r.summary, /没写 \*\*主体\*\*/);
  assert.match(r.summary, /前 3 句没有一句交代/);
  // 修法也要带上，否则它还得自己猜
  assert.match(r.summary, /修法/);
  // 续行（具体数字）不能丢
  assert.match(r.summary, /百万（值 100）/);
});

test('FAIL 明细有上限，避免把整份日志塞进上下文', () => {
  const many = Array.from({ length: 20 }, (_, i) => `  FAIL 第 ${i} 个问题`).join('\n');
  const r = toolOutcome('exit=1\n' + many);
  assert.ok(r.fails.length <= 6, '最多带 6 条，不能无限增长');
  assert.ok(r.summary.length < 3000);
});

test('成功结果不受影响', () => {
  const r = toolOutcome('exit=0\n✓ 通过\n  ok 45 句全部对齐');
  assert.equal(r.ok, true);
  assert.equal(r.fails.length, 0);
  assert.doesNotMatch(r.summary, /必须修的问题/);
});
