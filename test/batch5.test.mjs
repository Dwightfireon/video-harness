import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect, setOrient, orientOf } from '../lib/portrait.mjs';
import { analyze as costAnalyze, report as costReport } from '../lib/cost.mjs';

const mk = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-b5-'));
  for (const [n, b] of Object.entries(files)) {
    const p = path.join(d, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b);
  }
  return d;
};

/* ---------- portrait ---------- */
const TPL = "const ORIENT = 'landscape';\nconst PRESET = {};\n";

test('portrait：能切换并读回方向', () => {
  const d = mk({ 'engine.tpl.html': TPL });
  assert.equal(orientOf(d), 'landscape');
  assert.equal(setOrient(d, 'portrait').ok, true);
  assert.equal(orientOf(d), 'portrait');
});

test('portrait：找不到 ORIENT 行时明确报错（不静默）', () => {
  const d = mk({ 'engine.tpl.html': 'no orient here' });
  const r = setOrient(d, 'portrait');
  assert.equal(r.ok, false);
  assert.match(r.error, /ORIENT/);
});

/* 适配检查现在读 scene.html 里的字面量坐标（旧实现读 scenes.src.js，
   而配方写的是 Math.round(S.W*0.6)，一个都扫不到 → 检查等于没有） */
test('portrait：1920 宽的坐标在竖屏下被查出溢出', () => {
  const html = `const ORIENT = 'landscape';
addScene(0, 5, root => { const a = abs(mk('div',''), 140, 300, 1600, 100); return {}; });`;
  const d = mk({ 'scene.html': html, 'engine.tpl.html': TPL });
  const fit = inspect(d);
  assert.equal(fit.ok, false);
  assert.ok(fit.problems.some(p => p.kind === 'hardcoded'), JSON.stringify(fit.problems));
});

test('portrait：窄坐标在竖屏下通过', () => {
  const html = `const ORIENT = 'landscape';
addScene(0, 5, root => { const a = abs(mk('div',''), 72, 300, 900, 100); return {}; });`;
  const d = mk({ 'scene.html': html, 'engine.tpl.html': TPL });
  assert.equal(inspect(d).ok, true);
});

test('portrait：只用相对量算坐标（配方写法）时通过', () => {
  const html = `const ORIENT = 'landscape';
const S = window.VH_UI.safeArea();
addScene(0, 5, root => { const a = abs(mk('div',''), S.pad, Math.round(S.top + S.h * 0.2), Math.round(S.W * 0.6), 100); return {}; });`;
  const d = mk({ 'scene.html': html, 'engine.tpl.html': TPL });
  const fit = inspect(d);
  assert.equal(fit.ok, true, JSON.stringify(fit));
  assert.equal(fit.hardcodedCount, 0);
});

/* ---------- cost ---------- */
test('cost：统计步数、改过的文件、轮次', () => {
  const log = `══ 用户 10:00：改标题
· write_file {"path":"scenes.src.js"}
· run {"command":"node vh.mjs build"}
══ 用户 10:05：再压短
· write_file {"path":"scenes.src.js"}
· run {"command":"node vh.mjs render"}
`;
  const d = mk({ 'out/.vh-chat.log': log });
  const r = costAnalyze(d);
  assert.equal(r.ok, true);
  assert.equal(r.steps, 4);
  assert.equal(r.rounds.length, 2);
  assert.deepEqual(r.writes, ['scenes.src.js']);
  assert.equal(r.commands.build, 1);
  assert.equal(r.commands.render, 1);
});

test('cost：没有 usage 时不编造金额，明说拿不到', () => {
  const d = mk({ 'out/.vh-chat.log': '· write_file {"path":"a"}\n' });
  const text = costReport(costAnalyze(d));
  assert.match(text, /不报|拿不到|还没有 usage/);
  assert.ok(!/¥\d/.test(text), '不该出现具体金额');
  assert.ok(!/\$\d/.test(text), '没有 usage 就不该出现美元金额');
});

test('cost：有 usage 时报真实金额与缓存命中率', () => {
  const d = mk({
    'out/.vh-chat.log': '· write_file {"path":"a"}\n',
    'out/.vh-state.json': JSON.stringify({ usage: {
      requests: 10, prompt: 1_000_000, cached: 900_000, uncached: 100_000,
      completion: 50_000, reasoning: 10_000, at: '2026-10-20T00:00:00.000Z' } }),
  });
  const r = costAnalyze(d);
  assert.equal(r.ok, true);
  assert.equal(r.usage.requests, 10);
  assert.equal(r.usage.cached, 900_000);
  // 输入未命中 0.1M×$0.30 + 输出 0.05M×$1.20 + 缓存 0.9M×$0.006 = 0.03 + 0.06 + 0.0054
  assert.ok(Math.abs(r.cost.usd - 0.0954) < 1e-9, '金额应按官方价目折算，实际 ' + r.cost.usd);
  assert.ok(Math.abs(r.cost.hitRate - 0.9) < 1e-9);
  const text = costReport(r);
  assert.match(text, /缓存命中率 90\.0%/);
  assert.match(text, /\$0\.0954/);
});

test('cost：没有日志时明确说明（不崩）', () => {
  const d = mk({ 'PROJECT.json': '{}' });
  const r = costAnalyze(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /还没有运行记录/);
});
