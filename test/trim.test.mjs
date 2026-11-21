import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePublish } from '../lib/state.mjs';
import { dependencies, sceneDurations, trimPlan } from '../lib/trim.mjs';
import { durationLimitError } from '../lib/duration-limit.mjs';

const EXPLICIT_LIMIT = { maxSeconds: 480, targetSeconds: 420 };

function project(t, { script, subs, limit = EXPLICIT_LIMIT }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ durationLimit: limit }));
  fs.writeFileSync(path.join(dir, '脚本.md'), script);
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), script.split(/^## S\d+/m).slice(1).map(() => 'root => ({render(){}})').join('\n//---\n'));
  if (subs) fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ subs, scenes: subs.scenes }));
  return dir;
}

const S = (n, title, sec, deps = '') => `## S${n} · ${title}
1. 这是第 ${n} 场的测试旁白内容，用来验证依赖解析与删除建议是否正确工作。
← 依赖：${deps || '无'}
← 可带走：测试

`;

test('发布文案标签：解析「## 标签」小节的 bullet 与 # 前缀', () => {
  const md = `## 标题
测试标题

## 标签
- Codex
- #AI编程
- 新手入门

## 简介
简介。

## 封面文案
主：封面
`;
  const p = parsePublish(md);
  assert.deepEqual(p.tags, ['Codex', 'AI编程', '新手入门']);
  assert.equal(p.main, '测试标题');
});

test('发布文案没有标签小节时返回空数组，不报错', () => {
  const p = parsePublish('## 标题\n只有标题\n## 简介\nx');
  assert.deepEqual(p.tags, []);
});

test('依赖解析：只取 S 编号，忽略"无"', t => {
  const dir = project(t, { script: S(1, '开场', 20) + S(2, '第二', 20, 'S1') + S(3, '第三', 20, 'S1、S2') });
  const deps = dependencies(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'));
  assert.deepEqual(deps.map(d => d.refs), [[], [1], [1, 2]]);
});

test('有时长缓存时用实测；没有时用估算', t => {
  const script = S(1, '一', 20) + S(2, '二', 20, 'S1');
  const withTiming = project(t, { script, subs: { subs: [], scenes: [[0, 10], [10, 30]] } });
  assert.equal(sceneDurations(withTiming, dependencies(script)).source, '实测');
  const noTiming = project(t, { script });
  const est = sceneDurations(noTiming, dependencies(script));
  assert.equal(est.source, '估算');
  assert.ok(est.list.every(v => v > 0));
});

test('只整场删"零依赖"的场；被依赖的场只提议场内压缩', t => {
  // 4 场各 60s = 240s，上限 240 → 不超；改成 5 场让总时长 300
  const script = S(1, '开场', 20) + S(2, '支线A', 60, 'S1') + S(3, '支线B', 60, 'S2') +
                 S(4, '独立支线', 60, 'S1') + S(5, '收尾', 60, 'S4');
  const dir = project(t, { script, subs: { subs: [], scenes: [[0, 20], [20, 80], [80, 140], [140, 200], [200, 260]] } });
  const plan = trimPlan(dir, { limit: { maxSeconds: 240, targetSeconds: 210 } });
  assert.ok(plan.over > 0);
  // S4 被 S5 依赖（refCount=1）→ 不能整场删
  assert.equal(plan.cuts.some(c => c.n === 4), false);
  // 只有真正零依赖的场才进 cuts
  for (const c of plan.cuts) assert.equal(c.refCount, 0);
  // 不够删时给出可压缩场
  if (!plan.enough) assert.ok(plan.compressible.length > 0);
});

test('开场/收尾/广告/指定保留场不参与删除', t => {
  const script = S(1, '开场', 30) + S(2, '广告', 30, '无') + S(3, '支线', 200, 'S1') + S(4, '收尾', 30, 'S3');
  const dir = project(t, { script, subs: { subs: [], scenes: [[0, 30], [30, 60], [60, 260], [260, 290]] } });
  const plan = trimPlan(dir, { limit: { maxSeconds: 240, targetSeconds: 210 }, keepScenes: [3] });
  const locked = plan.scenes.filter(s => s.structural).map(s => s.n);
  assert.ok(locked.includes(1) && locked.includes(2) && locked.includes(4));
  assert.ok(locked.includes(3));  // 用户指定保留
  assert.equal(plan.cuts.length, 0);
});

test('未超时：不给删减建议', t => {
  const script = S(1, '开场', 30) + S(2, '收尾', 30, 'S1');
  const dir = project(t, { script, subs: { subs: [], scenes: [[0, 30], [30, 60]] } });
  const plan = trimPlan(dir, { limit: { maxSeconds: 240, targetSeconds: 210 } });
  assert.equal(plan.over, 0);
  assert.equal(plan.cuts.length, 0);
  assert.match(plan.notes.join(' '), /不需要删减/);
});

test('估算模式要警告"别按估算砍内容"', t => {
  const script = S(1, '开场', 30) + S(2, '长支线', 300, 'S1');
  const dir = project(t, { script });   // 无 timing.json
  const plan = trimPlan(dir, { limit: { maxSeconds: 240, targetSeconds: 210 } });
  assert.equal(plan.source, '估算');
  // 不管超没超，估算模式都要提示先实测
  assert.match(plan.notes.join(' '), /估算.*时长/);
  assert.match(plan.notes.join(' '), /vh measure/);
});

test('超时错误信息带超出秒数、两条出路与 trim 指引', () => {
  const msg = durationLimitError(EXPLICIT_LIMIT, EXPLICIT_LIMIT.maxSeconds + 25.32);
  assert.match(msg, new RegExp('超过当前上限 ' + EXPLICIT_LIMIT.maxSeconds));
  assert.match(msg, /25\.3 秒/);
  // 两条路都要给：删内容，或由用户决定放宽上限
  assert.match(msg, /vh trim/);
  assert.match(msg, /duration --max/);
  assert.match(msg, /加速旁白/);
});

/* 真实事故：timing.json 的 dur=480.13，但场次区间合计只有 477.18（差的是
 * 片头 0.5s 与场间间隙）。删减顾问按 477.18 判断"没超、需削减 0 秒"，
 * 同一个时间轴却被渲染闸门判为超时 0.13 秒——模型收到"削减 0s"的任务，
 * 无论怎么改都不可能让闸门通过。两边必须用同一个总长。 */
test('实测场次时长之和必须等于 DURATION：含片头/场间间隙，不能对同一时间轴算出两个总长', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trim-span-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 开场\n1. 第一句。\n← 依赖：无\n\n## S2 · 收尾\n1. 第二句。\n← 依赖：S1\n');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), 'root=>{}\n//---\nroot=>{}\n');
  fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ dur: 100,
    scenes: [[0.5, 40.5], [40.85, 70.85]], subs: [{ s: 0.5, e: 40.5, t: '第一句。' }, { s: 40.85, e: 70.85, t: '第二句。' }] }));
  const deps = dependencies(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'));
  const { list } = sceneDurations(dir, deps);
  const sum = +list.reduce((a, b) => a + b, 0).toFixed(2);
  assert.equal(sum, 100, '场次时长之和必须等于 DURATION，实际 ' + sum + ' / ' + JSON.stringify(list));
  const plan = trimPlan(dir, { limit: { maxSeconds: 100 } });
  assert.equal(plan.total, 100, '删减顾问的总长必须与渲染闸门一致：' + plan.total);
  assert.equal(plan.over, 0);
});

test('零引用和低语速不被宣称语义可删，无候选时仍保留缩范围/拆集出路', t => {
  const script = S(1, '开场', 30) + S(2, '必要过程', 200, 'S1') + S(3, '收尾', 30, 'S2');
  const dir = project(t, { script, subs: { subs: [], scenes: [[0, 30], [30, 230], [230, 260]] } });
  const plan = trimPlan(dir, { limit: { maxSeconds: 240 } });
  assert.equal(plan.requiresSemanticReview, true);
  assert.match(plan.notes.join(' '), /缩小支线.*拆集/);
  assert.doesNotMatch(plan.notes.join(' '), /链条不断|只能.*场内压缩|最.?水|砍 1–2/);
});
