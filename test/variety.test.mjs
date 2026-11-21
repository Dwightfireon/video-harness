import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, classify, report } from '../lib/variety.mjs';

/* 版式多样性：为什么值得测
   五支片子里三支是「标题 + 列表」占 60%+，观众说"平"，
   但 layout / screen / pacing 全绿——因为它们逐场看，不看全片分布。
   这里锁定两件事：① 分类准 ② 只在真的雷同时才报。 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-variety-'));

const LIST = `root => {
  bg(root);
  const t = line('标题'); type(t.el, 'h1'); root.append(t.el);
  ['甲', '乙', '丙'].forEach(n => {
    const e = mk('div', '', '第' + n + '条'); type(e, 'body'); root.append(e);
  });
  return { render(){} };
}`;

const WINDOW = `root => {
  bg(root);
  const { el } = VH_UI.windowMock(root, 100, 200, 800, 400, '终端');
  VH_UI.codeLine(el, 60, '$ npm run build');
  return { render(){} };
}`;

const BARS = `root => {
  bg(root);
  const barW = 600;
  const track = mk('div', '');
  const bar = mk('div', '');
  bar.style.width = '0px';
  root.append(track, bar);
  return { render(){} };
}`;

const STEPS = `root => {
  bg(root);
  ['一', '二', '三'].forEach((s, i) => {
    const b = mk('div', '', s); root.append(b);
    if (i < 2) { const a = mk('div', '', '→'); root.append(a); }
  });
  return { render(){} };
}`;

test('variety：窗口/代码被认成 window', () => {
  assert.equal(classify(WINDOW).main, 'window');
});

test('variety：轨道+填充被认成 bars', () => {
  assert.equal(classify(BARS).main, 'bars');
});

test('variety：三步+箭头被认成 steps', () => {
  assert.equal(classify(STEPS).main, 'steps');
});

test('variety：多条文本条目被认成 list（不是 statement）', () => {
  assert.equal(classify(LIST).main, 'list');
});

test('variety：一镜到底优先于窗口（one-take 里通常也有窗口）', () => {
  const mixed = `root => {
    bg(root);
    const st = VH_UI.oneTake(root, [{ at: 0, k: 1 }]);
    const { el } = VH_UI.windowMock(st.world, 10, 10, 800, 400, 'x');
    return { render(){} };
  }`;
  assert.equal(classify(mixed).main, 'one-take');
});

function makeProject(chunks, titles) {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'scenes.src.js'), chunks.join('\n//---\n'), 'utf8');
  fs.writeFileSync(path.join(d, '脚本.md'),
    chunks.map((_, i) => `## S${i + 1} · ${titles[i] || '标题' + i}\n1. 一句。\n`).join('\n'), 'utf8');
  return d;
}

test('variety：全片一种版式 → 报 monotone', () => {
  const d = makeProject([LIST, LIST, LIST, LIST], []);
  const res = analyze(d);
  assert.ok(res.findings.some(f => f.kind === 'monotone'), JSON.stringify(res.findings));
});

test('variety：连续同版式合并成一段，不刷屏', () => {
  const d = makeProject([LIST, LIST, LIST, WINDOW, BARS], []);
  const res = analyze(d);
  const adj = res.findings.filter(f => f.kind === 'adjacent');
  assert.equal(adj.length, 1, '5 条一样的提示等于没提示，应合并成 1 段');
  assert.match(adj[0].msg, /第 1–3 场/);
});

test('variety：版式有变化时不报相邻、不报 dominant', () => {
  const d = makeProject([LIST, WINDOW, BARS, STEPS, LIST], []);
  const res = analyze(d);
  const bad = res.findings.filter(f => f.kind === 'adjacent' || f.kind === 'dominant');
  assert.deepEqual(bad, [], JSON.stringify(res.findings));
});

test('variety：场次少时不用 dominant 过度警告', () => {
  const d = makeProject([LIST, WINDOW, LIST], []);
  const res = analyze(d);
  assert.ok(!res.findings.some(f => f.kind === 'dominant'), '3 场不该按 60% 判 dominant');
});

test('variety：report 给出分布与"不是审美判定"的口径', () => {
  const d = makeProject([LIST, WINDOW], []);
  const t = report(analyze(d));
  assert.match(t, /分布/);
  assert.match(t, /不是审美判定/);
});
