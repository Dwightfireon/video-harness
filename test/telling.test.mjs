import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze as hookAnalyze, report as hookReport } from '../lib/hook.mjs';
import { analyze as arcAnalyze, report as arcReport } from '../lib/arc.mjs';
import { analyze as loopAnalyze, report as loopReport } from '../lib/loop.mjs';
import { analyze as concreteAnalyze, zh2num } from '../lib/concrete.mjs';

/* 讲述方式四件套：为什么值得测
   依据：Ira Glass（anecdote + reflection）/ Randy Olson ABT / Derek Muller 实验 / Kenn Adams Story Spine。
   这四个检查器的价值全在"判据不能变成橡皮图章"：
   宁可报错（作者会改），也不要静默放过（作者以为没问题）。 */

const mk = (md) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tell-'));
  fs.writeFileSync(path.join(d, '脚本.md'), md, 'utf8');
  return d;
};

const S = (n, title, ...lines) =>
  `## S${n} · ${title}\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n← 依赖：${n === 1 ? '无' : 'S' + (n - 1)}\n`;

/* ---------------- hook ---------------- */
test('hook：开场只有陈述 → 报 no-hook', () => {
  const d = mk(S(1, '背景', '一九五二年彗星投入运营。', '速度很快。', '高度很高。'));
  const r = hookAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'no-hook'), JSON.stringify(r.findings));
});

test('hook：开场有反常识断言 → 不报 no-hook', () => {
  const d = mk(S(1, '结论', '你大概听过：彗星坠毁是因为舷窗是方的。', '其实不是。', '调查结论说不是。'));
  const r = hookAnalyze(d);
  assert.ok(!r.findings.some(f => f.kind === 'no-hook'), JSON.stringify(r.findings));
});

test('hook：全片 0 设问 → 报 no-question', () => {
  const d = mk(S(1, '甲', '这是陈述。') + S(2, '乙', '这也是陈述。'));
  const r = hookAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'no-question'), JSON.stringify(r.findings));
});

test('hook：有真设问 → 不报 no-question', () => {
  const d = mk(S(1, '甲', '那真正的凶手是什么？') + S(2, '乙', '答案在这里。'));
  const r = hookAnalyze(d);
  assert.ok(!r.findings.some(f => f.kind === 'no-question'), JSON.stringify(r.findings));
});

test('hook：反问修辞（难道…吗）不算设问', () => {
  const d = mk(S(1, '甲', '难道这不是很明显吗？') + S(2, '乙', '是。'));
  const r = hookAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'no-question'), '反问不该被当成真问题：' + JSON.stringify(r.findings));
});

test('hook：report 给出 Muller 的依据（不是空口判断）', () => {
  const t = hookReport(hookAnalyze(mk(S(1, '甲', '这是陈述。'))));
  assert.match(t, /Muller|清晰直接/);
});

/* ---------------- arc ---------------- */
test('arc：缺 AND（出事前的常态）→ 报 no-and', () => {
  const d = mk(
    S(1, '事故', '第一架坠毁了。') +
    S(2, '调查', '说不通的地方在于：裂口对不上。') +
    S(3, '结果', '所以要改标准。')
  );
  const r = arcAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'no-and'), JSON.stringify(r.findings));
});

test('arc：有 AND + 真 BUT + THEREFORE + EVER SINCE → 通过', () => {
  const d = mk(
    S(1, '当年', '当时所有人都认为它很安全。', '它投入运营，被视为骄傲。') +
    S(2, '事故', '一九五三年坠毁。') +
    S(3, '说不通', '说不通的地方在于：设计越保守，越没人怀疑它会在几千次之后裂开。') +
    S(4, '所以', '所以要求增加重复载荷试验。') +
    S(5, '今天', '今天你坐的每一架客机都要做结构检查。')
  );
  const r = arcAnalyze(d);
  assert.equal(r.seg.and, true);
  assert.ok(r.seg.but > 0, '应识别出真冲突：' + JSON.stringify(r.seg));
  assert.equal(r.seg.therefore, true);
  assert.equal(r.seg.everSince, true);
});

test('arc："更麻烦的是"这种补充说明不算真冲突', () => {
  const d = mk(
    S(1, '当年', '当时所有人认为它安全。') +
    S(2, '补充', '更麻烦的是，试验用的是同一段机身。') +
    S(3, '所以', '所以改标准。') +
    S(4, '今天', '今天的飞机都要查。')
  );
  const r = arcAnalyze(d);
  assert.equal(r.seg.but, 0, '"更麻烦"只是加一条，不是"说不通"：' + JSON.stringify(r.seg));
});

test('arc：重复调用同一条正则不会漏匹配（lastIndex 陷阱）', () => {
  /* 真实 bug：带 /g 的正则 .test() 会推进 lastIndex，第二次调用就从头跳过。
     这里连跑两次，结果必须一致。 */
  const d = mk(
    S(1, '当年', '当时所有人都认为它安全。') +
    S(2, '冲突', '说不通的地方在于：裂口和应力算的对不上。') +
    S(3, '所以', '所以要求增加试验。') +
    S(4, '今天', '今天的飞机都要查。')
  );
  const a = arcAnalyze(d);
  const b = arcAnalyze(d);
  assert.deepEqual(a.seg, b.seg, '两次分析结果必须一致（正则不能有状态）');
});

test('arc：缺 EVER SINCE → 报 no-ever-since', () => {
  const d = mk(
    S(1, '当年', '当时所有人都认为它安全。') +
    S(2, '冲突', '说不通的地方在于：裂口对不上。') +
    S(3, '所以', '所以要求增加试验。')
  );
  const r = arcAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'no-ever-since'), JSON.stringify(r.findings));
});

/* ---------------- loop ---------------- */
test('loop：提了问题没回答 → 报 unanswered', () => {
  const d = mk(
    S(1, '问', '那真正的凶手是什么？') +
    S(2, '无关', '先讲一段天气。') +
    S(3, '也无关', '再讲一段风景。')
  );
  const r = loopAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'unanswered'), JSON.stringify(r.findings));
});

test('loop：问题在后面被回答 → 通过', () => {
  const d = mk(
    S(1, '问', '那真正的凶手是什么？') +
    S(2, '答', '真正的凶手是重复载荷下的累积。')
  );
  const r = loopAnalyze(d);
  assert.deepEqual(r.findings.filter(f => f.kind === 'unanswered'), [], JSON.stringify(r.findings));
});

test('loop：全片无设问不视为缺陷', () => {
  const d = mk(S(1, '甲', '这是陈述。'));
  const r = loopAnalyze(d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
  assert.match(loopReport(r), /无需为此添加设问/);
});

/* ---------------- concrete ---------------- */
test('concrete：中文数字能转成数值', () => {
  assert.equal(zh2num('三千零六十'), 3060);
  assert.equal(zh2num('一万六千'), 16000);
  assert.equal(zh2num('二十万'), 200000);
});

test('concrete：大数字没换算 → 报出来（按场合并，不刷屏）', () => {
  const d = mk(
    S(1, '数', '水槽加压到三千零六十次，机身裂了。', '目标寿命是一万次。') +
    S(2, '另一场', '试验撑过了一万六千次。')
  );
  const r = concreteAnalyze(d);
  const abs = r.findings.filter(f => f.kind === 'abstract');
  assert.ok(abs.length >= 1, JSON.stringify(r.findings));
  assert.ok(abs.length <= 3, '应按场合并，不能每个数字一条：' + abs.length);
});

test('concrete：有"相当于每天飞三班"就算换算', () => {
  const d = mk(S(1, '数', '三千零六十次，相当于每天飞三班、飞三年。'));
  const r = concreteAnalyze(d);
  assert.equal(r.findings.filter(f => f.kind === 'abstract').length, 0, JSON.stringify(r.findings));
});

test('concrete："换句话说"不算换算（没换单位）', () => {
  const d = mk(S(1, '数', '一万次循环，换句话说，问题不在一次用力过猛。'));
  const r = concreteAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'abstract'), '换述词不算体感换算：' + JSON.stringify(r.findings));
});

test('concrete：只报关键数字（≥1000 或带万/倍），小数字不吵', () => {
  const d = mk(S(1, '数', '这里有 3 个步骤，每个 5 分钟。'));
  const r = concreteAnalyze(d);
  assert.equal(r.findings.filter(f => f.kind === 'abstract').length, 0, JSON.stringify(r.findings));
});

test('concrete：年份不当成量（1954 不是"一个数字"）', () => {
  const d = mk(S(1, '数', '1954 年那次事故之后，规则改了。'));
  const r = concreteAnalyze(d);
  assert.equal(r.nums.filter(n => n.value === '1954').length, 0, JSON.stringify(r.nums));
});

/* ---------- 第九批补强：强度 / 回应冲突 / 回望 / 验算 ---------- */
import { scoreHook } from '../lib/hook.mjs';
import { analyze as reflectAnalyze } from '../lib/reflect.mjs';
import { analyze as verifyAnalyze, zh2num as vZh } from '../lib/verify.mjs';

test('hook：兼容旧形式分，不将词面分数等同质量', () => {
  /* 形式特征少：只有一句陈述 */
  const weak = scoreHook(['这一期我们聊聊设计失误。']);
  assert.ok(weak.score < 5, '形式分应 <5：' + JSON.stringify(weak));

  /* 形式特征多：有对象词、反差词、问号与短句 */
  const strong = scoreHook([
    '一九五四年，一架客机在万米高空解体。',
    '你大概听过原因：方窗害死了它。',
    '但调查组加压三千次之后，裂开的地方不是舷窗 —— 那这个说法对吗？',
  ]);
  assert.ok(strong.score >= 8, '形式分应 >=8：' + JSON.stringify(strong));
});

test('hook：强度报告要说出理由（不是给个分数就完）', () => {
  const s = scoreHook(['一九五四年，一架客机坠毁。', '你大概听过：方窗害死了它。']);
  assert.ok(s.reasons.length >= 2, JSON.stringify(s.reasons));
});

test('arc：结论段出现了"所以"，但没回应冲突 → 报 there-ignores-but', () => {
  const d = mk(
    S(1, '当年', '当时所有人都认为它很安全。') +
    S(2, '冲突', '真正说不通的是：水槽里的裂口出现在逃生舱口，和应力计算对不上。') +
    S(3, '结论', '所以后来行业开始关注天气预报。') +
    S(4, '今天', '今天的飞机都要查天气。')
  );
  const r = arcAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'there-ignores-but'), JSON.stringify(r.findings));
});

test('arc：结论回应了冲突 → 不报 there-ignores-but', () => {
  const d = mk(
    S(1, '当年', '当时所有人都认为它很安全。') +
    S(2, '冲突', '真正说不通的是：试验用的机身和量产机身对不上，裂口位置也不对。') +
    S(3, '结论', '所以要求改用没用过的量产机身做重复载荷试验。') +
    S(4, '今天', '今天的飞机都要查结构。')
  );
  const r = arcAnalyze(d);
  assert.ok(!r.findings.some(f => f.kind === 'there-ignores-but'), JSON.stringify(r.findings));
});

test('reflect：全片没有回望 → 报 no-reflection', () => {
  const d = mk(S(1, '甲', '一九五四年一架飞机坠毁。') + S(2, '乙', '调查组去了现场。'));
  const r = reflectAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'no-reflection'), JSON.stringify(r.findings));
});

test('reflect：有回望且指向具体内容 → 通过', () => {
  const d = mk(
    S(1, '甲', '一九五四年一架飞机坠毁。') +
    S(2, '乙', '水槽测试加压了三千次，机身裂开。') +
    S(3, '丙', '换句话说，那个"合格"的结论，是测试本身制造出来的。') +
    S(4, '丁', '所以标准改了。') +
    S(5, '戊', '今天你坐的飞机都要查结构。')
  );
  const r = reflectAnalyze(d);
  assert.equal(r.count >= 1, true, JSON.stringify(r.hits));
  assert.ok(!r.findings.some(f => f.kind === 'no-reflection'), JSON.stringify(r.findings));
});

test('reflect：回望全挤在结尾 → 报 late-reflection', () => {
  const d = mk(
    S(1, '甲', '一九五四年一架飞机坠毁。') +
    S(2, '乙', '调查组去了现场。') +
    S(3, '丙', '他们做了水槽测试。') +
    S(4, '丁', '机身裂开了。') +
    S(5, '戊', '这意味着，测试对象和量产对象不是同一件事。')
  );
  const r = reflectAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'late-reflection'), JSON.stringify(r.findings));
});

test('reflect：只有空泛抒情 → 报 hollow', () => {
  const d = mk(
    S(1, '甲', '一九五四年一架飞机坠毁。') +
    S(2, '乙', '这很令人唏嘘。') +
    S(3, '丙', '这令人惋惜。')
  );
  const r = reflectAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'hollow' || f.kind === 'no-reflection'), JSON.stringify(r.findings));
});

test('verify：中文数字解析不能把"一万六千"切成"六千"', () => {
  assert.equal(vZh('一万六千'), 16000);
  assert.equal(vZh('三千零六十'), 3060);
  assert.equal(vZh('二十万'), 200000);
});

test('verify：算错的换算 → 报 miscalc（差一倍以上）', () => {
  const d = mk(S(1, '数', '三千零六十次，相当于每天飞三班、飞一年半。'));
  const r = verifyAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'miscalc'), JSON.stringify(r.findings));
});

test('verify：算对的换算 → 通过', () => {
  const d = mk(S(1, '数', '三千零六十次，相当于每天飞三班、飞三年。'));
  const r = verifyAnalyze(d);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

test('verify：16000 次 ÷ 每天 3 班 ≈ 14.6 年（不能被解析成 6000）', () => {
  const d = mk(S(1, '数', '一万六千次，相当于每天飞三班、飞十四年。'));
  const r = verifyAnalyze(d);
  assert.deepEqual(r.findings, [], '14 年是对的：' + JSON.stringify(r.findings));
});

test('verify：口播允许 25% 取整误差（2.8 → "3 年" 通过）', () => {
  const d = mk(S(1, '数', '三千零六十次，相当于每天飞三班、飞三年。'));
  const r = verifyAnalyze(d);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

test('verify：没写频率时用全片的默认频率（S9 那句"一年半"原本漏检）', () => {
  const d = mk(
    S(1, '数', '每天飞三班、每班两小时。') +
    S(2, '数', '三千零六十次，相当于一年半的航班。')
  );
  const r = verifyAnalyze(d);
  assert.ok(r.findings.some(f => f.kind === 'miscalc'), '应能验算出一年半是错的：' + JSON.stringify(r.findings));
});
