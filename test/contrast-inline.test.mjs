import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, contrastRatio } from '../lib/contrast.mjs';

function fixture(t, scene, engine = ':root{--bg:#F6F7F6;--dark:#16211A;--card:#FFFFFF}') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-contrast-inline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), scene);
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), engine);
  return dir;
}

test('内联 var(--ink3, #hex) 也要按真实底色算对比度，不能因为“没有配色表”放过', t => {
  const scene = `root => {
  const card = mk('div', '', '说明文字');
  card.style.cssText += 'background:var(--surface,#14161b);color:var(--ink3,#6b7382);font-size:19px';
  return { render() {} };
}`;
  const result = analyze(fixture(t, scene));
  assert.ok(result.findings.length > 0, '深卡上的灰字应当被报出：' + JSON.stringify(result));
  const hit = result.findings.find(f => f.color.toLowerCase() === '#6b7382');
  assert.ok(hit, '应报出 #6b7382');
  assert.ok(hit.ratio < 4.5, '对比度应低于 4.5:1，实际 ' + hit.ratio);
  assert.equal(result.ok, false);
});

test('白字配深底、深字配浅底不误报', t => {
  const scene = `root => {
  const a = mk('div', '', '正文');
  a.style.cssText += 'background:var(--surface,#14161b);color:var(--ink,#eef1f6);font-size:26px';
  const b = mk('div', '', '正文');
  b.style.cssText += 'color:var(--inkDark,#1E2721);font-size:26px';
  return { render() {} };
}`;
  const result = analyze(fixture(t, scene));
  assert.equal(result.findings.filter(f => f.kind === 'contrast-inline').length, 0, JSON.stringify(result.findings));
});

test('大字用 3:1、正文用 4.5:1 分档，小字灰字必须报', t => {
  const scene = `root => {
  const big = mk('div', '', '大字');
  big.style.cssText += 'color:var(--ink3,#6b7382);font-size:30px';
  const small = mk('div', '', '小字');
  small.style.cssText += 'color:var(--ink3,#6b7382);font-size:16px';
  return { render() {} };
}`;
  const result = analyze(fixture(t, scene));
  const inline = result.findings.filter(f => f.kind === 'contrast-inline');
  assert.ok(inline.some(f => f.need === 4.5), '小字应要求 4.5:1');
});

test('对比度算法本身符合 WCAG 参考值', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.1);
  assert.ok(Math.abs(contrastRatio('#FFFFFF', '#FFFFFF') - 1) < 0.01);
});
