import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { breakLine, vwidth, fitPlan, report, repairSubtitleTemplate } from '../lib/subtitle.mjs';
import vm from 'node:vm';

/* 字幕断行：为什么值得测
   浏览器随手断行的真实观感问题：
     · 中文断在"的/了"前面（读起来卡）
     · 英文断在词中间（PostgreSQL → Postgre / SQL）
     · 标点落在行首
   还有一条硬约束：字幕一变两行就往上长，压住正文（竖屏尤其明显）。 */

test('subtitle：英文词不会被拆开', () => {
  const lines = breakLine('PostgreSQL 默认配置是给开发机用的，不是给生产用的。', 16, 2);
  const joined = lines.join('');
  assert.ok(joined.includes('PostgreSQL'), 'PostgreSQL 应完整保留：' + JSON.stringify(lines));
  for (const l of lines) assert.ok(!/Postgre$/.test(l), '不能把 Postgre 单独留在行尾：' + JSON.stringify(lines));
});

test('subtitle：优先在标点后断行', () => {
  const lines = breakLine('FastAPI 的价值不在快，在于它把接口契约变成代码本身。', 18, 2);
  assert.equal(lines.length, 2);
  assert.ok(/[，,]$/.test(lines[0]) || /[。]$/.test(lines[0]), '第一行应停在标点后：' + JSON.stringify(lines));
});

test('subtitle：标点不会落在行首', () => {
  for (const t of [
    '一个 bundle 从 2MB 降到 400KB，首屏就快了两秒。',
    '你写一个函数，它同时是文档、是校验、是类型。',
    '容器里跑 Python，最容易忽略的是时区和编码。',
  ]) {
    const lines = breakLine(t, 14, 3);
    for (const l of lines) assert.ok(!/^[，。、；：！？]/.test(l), '标点落在行首：' + JSON.stringify(lines));
  }
});

test('subtitle：视觉宽度——中文算 1、ASCII 算 0.55', () => {
  assert.equal(Math.round(vwidth('中文')), 2);
  assert.ok(Math.abs(vwidth('abcd') - 2.2) < 0.01);
  // 10 个 ASCII ≠ 10 个中文字的宽度
  assert.ok(vwidth('PostgreSQL') < vwidth('十个中文字宽度啊'));
});

test('subtitle：短句不硬断', () => {
  assert.deepEqual(breakLine('一句话。', 18, 2), ['一句话。']);
});

test('subtitle：超长句不能为满足 maxLines 而截掉后半句', () => {
  const long = '这是一句非常非常长的旁白，'.repeat(6);
  const lines = breakLine(long, 16, 2);
  assert.ok(lines.length > 2, JSON.stringify(lines));
  assert.equal(lines.join(''), long);
  for (const line of lines) assert.ok(vwidth(line) <= 17, line);
});

test('subtitle：孔子长句和长英文串均完整保留尾部', () => {
  for (const text of ['第一段里，子贡把"贫而无谄、富而无骄"当作很高的标准提出来，孔子说：可以了，但还不如贫而乐、富而好礼。',
    '孔子立刻说：赐啊，现在可以和你谈诗了——告诸往而知来者，告诉你过去的事，你能推知别的事。',
    'x'.repeat(140) + '结尾不能丢。']) {
    for (const width of [18, 25, 35]) assert.equal(breakLine(text, width, 2).join(''), text);
  }
  assert.throws(() => breakLine('测试', 0), /正数/);
});

test('subtitle：fitPlan 按当前方向取参数（竖屏 perLine 与横屏不同）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sub-'));
  const make = (orient, W, H, font, maxW) => `const ORIENT = '${orient}';
const PRESET = {
  landscape: { W: 1920, H: 1080, subBottom: 52, subFont: 40, subMaxW: 1560 },
  portrait: { W: 1080, H: 1920, subBottom: 430, subFont: 34, subMaxW: 940 },
};
${orient === 'portrait' ? '' : ''}
`;
  const html = `const ORIENT = 'portrait';
const PRESET = {
  landscape: { W: 1920, H: 1080, subBottom: 52, subFont: 40, subMaxW: 1560 },
  portrait: { W: 1080, H: 1920, subBottom: 430, subFont: 34, subMaxW: 940 },
};
const SUBS = [{"s":0,"e":3,"t":"一句很长的字幕，用来测试竖屏下会不会变成两行。"}];
addScene(0, 3, root => {});
`;
  fs.writeFileSync(path.join(d, 'scene.html'), html, 'utf8');
  const plan = fitPlan(d);
  assert.equal(plan.W, 1080);
  assert.equal(plan.H, 1920);
  assert.equal(plan.subFont, 34, '竖屏应取 34 号字幕，不是横屏的 40');
  assert.equal(plan.perLine, Math.floor((940 - 82) / 34) - 1);
});

test('subtitle：fitPlan 算出正文底边（字幕条往上让位）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sub2-'));
  const html = `const ORIENT = 'portrait';
const PRESET = {
  landscape: { W: 1920, H: 1080, subBottom: 52, subFont: 40, subMaxW: 1560 },
  portrait: { W: 1080, H: 1920, subBottom: 430, subFont: 34, subMaxW: 940 },
};
const SUBS = [{"s":0,"e":2,"t":"短句"},{"s":2,"e":4,"t":"一句需要折成两行的长字幕，长度要超过每行预算才行。"}];
addScene(0, 4, root => {});
`;
  fs.writeFileSync(path.join(d, 'scene.html'), html, 'utf8');
  const plan = fitPlan(d);
  const s1 = plan.scenes[0];
  assert.ok(s1.safeBottom < plan.H, '正文底边必须小于画布高');
  assert.ok(s1.subTop < plan.H && s1.subTop > 0, '字幕顶边要在画面内');
  assert.ok(s1.safeBottom < s1.subTop, '正文底边必须在字幕顶边之上');
});

test('subtitle：report 说清口径（不是审美判断）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sub3-'));
  fs.writeFileSync(path.join(d, 'scene.html'), `const ORIENT = 'landscape';
const PRESET = { landscape: { W: 1920, H: 1080, subBottom: 52, subFont: 40, subMaxW: 1560 }, portrait: { W:1080,H:1920,subBottom:430,subFont:34,subMaxW:940 } };
const SUBS = [{"s":0,"e":2,"t":"一句话"}];
addScene(0, 2, root => {});
`, 'utf8');
  const t = report(fitPlan(d));
  assert.match(t, /每行可放/);
  assert.match(t, /safeArea|安全区/);
});

test('subtitle：浏览器断行和 Node 检查器对长句的结果一致且不丢字', () => {
  const fx = fs.readFileSync(new URL('../assets/fx-block.html', import.meta.url), 'utf8');
  const code = fx.slice(fx.indexOf('function subtitleBreaker(maxW) {'), fx.indexOf('/* 接管字幕：'));
  const context = vm.createContext({}); vm.runInContext(code, context);
  for (const text of ['孔子立刻说：赐啊，现在可以和你谈诗了——告诸往而知来者，告诉你过去的事，你能推知别的事。',
    '这是一句非常非常长的旁白，'.repeat(6), 'PostgreSQL 默认配置是给开发机用的，不是给生产用的。', 'x'.repeat(100)]) {
    for (const width of [18, 25, 35]) {
      const lines = context.subtitleBreaker(width)(text);
      assert.equal(lines.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
      assert.deepEqual(Array.from(lines), breakLine(text, width));
    }
  }
});

test('subtitle：旧模板只修字幕块、先备份、幂等；自定义实现不覆盖', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-subs-repair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fx = fs.readFileSync(new URL('../assets/fx-block.html', import.meta.url), 'utf8');
  const old = 'AUTHOR PREFIX\nfunction subtitleBreaker(maxW) { if (lines.length >= 2) break; return lines.slice(0, 2); }\n' +
    'window.VH_UI = Object.assign(window.VH_UI || {}, { subtitleBreaker });\nAUTHOR SUFFIX';
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), old);
  const r = repairSubtitleTemplate(dir, fx);
  assert.equal(r.changed, true); assert.equal(fs.readFileSync(r.backup, 'utf8'), old);
  const result = fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8');
  assert.ok(result.startsWith('AUTHOR PREFIX')); assert.ok(result.endsWith('AUTHOR SUFFIX'));
  assert.match(result, /patched\.__lossless = true/);
  assert.equal(repairSubtitleTemplate(dir, fx).changed, false);
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), old.replace('return lines.slice(0, 2);', 'return custom;'));
  assert.equal(repairSubtitleTemplate(dir, fx).changed, false);
});
