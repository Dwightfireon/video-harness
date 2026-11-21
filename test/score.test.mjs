import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compute, save, compare, report } from '../lib/score.mjs';

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-score-'));
  for (const [n, b] of Object.entries(files)) {
    const p = path.join(dir, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, b);
  }
  return dir;
};

const GOOD_SCRIPT = `# 测试

**主体**：测试

${Array.from({ length: 6 }, (_, i) =>
  `## S${i + 1} · 场 ${i + 1}\n1. 因为所以，这一句用来解释中间发生了什么机制，需要足够长。\n2. 举个例子，这里给一个具体场景说明，内容也要足够长一些。\n3. 边界是：这种情况不适用，别这么做才对，记住这条判据。\n4. 一句话收束：这一场观众要带走的就是这句，别忘。\n\n← 依赖：${i === 0 ? '无' : 'S' + i}\n`).join('')}`;

/* 把单场 builder 复制 6 份，用 //--- 分隔（否则会被当成一场） */
const sixScenes = (one) => Array.from({ length: 6 }, () => one.trim()).join('\n//---\n');

/* 六场、每场 30 秒的 scene.html（多场才能让时长类判定生效） */
const sixSceneHtml = () => '<script>const SUBS=[{"s":1,"e":5,"t":"x"}];'
  + Array.from({ length: 6 }, (_, i) => `addScene(${i * 15},${(i + 1) * 15},()=>{});`).join('')
  + 'DURATION=90;</script>';

const GOOD_SCENES = `root => {
  bg(root);
  const t = line('标题');
  abs(t.el, 140, 200, 1200, 100); type(t.el, 'h1');
  const track = abs(mk('div',''), 140, 380, 900, 26);
  const bar = abs(mk('div',''), 140, 380, 600, 26);
  const v = abs(mk('div','','73%'), 1080, 370, 200, 50); type(v,'h2');
  const k1 = abs(mk('div','','系统提示 27%'), 140, 450, 600, 40); type(k1,'body');
  const k2 = abs(mk('div','','工具描述 73%'), 140, 500, 600, 40); type(k2,'body');
  const src = abs(mk('div','','来源：一手测量 2026-09-11'), 140, 560, 900, 36); type(src,'note');
  root.append(t.el, track, bar, v, k1, k2, src);
  return { render(){} };
}`;

/* ---------- 1) 好项目：四关全过 ---------- */
test('score：好的项目四关全过', () => {
  const dir = mk({
    '脚本.md': GOOD_SCRIPT,
    '方案.md': '目标时长：3 分钟\n已经知道：测试\n',
    'scenes.src.js': sixScenes(GOOD_SCENES),
    'scene.html': sixSceneHtml(),
  });
  const r = compute(dir);
  assert.ok(r.okCount >= 2, JSON.stringify(r.dims));   // 至少 clarity/depth 应过
});

/* ---------- 2) 坏项目：画面只有标题 → screen 不过 ---------- */
test('score：画面只有标题 → screen 判失败', () => {
  const dir = mk({
    '脚本.md': GOOD_SCRIPT,
    '方案.md': '目标时长：3 分钟\n',
    'scenes.src.js': sixScenes(`root => {\n  bg(root);\n  const t = line('只有标题');\n  abs(t.el, 140, 300, 1200, 100); type(t.el,'h1');\n  root.appendChild(t.el);\n  return { render(){} };\n}`),
    'scene.html': sixSceneHtml(),
  });
  const r = compute(dir);
  assert.equal(r.dims.screen.ok, false, JSON.stringify(r.dims.screen));
});

/* ---------- 3) 回归对比：能指出哪一项变差 ---------- */
test('score：compare 能识别"变差"', () => {
  const dir = mk({ '脚本.md': GOOD_SCRIPT, '方案.md': '目标时长：3 分钟\n', 'scenes.src.js': sixScenes(GOOD_SCENES), 'scene.html': sixSceneHtml() });
  const first = compute(dir);
  save(dir, first);
  // 把画面改成只有标题 → screen 变差
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), sixScenes(`root => {\n  bg(root);\n  const t = line('标题');\n  abs(t.el, 140, 300, 1200, 100); type(t.el,'h1');\n  root.appendChild(t.el);\n  return { render(){} };\n}`));
  const second = compute(dir);
  const cmp = compare(dir, second);
  const screenChange = cmp.changes.find(c => c.dim === 'screen');
  assert.ok(screenChange, '没有检测到 screen 变化：' + JSON.stringify(cmp.changes));
  assert.equal(screenChange.dir, 'worse', '方向应为 worse，实际 ' + screenChange.dir);
  assert.ok(screenChange.to > screenChange.from, `疑点应增多：${screenChange.from} → ${screenChange.to}`);
});

/* ---------- 4) 报告里必须有"不代表讲得清楚"的声明 ---------- */
test('score：报告声明机器分数不等于讲清楚', () => {
  const dir = mk({ '脚本.md': GOOD_SCRIPT, '方案.md': '', 'scenes.src.js': sixScenes(GOOD_SCENES), 'scene.html': sixSceneHtml() });
  const r = compute(dir);
  const text = report(r, null);
  assert.match(text, /不代表讲得清楚|仍需人看/);
});
