import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, report, textOverlaps } from '../lib/fit.mjs';
import { layoutFindings, layoutTimes } from '../lib/layout-geometry.mjs';

test('真实部分重叠与完全重叠都必须检出，不能按面积豁免', () => {
  assert.equal(textOverlaps([
    { x: 407, y: 125, w: 214, h: 75, text: '一段区间' },
    { x: 470, y: 172, w: 1080, h: 50, text: '横轴按数量级说明' },
  ]).length, 1);
  const a = { x: 100, y: 100, w: 400, h: 60, text: '卡片标题' };
  assert.equal(textOverlaps([a, { ...a, text: '新增文字' }]).length, 1);
  assert.equal(textOverlaps([a, { x: 104, y: 104, w: 392, h: 52, text: '新增文字' }]).length, 1);
});

test('相邻行浮点舍入一致；有意叠放必须显式命名', () => {
  assert.equal(textOverlaps([
    { x: 140, y: 860, w: 276, h: 44 }, { x: 140, y: 896.4, w: 681, h: 34 },
  ]).length, 0);
  const a = { x: 100, y: 100, w: 300, h: 60, overlapGroup: 'title-shadow' };
  assert.equal(textOverlaps([a, { ...a }]).length, 0);
  assert.equal(textOverlaps([a, { ...a, overlapGroup: 'other' }]).length, 1);
});

test('同帧不同场转场层不互报；安全区和组件碰撞共享结构化结果', () => {
  const a = { x: 100, y: 100, w: 200, h: 60 };
  assert.equal(textOverlaps([{ ...a, scene: 1 }, { ...a, scene: 2 }]).length, 0);
  assert.equal(textOverlaps([{ ...a, scene: 0 }, { ...a, scene: 1 }]).length, 1, '全局标题与本场正文同时存在，不能按邻场转场豁免');
  const r = layoutFindings({ width: 500, height: 800, safeBottom: 700,
    texts: [{ ...a, y: 690, scene: 1, id: 'text', text: '压字幕' }],
    components: [{ ...a, id: 'card1', scene: 1, ancestors: [] }, { ...a, id: 'card2', scene: 1, ancestors: [] }] });
  assert.ok(r.some(f => f.kind === 'into-subtitle'));
  assert.ok(r.some(f => f.kind === 'component-overlap'));
});

test('采样包含入场、中后段、收尾与字幕触发边缘，且仅在场内', () => {
  const times = layoutTimes([[0, 10]], [{ s: 3, e: 4 }]).map(p => p.t);
  for (const t of [.15, .6, 2.8, 5.5, 8.5, 9.95, 2.95, 3.05, 3.95]) assert.ok(times.includes(t), String(t));
  assert.ok(times.every(t => t > 0 && t < 10));
  assert.throws(() => layoutTimes([[0, 10]], [], { step: 0 }));
});

test('fit 报告保留画布、问题、采样与能力边界', () => {
  const t = report({ ok: false, sampled: 5, geo: { W: 1920, H: 1080, subTop: 986 },
    findings: [{ kind: 'into-subtitle', scene: 2, t: 1, msg: '最低到 1000px，压进字幕区' }] });
  assert.match(t, /画布 1920×1080/); assert.match(t, /第 2 场/); assert.match(t, /1000px/);
  assert.match(t, /观众会直接看到/); assert.match(t, /不等于审美/);
  assert.match(report({ ok: true, sampled: 5, geo: {}, findings: [] }), /✓ 没有元素压字幕/);
});

test('没有场景不能静默通过', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-fit-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const missing = await analyze(d); assert.equal(missing.ok, false); assert.match(missing.note, /scene.html/);
  fs.writeFileSync(path.join(d, 'scene.html'), '<html></html>');
  const empty = await analyze(d); assert.equal(empty.ok, false); assert.equal(empty.sampled, 0);
});
