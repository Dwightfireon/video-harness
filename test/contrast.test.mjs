/* 真实事故：一支片子的 scenes.src.js 沿用了深色主题配色
 * （ink:#F2EFE9 米白、mut:#8A8F98 灰），而引擎已换成浅色纸底（#F6F7F6）。
 * 结果整片文字"看起来是透明的"：米白画在米白上，对比度只有 1.07:1。
 * 五个检查器全绿 —— 因为没有一个真的计算对比度。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, contrastRatio, luminance, flatten, themeBackgrounds } from '../lib/contrast.mjs';

const project = (t, { scenes, engine }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-contrast-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (scenes != null) fs.writeFileSync(path.join(dir, 'scenes.src.js'), scenes);
  if (engine != null) fs.writeFileSync(path.join(dir, 'engine.tpl.html'), engine);
  return dir;
};

const LIGHT_ENGINE = ':root{--bg:#F6F7F6;--ink:#1E2721;--dark:#16211A;--card:#FFFFFF}';

test('WCAG 对比度计算：纯黑白 21:1，同色 1:1', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF')), 21);
  assert.equal(+contrastRatio('#F6F7F6', '#F6F7F6').toFixed(2), 1);
  // 米白画在浅纸上：这就是事故里的 1.07
  assert.ok(contrastRatio('#F2EFE9', '#F6F7F6') < 1.1);
});

test('回归：深色配色用在浅色纸底上，必须被报出来', t => {
  const dir = project(t, {
    engine: LIGHT_ENGINE,
    scenes: `// @layout 标题
const C = { clay:'#D97757', teal:'#10A37F', ink:'#F2EFE9', mut:'#8A8F98', line:'rgba(255,255,255,.14)' };
root => {}
//---
// @layout 双列
const C = { clay:'#D97757', teal:'#10A37F', ink:'#F2EFE9', mut:'#8A8F98', line:'rgba(255,255,255,.14)' };
root => {}
`,
  });
  const r = analyze(dir);
  assert.equal(r.ok, false, '这种配色必须判不合格');
  // 最关键：正文色 ink 必须被抓出来
  const inkFails = r.findings.filter(f => f.key === 'ink');
  assert.ok(inkFails.length >= 2, '每场的 ink 都要报出来');
  assert.ok(inkFails[0].ratio < 1.2, 'ink 的实际对比度应接近 1:1');
  assert.match(inkFails[0].msg, /看不清/);
});

test('适配浅色纸的配色应当通过', t => {
  const dir = project(t, {
    engine: LIGHT_ENGINE,
    scenes: `// @layout 标题
const C = { clay:'#B4532F', teal:'#0F6E57', ink:'#1E2721', mut:'#5D685F', line:'#E2E8E1' };
root => {}
`,
  });
  const r = analyze(dir);
  assert.equal(r.ok, true, '对比度达标的配色不该被误报：' + JSON.stringify(r.findings));
});

test('半透明文字会被额外压暗，也要报出来', t => {
  const dir = project(t, {
    engine: LIGHT_ENGINE,
    scenes: `// @layout 标题
const C = { ink:'#1E2721', mut:'#5D685F', line:'#E2E8E1' };
el(x, '文字', 'color:'+C.ink+';opacity:.2;');
root => {}
`,
  });
  const r = analyze(dir);
  const alpha = r.findings.filter(f => f.kind === 'contrast-alpha');
  assert.ok(alpha.length >= 1, 'opacity 会进一步降低可读性，必须提示');
});

test('深色场（@tone dark）按深色底判断，不误报', t => {
  const dir = project(t, {
    engine: LIGHT_ENGINE,
    scenes: `// @tone dark
// @layout 终端
const C = { ink:'#F2EFE9', mut:'#B9C2BA', line:'#2A3A2E' };
root => {}
`,
  });
  const r = analyze(dir);
  assert.equal(r.ok, true, '深色场里的浅色文字是正确的，不该报错：' + JSON.stringify(r.findings));
});

test('能读出主题的纸色与深色，供检查使用', () => {
  const t = themeBackgrounds(LIGHT_ENGINE);
  assert.equal(t.paper, '#F6F7F6');
  assert.equal(t.dark, '#16211A');
});

test('flatten 把半透明色合到底色上', () => {
  // 黑字 50% 透明度叠在白底上 = 灰
  const flat = flatten('#000000', '#FFFFFF', 0.5);
  assert.equal(flat, '#808080');
  // 完全不透明时保持原色
  assert.equal(flatten('#123456', '#FFFFFF', 1), '#123456');
});
