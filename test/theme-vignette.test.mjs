/* 真实事故：项目按「深底 + 琥珀强调」写的 scenes.src.js，engine 却是浅色暖纸底。
 * 用户点了「应用暗色方向」后，画面中间糊起一层灰白云雾 —— 因为 .vignette 的中心辉光
 * 硬编码成 rgba(255,255,255,.55)，只在浅色纸底上成立。深底上它把每一处浅字都压成
 * 2:1 以下的灰字，实测对比度从 12:1 掉到 1.7:1，渲染直接被闸门拦住。
 *
 * 这条测试锁两件事：
 *  1) .vignette 的中心色必须走变量（主题能改它），不能再写字面色；
 *  2) 每个美术方向的 --vignette 必须存在，且深色方向的强度要明显低于浅色方向。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THEMES, applyTheme } from '../lib/theme.mjs';

const readAsset = name => fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', name), 'utf8');
/* 引擎模板在 skill 目录（~/.config/opencode/skills/article-video/assets）。
 * 没装 skill 的机器跳过引擎断言，而不是让整套测试变红。 */
const skillEngine = [
  process.env.ARTICLE_VIDEO_SKILL && path.join(process.env.ARTICLE_VIDEO_SKILL, 'assets', 'engine.tpl.html'),
  path.join(os.homedir(), '.config', 'opencode', 'skills', 'article-video', 'assets', 'engine.tpl.html'),
].filter(Boolean).find(p => fs.existsSync(p));
const engineCss = skillEngine ? fs.readFileSync(skillEngine, 'utf8') : null;

test('引擎：.vignette 中心色走变量，不写死白色', { skip: !engineCss && '未安装 article-video skill' }, () => {
  const block = engineCss.match(/\.vignette\{[^}]*\}/)?.[0] || '';
  assert.ok(block, '.vignette 规则应当存在');
  assert.match(block, /var\(--vignette\)/, '.vignette 的中心色必须用 var(--vignette)；写死 rgba(255,255,255,…) 会在深色主题上糊一层白雾');
  assert.doesNotMatch(block, /rgba\(255,\s*255,\s*255,\s*\.5/, '.vignette 里不应再出现高强度白色字面量');
});

test('引擎：:root 定义了 --vignette，换主题时有落脚点', { skip: !engineCss && '未安装 article-video skill' }, () => {
  const root = engineCss.slice(engineCss.indexOf(':root{'), engineCss.indexOf('}', engineCss.indexOf(':root{')));
  assert.match(root, /--vignette\s*:/, ':root 必须定义 --vignette，否则 applyTheme 无处可改');
});

test('主题：applyTheme 真的能把 --vignette 写进模板', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-vignette-'));
  try {
    fs.writeFileSync(path.join(dir, 'engine.tpl.html'),
      ':root{\n  --bg:#F6F7F6;\n  --vignette:rgba(255,255,255,.55);\n}\n.vignette{background:radial-gradient(var(--vignette),transparent)}', 'utf8');
    const result = applyTheme(dir, 'dark-stage');
    assert.ok(result.ok, result.error);
    const out = fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8');
    assert.match(out, /--vignette:\s*rgba\(255,255,255,\.045\)/, '深色方向必须把 --vignette 压到极低强度');
    assert.ok(!result.missing.includes('--vignette'), '--vignette 不应被列为缺失变量');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('主题：每个方向都给了 --vignette', () => {
  for (const [key, theme] of Object.entries(THEMES)) {
    assert.ok(theme.vars['--vignette'], `方向「${key}」缺 --vignette：换主题后中心辉光会沿用上一个方向的值`);
  }
});

test('主题：深色方向的中心辉光必须比浅色方向弱得多', () => {
  const alpha = value => {
    const m = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(String(value));
    return m ? +m[1] : 1;
  };
  const dark = alpha(THEMES['dark-stage'].vars['--vignette']);
  const light = Math.max(alpha(THEMES['warm-paper'].vars['--vignette']), alpha(THEMES.documentary.vars['--vignette']));
  assert.ok(dark < light / 4, `深色方向的 --vignette 透明度 ${dark} 相对浅色 ${light} 不够低：深底上同等强度就是"白雾"`);
});
