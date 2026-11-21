import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, parseScenes, estimateSeconds } from '../lib/depth.mjs';
import { analyze as clarityAnalyze } from '../lib/clarity.mjs';
import { analyze as layoutAnalyze } from '../lib/layout-check.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpProject = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-test-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
};

/* ---------- 1) 解析：脚本场次 ---------- */
test('parseScenes：只认 ## Sn，不被其它标题干扰', () => {
  const md = `# 标题\n\n## S1 · 开场\n1. 第一句。\n2. 第二句。\n\n← 依赖：无\n\n## 术语\n| a | b |\n\n## S2 · 结尾\n1. 第三句。\n\n← 依赖：S1 立起的判断\n`;
  const sc = parseScenes(md);
  assert.equal(sc.length, 2);
  assert.equal(sc[0].n, 1);
  assert.equal(sc[0].lines.length, 2);
  assert.equal(sc[0].deps, '无');
  assert.equal(sc[1].deps, 'S1 立起的判断');
});

/* ---------- 2) 估时与 gen.mjs 口径一致 ---------- */
test('estimateSeconds：与 gen 的 cjk/3.4 同口径', () => {
  const sc = [{ n: 1, title: '', lines: ['中文十个字中文十个字'], deps: '无' }];
  const est = estimateSeconds(sc);
  // LEAD .5 + 一句(max(.9, 11/3.4)+.4) + BEAT .5
  assert.ok(est > 4 && est < 6, `est=${est}`);
});

/* ---------- 3) 深度体检：短句密集会被判不足 ---------- */
test('depth：6 场 × 3 句短句 → 判定展开度不足', () => {
  let md = '';
  for (let i = 1; i <= 6; i++) {
    md += `## S${i} · 场 ${i}\n1. 短句。\n2. 也短。\n3. 还是短。\n\n← 依赖：${i === 1 ? '无' : 'S' + (i - 1)}\n\n`;
  }
  const dir = tmpProject({ '脚本.md': md, '方案.md': '目标时长：5 分钟\n' });
  const res = analyze(dir);
  assert.equal(res.ok, false);
  assert.ok(res.hard.some(h => /展开度|场/.test(h)));
});

/* ---------- 4) 深度体检：目标时长正则能吃 **目标时长：4 分钟** ---------- */
test('depth：解析「**目标时长：4 分钟**」这种写法', () => {
  const md = Array.from({ length: 8 }, (_, i) =>
    `## S${i + 1} · 场\n1. 因为所以，这是一句足够长的旁白用来凑字数同时说明机制。\n2. 举个例子，这是第二句具体场景的说明文字，应该足够长。\n3. 边界是：这种情况不适用，别这么做才对。\n4. 一句话记住这一场的判据是什么。\n\n← 依赖：${i === 0 ? '无' : 'S' + i}\n\n`).join('');
  const dir = tmpProject({ '脚本.md': md, '方案.md': '**目标时长：4 分钟**（讲解型）\n' });
  const res = analyze(dir);
  assert.equal(res.target, 240, `target=${res.target}`);
});

/* ---------- 5) 解释质量：引号里的台词不算「未定义术语」 ---------- */
test('clarity：台词/口语引号不算术语，概念引号算', () => {
  const md = `**主体**：测试\n\n## S1 · 开场\n1. 你说「行，我看看」，这就是讨好。\n2. 这一期讲清楚「边界两件套」是什么。\n\n← 依赖：无\n`;
  const dir = tmpProject({ '脚本.md': md, '方案.md': '已经知道：讨好\n不知道：边界两件套\n' });
  const res = clarityAnalyze(dir);
  const terms = res.fail.join(' ');
  assert.ok(!/行，我看看/.test(terms), '台词被误判为术语：' + terms);
});

/* ---------- 6) 解释质量：依赖倒挂会被抓 ---------- */
test('clarity：依赖指向后面的场 → 判失败', () => {
  const md = `**主体**：测试\n\n## S1 · 开场\n1. 第一句。\n\n← 依赖：S2 的内容\n\n## S2 · 第二场\n1. 第二句。\n\n← 依赖：S1\n`;
  const dir = tmpProject({ '脚本.md': md, '方案.md': '' });
  const res = clarityAnalyze(dir);
  assert.ok(res.fail.some(f => /倒挂|后面|开场/.test(f)), JSON.stringify(res.fail));
});

/* ---------- 7) 版式：画面文字抄旁白会被抓 ---------- */
test('layout：画面正文抄旁白 → dup 命中', () => {
  const line = '这是一句足够长的旁白原句用来测试重复检测逻辑';
  const scenes = `root => {\n  const t = abs(mk('div',''), 140, 300, 800, 60);\n  t.textContent = '${line}';\n  root.appendChild(t);\n  return { render(){} };\n}\n`;
  const subs = `const SUBS = [{"s":1,"e":5,"t":"${line}"}];\nDURATION = 10;\n`;
  const dir = tmpProject({ 'scenes.src.js': scenes, 'scene.html': `<script>${subs}</script>` });
  const res = layoutAnalyze(dir);
  assert.ok(res.dupCount >= 1, JSON.stringify(res.findings));
});

/* ---------- 8) 版式：父子嵌套不是重叠 ---------- */
test('layout：一个元素在另一个里面 → 不算重叠', () => {
  const scenes = `root => {\n  const card = abs(mk('div',''), 140, 300, 800, 400);\n  const inner = abs(mk('div',''), 180, 340, 300, 120);\n  root.append(card, inner);\n  return { render(){} };\n}\n`;
  const dir = tmpProject({ 'scenes.src.js': scenes, 'scene.html': '<script>const SUBS=[];</script>' });
  const res = layoutAnalyze(dir);
  assert.equal(res.findings.filter(f => f.kind === 'overlap').length, 0, JSON.stringify(res.findings));
});

/* ---------- 9) 版式：压进字幕安全区会被抓 ---------- */
test('layout：元素底边进入字幕区 → safe 命中', () => {
  const scenes = `root => {\n  const t = abs(mk('div',''), 140, 820, 800, 100);\n  root.appendChild(t);\n  return { render(){} };\n}\n`;
  const dir = tmpProject({ 'scenes.src.js': scenes, 'scene.html': '<script>const SUBS=[];</script>' });
  const res = layoutAnalyze(dir);
  assert.ok(res.findings.some(f => f.kind === 'safe'), JSON.stringify(res.findings));
});
