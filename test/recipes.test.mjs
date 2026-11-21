import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECIPES, list, get, promptHints } from '../lib/scene-recipes.mjs';

/* 配方库：为什么值得测
   真实事故——引擎有 oneTake / stack / windowMock 等 21 个助手，
   但 5 支片子里 3 支是「标题+列表」，因为 agent 不会用。
   配方库的价值全在"能不能直接跑"，所以这里测骨架的硬约束。 */

test('配方：8 个配方都在，且每个都有名称与适用场景', () => {
  const items = list();
  assert.equal(items.length, 8);
  for (const r of items) {
    assert.ok(r.name && r.name.length >= 2, `${r.key} 缺名称`);
    assert.ok(r.when && r.when.length >= 8, `${r.key} 缺适用场景`);
  }
});

test('配方：坐标必须用 window.W / window.H（否则竖屏必错）', () => {
  for (const [key, r] of Object.entries(RECIPES)) {
    const code = r.code();
    assert.match(code, /window\.(W|H)/, `${key} 没有用 window.W/H —— 竖屏会被裁`);
    // 硬编码的 1920/1080 只允许出现在"换算比例"里（如 W * 0.5），不许直接定坐标
    const hard = [...code.matchAll(/abs\([^)]*\b(1920|1080)\b/g)].map(m => m[0]);
    assert.deepEqual(hard, [], `${key} 有硬编码 1080p 坐标：${hard.join(' / ')}`);
  }
});

test('配方：场内注释不能以 // 开头（gen.mjs 会把注释提到 addScene 上方，挤掉 @layout）', () => {
  for (const [key, r] of Object.entries(RECIPES)) {
    const code = r.code();
    const slash = code.split('\n').filter(l => /^\s{2,}\/\//.test(l));
    assert.deepEqual(slash, [], `${key} 有行内 // 注释，会被提到 @layout 之前：\n${slash.join('\n')}`);
  }
});

test('配方：每段代码能通过语法解析（真的能跑，不是伪代码）', () => {
  for (const [key, r] of Object.entries(RECIPES)) {
    const code = r.code();
    assert.doesNotThrow(() => new Function('return (' + code + ')'), `${key} 语法不合法`);
  }
});

test('配方：卡片/窗口必须填真实内容（空卡片 = 白屏）', () => {
  const ot = RECIPES['one-take'].code();
  assert.match(ot, /rows\.forEach/, 'one-take 的卡片应有多行真实条目');
  assert.ok(!/windowMock\([^)]*\);\s*\n\s*\/\*\s*$/.test(ot), '不允许只画一个空窗口');
});

test('配方：给 agent 的提示里带配方名与调用方式', () => {
  const h = promptHints();
  for (const k of ['hero-statement', 'compare-bars', 'process-steps', 'window-walkthrough', 'one-take', 'funnel-flow', 'state-chain', 'curve-reveal']) {
    assert.ok(h.includes(k), '提示里缺 ' + k);
  }
  assert.match(h, /vh\.mjs scene/);
});

test('配方：不存在的配方返回 null（不抛异常）', () => {
  assert.equal(get('nope'), null);
});
