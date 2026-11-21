/* lib/scene-builder.mjs —— 从脚本.md 直接生成 scenes.src.js
 *
 * 为什么需要这个：
 * 原来"写画面"这一步全押给 agent 手写 scenes.src.js。那是一份几千行、
 * 坐标动画全靠现算的代码 —— agent 要先摸清引擎接口（grep 模板源码），
 * 再逐场填内容。真实事故：62 步里 35 次 grep 同一份 engine.tpl.html，
 * 4 小时零产出；而同样的任务换个"有真实数据可拍"的主题就一次写成了。
 *
 * 这里把这一步变成**确定性生成**：
 *   脚本.md → 选版式（规则匹配）→ 填内容 → 算坐标 → 输出完整可跑的块
 * agent 只负责判断内容对不对，不负责手写画面。
 *
 * 输出的硬约束（照抄跑通过的项目）：
 *   - 每块自包含：块之间不共享变量（生成器把每块直接塞进 addScene(...)，
 *     顶部写共享 helper 会被粘进第一场的函数体 → 语法错误、整片空白）。
 *   - 坐标用 window.W / window.H 算，横竖屏都能跑。
 *   - 每场一个具体对象：数字 / 文件名 / 对比项 / 步骤 / 清单。
 *   - 相邻场可复用版式；是否变化由内容决定，不能为了多样性伪造数字。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pick } from './recipe-pick.mjs';

/* ---------- 读脚本 ---------- */
export function readScenes(project) {
  let md = '';
  try { md = fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch {}
  const out = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
    if (h) { cur = { n: +h[1], title: (h[2] || '').trim(), lines: [], deps: '' }; out.push(cur); continue; }
    if (/^##\s/.test(raw)) { cur = null; continue; }
    if (!cur) continue;
    const dep = raw.match(/^←\s*依赖[：:]\s*(.+)$/);
    if (dep) { cur.deps = dep[1].trim(); continue; }
    const lm = raw.match(/^\s*\d+[.、)]\s*(.+)$/);
    if (lm) cur.lines.push(lm[1].trim());
  }
  return out.filter(s => s.lines.length);
}

/* ---------- 提取可拍对象 ---------- */
const NUM = /(\d[\d,.]*)\s*(%|倍|万|亿|千|百|个|人|条|次|秒|分钟|小时|天|年|周|块|元|台|份|米|公里|斤|字|页|款|项|步|格|类|种|张|台|组|对)?/g;

/* 从旁白里找可展示的数字（带单位），用于条形对比/数字板 */
function pickNumbers(lines) {
  const found = [];
  for (const l of lines) {
    for (const m of l.matchAll(NUM)) {
      const v = parseFloat(String(m[1]).replace(/,/g, ''));
      if (!Number.isFinite(v) || v <= 0) continue;
      found.push({ value: v, unit: m[2] || '', raw: m[0].trim(), sentence: l });
    }
  }
  return found;
}

/* 从旁白里找"清单式"内容：顿号/逗号并列的短语，可做步骤条 */
function pickList(lines) {
  for (const l of lines) {
    const m = l.match(/(.{2,14})[、，,]\s*(.{2,14})[、，,]\s*(.{2,16})[。.；;]?$/);
    if (m) return [m[1], m[2], m[3]].map(s => s.trim());
  }
  return null;
}

/* 从旁白里找"可命名的具体对象"：文件名、命令、产品名、引号里的词 */
function pickConcrete(lines) {
  const patterns = [
    /([A-Za-z0-9_.-]+\.(?:md|mjs|js|json|py|txt|mp4|dmg|ts|css|html))/g,   // 文件名
    /`([^`]{2,24})`/g,                                                       // 反引号
    /「([^」]{2,20})」/g,                                                     // 书名号
    /\b([A-Z][A-Za-z0-9]{2,})\b/g,                                            // 专名
  ];
  for (const l of lines) {
    for (const p of patterns) {
      const m = p.exec(l);
      if (m) return m[1];
    }
  }
  return null;
}

/* ---------- 各版式的生成器 ----------
 * 每个都返回一段完整可跑的 scenes.src.js 块。
 * 内容来自本场的旁白与标题；坐标用 S/W/H 算。 */

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function heroStatement(sc, ctx) {
  const t = clip(sc.title, 22);
  const claim = clip(ctx.claim || sc.lines[0], 30);
  const sub = clip(ctx.support || sc.lines[1] || sc.lines[0], 42);
  return `// @layout 大字断言
root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;

  const l1 = abs(mk('div', '', '${esc(t)}'), pad, Math.round(S.top + S.h * 0.20), S.W - pad * 2, Math.round(S.h * 0.16));
  type(l1, 'h1'); l1.style.color = 'var(--ink2)';
  root.appendChild(l1);

  const l2 = abs(mk('div', '', '${esc(claim)}'), pad, Math.round(S.top + S.h * 0.38), S.W - pad * 2, Math.round(S.h * 0.24));
  type(l2, 'hero');
  root.appendChild(l2);

  const sub2 = abs(mk('div', '', '${esc(sub)}'), pad, Math.round(S.top + S.h * 0.64), Math.round(S.W * 0.72), Math.round(S.h * 0.12));
  type(sub2, 'body'); sub2.style.color = 'var(--ink2)';
  root.appendChild(sub2);

  const rule = abs(mk('div', 'rule-accent'), pad, Math.round(S.top + S.h * 0.60), 0, 3);
  root.appendChild(rule);

  return { render(t) {
    enter(l1, t, .10, { dy: 12, blur: 3, dur: .5 });
    enter(l2, t, .38, { dy: 26, blur: 9, dur: .85 });
    enter(sub2, t, .90, { dy: 14, blur: 4, dur: .6 });
    rule.style.width = (eOut3(P(t, .70, .7)) * Math.round(S.W * 0.09)) + 'px';
  }};
}`;
}

function compareBars(sc, ctx) {
  const rows = ctx.bars;
  const body = rows.map((r, i) => `    { k: '${esc(clip(r.k, 16))}', v: ${r.v.toFixed(3)}, label: '${esc(r.label)}' },`).join('\n');
  return `// @layout 条形对比
root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;

  const title = abs(mk('div', '', '${esc(clip(sc.title, 24))}'), pad, Math.round(S.top + S.h * 0.08), S.W - pad * 2, Math.round(S.h * 0.10));
  type(title, 'h1');
  root.appendChild(title);

  const rows = [
${body}
  ];
  const labelW = Math.min(Math.round(S.W * 0.26), 320);
  const barX = pad + labelW + 16;
  const barW = Math.max(120, Math.min(Math.round(S.W * 0.34), S.W - barX - pad - 200));
  const els = rows.map((r, i) => {
    const y = Math.round(S.top + S.h * (0.30 + i * 0.19));
    const k = abs(mk('div', '', r.k), pad, y, labelW, 44); type(k, 'h2'); root.appendChild(k);
    const track = abs(mk('div', ''), barX, y + 12, barW, 22);
    track.style.cssText += 'background:var(--line);border-radius:11px'; root.appendChild(track);
    const bar = abs(mk('div', ''), barX, y + 12, 0, 22);
    bar.style.cssText += 'background:' + (i ? 'var(--ink3)' : 'var(--accent)') + ';border-radius:11px;opacity:' + (i ? .55 : 1);
    root.appendChild(bar);
    const val = abs(mk('div', '', r.label), barX + barW + 18, y, Math.max(110, S.W - (barX + barW) - pad - 18), 44);
    type(val, 'h2'); val.style.fontFamily = 'var(--font-mono)';
    val.style.color = i ? 'var(--ink2)' : 'var(--accent)';
    root.appendChild(val);
    return { bar, r, at: .7 + i * .45 };
  });
  const cap = abs(mk('div', '', '${esc(clip(ctx.source || '来源：见 claims.json', 40))}'), pad, Math.round(S.bottom - 52), S.W - pad * 2, 36);
  type(cap, 'note'); cap.style.color = 'var(--ink3)';
  root.appendChild(cap);

  return { render(t) {
    title.set(P(t, .15, .6));
    els.forEach(o => { o.bar.style.width = (eOut3(P(t, o.at, .9)) * barW * o.r.v) + 'px'; });
    enter(cap, t, 1.6, { dy: 10, blur: 3, dur: .5 });
  }};
}`;
}

function processSteps(sc, ctx) {
  const steps = ctx.steps;
  const body = steps.map((s, i) => `    { t: '${esc(clip(s, 18))}', d: '${esc(clip(ctx.stepDesc?.[i] || '', 26))}' },`).join('\n');
  return `// @layout 三步流程
root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;

  const title = abs(mk('div', '', '${esc(clip(sc.title, 24))}'), pad, Math.round(S.top + S.h * 0.08), S.W - pad * 2, Math.round(S.h * 0.10));
  type(title, 'h1');
  root.appendChild(title);

  const steps = [
${body}
  ];
  const n = steps.length;
  const rowH = Math.round(Math.min(150, S.h * 0.20));
  const top = Math.round(S.top + S.h * 0.28);
  const els = steps.map((s, i) => {
    const y = top + i * rowH;
    const num = abs(mk('div', 'label', '0' + (i + 1)), pad, y + 4, 60, 40);
    type(num, 'label'); num.style.color = 'var(--accent)';
    root.appendChild(num);
    const t = abs(mk('div', '', s.t), pad + 84, y, Math.round(S.W * 0.34), 46);
    type(t, 'h2'); root.appendChild(t);
    if (s.d) {
      const d = abs(mk('div', '', s.d), pad + 84, y + 50, Math.round(S.W * 0.46), 40);
      type(d, 'note'); d.style.color = 'var(--ink2)';
      root.appendChild(d);
    }
    const line = abs(mk('div', ''), pad + 84, y + rowH - 22, S.W - pad * 2 - 84, 1);
    line.style.cssText += 'background:var(--line)';
    root.appendChild(line);
    return { t, num, d, at: .25 + i * .38 };
  });
  return { render(t) {
    title.set(P(t, .1, .55));
    els.forEach(o => {
      enter(o.t, t, o.at, { dy: 16, blur: 5, dur: .55 });
      enter(o.num, t, o.at - .08, { dy: 8, blur: 2, dur: .4 });
    });
  }};
}`;
}

function numberBoard(sc, ctx) {
  const big = ctx.big;
  return `// @layout 数字板
root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;

  const tag = abs(mk('div', 'label', '${esc(clip(ctx.tag || '一个具体的数', 20))}'), pad, Math.round(S.top + S.h * 0.10), Math.round(S.W * 0.5), 34);
  root.appendChild(tag);

  const hero = abs(mk('div', 'hero', ''), pad, Math.round(S.top + S.h * 0.26), Math.round(S.W * 0.62), Math.round(S.h * 0.30));
  type(hero, 'hero');
  const num = mk('span', '', '${esc(big.value)}');
  const unit = mk('span', 'unit', '${esc(big.unit)}');
  hero.appendChild(num); hero.appendChild(unit);
  root.appendChild(hero);

  const cap = abs(mk('div', '', '${esc(clip(big.caption || sc.lines[0], 44))}'), pad, Math.round(S.top + S.h * 0.60), Math.round(S.W * 0.66), Math.round(S.h * 0.14));
  type(cap, 'body'); cap.style.color = 'var(--ink2)';
  root.appendChild(cap);

  const src = abs(mk('div', '', '${esc(clip(ctx.source || '来源：见 claims.json', 40))}'), pad, Math.round(S.bottom - 52), S.W - pad * 2, 36);
  type(src, 'note'); src.style.color = 'var(--ink3)';
  root.appendChild(src);

  return { render(t) {
    enter(tag, t, .06, { dy: 8, blur: 2, dur: .45 });
    enter(hero, t, .28, { dy: 30, blur: 10, dur: .9 });
    enter(cap, t, .80, { dy: 14, blur: 4, dur: .6 });
    enter(src, t, 1.3, { dy: 10, blur: 3, dur: .5 });
  }};
}`;
}

function fileTree(sc, ctx) {
  const files = ctx.files;
  const body = files.map(f => `    '${esc(f)}',`).join('\n');
  return `// @layout 文件树
root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;

  const title = abs(mk('div', '', '${esc(clip(sc.title, 24))}'), pad, Math.round(S.top + S.h * 0.08), S.W - pad * 2, Math.round(S.h * 0.10));
  type(title, 'h1');
  root.appendChild(title);

  const files = [
${body}
  ];
  const box = abs(mk('div', ''), pad, Math.round(S.top + S.h * 0.24), Math.round(S.W * 0.52), Math.round(S.h * 0.56));
  box.style.cssText += 'background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:22px 26px';
  root.appendChild(box);
  const rows = files.map((f, i) => {
    const y = 26 + i * 42;
    const d = abs(mk('div', '', f), 26, y, Math.round(S.W * 0.44), 34);
    d.style.cssText += "font-family:var(--font-mono);font-size:22px;color:" + (i === 0 ? 'var(--accent)' : 'var(--ink2)');
    box.appendChild(d);
    return { d, at: .3 + i * .22 };
  });
  const cap = abs(mk('div', '', '${esc(clip(ctx.support || sc.lines[1] || sc.lines[0], 40))}'), pad, Math.round(S.bottom - 70), Math.round(S.W * 0.62), Math.round(S.h * 0.10));
  type(cap, 'body'); cap.style.color = 'var(--ink2)';
  root.appendChild(cap);

  return { render(t) {
    title.set(P(t, .1, .55));
    rows.forEach(o => enter(o.d, t, o.at, { dy: 10, blur: 3, dur: .45 }));
    enter(cap, t, 1.4, { dy: 12, blur: 4, dur: .55 });
  }};
}`;
}

/* ---------- 为每一场准备内容与版式 ---------- */
function buildContext(sc, pickRes) {
  const lines = sc.lines;
  const ctx = {};
  const nums = pickNumbers(lines);
  const list = pickList(lines);
  const concrete = pickConcrete(lines);
  ctx.source = sc.source || '来源：见 claims.json';

  // 条形对比：需要两个以上可比的量
  const groups = new Map();
  for (const n of nums) {
    const key = n.unit || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const comparable = [...groups.values()].find(g => g.length >= 2);
  if (comparable) {
    const max = Math.max(...comparable.map(n => n.value));
    ctx.bars = comparable.slice(0, 3).map(n => ({
      k: clip(n.sentence.replace(/[，。；].*$/, ''), 14) || n.unit,
      v: n.value / max,
      label: n.raw,
    }));
  }

  // 步骤条：旁白里有并列的短语
  if (list) ctx.steps = list;

  // 数字板：最大的那个数
  if (nums.length) {
    const big = nums.slice().sort((a, b) => b.value - a.value)[0];
    ctx.big = { value: big.raw.replace(/\s/g, ''), unit: big.unit, caption: clip(big.sentence, 40) };
  }

  // 文件树：旁白里提到的文件名
  if (concrete && /\.[a-z]{2,4}$/i.test(concrete)) ctx.files = [concrete];

  ctx.claim = clip(lines.find(l => l.length > 8 && l.length < 34) || lines[0], 30);
  ctx.support = clip(lines.find(l => l !== ctx.claim) || lines[0], 42);
  ctx.tag = '一个具体的数';
  ctx.stepDesc = [];
  return ctx;
}

/* 选版式：优先用 pick 的建议；证据不足时按内容特征兜底。 */
function chooseLayout(sc, ctx, suggested) {
  const lines = sc.lines.join(' ');
  if (ctx.bars && ctx.bars.length >= 2) return 'compare-bars';
  if (ctx.steps) return 'process-steps';
  if (ctx.files && ctx.files.length) return 'file-tree';
  if (ctx.big && /\d/.test(lines)) return 'number-board';
  // pick() 也可能建议窗口等未在本构建器实现的配方；不能把它当可执行生成器。
  if (suggested?.key === 'hero-statement') return suggested.key;
  return 'hero-statement';
}

/* ---------- 主入口 ---------- */
/* 生成完整的 scenes.src.js 文本。返回 { text, report } */
export function buildScenesSrc(project, { force = false } = {}) {
  const scenes = readScenes(project);
  if (!scenes.length) {
    return { text: '', report: { ok: false, reason: '脚本.md 里没有可用的场次（## S1 形式）' } };
  }
  const pickRes = pick(project);
  const blocks = [];
  const report = { ok: true, scenes: [], missing: [] };

  for (const sc of scenes) {
    const ctx = buildContext(sc, pickRes.scenes?.find(s => s.n === sc.n));
    const layout = chooseLayout(sc, ctx, pickRes.scenes?.find(s => s.n === sc.n));
    const gen = { 'hero-statement': heroStatement, 'compare-bars': compareBars, 'process-steps': processSteps,
      'number-board': numberBoard, 'file-tree': fileTree }[layout];
    blocks.push(gen(sc, ctx));
    report.scenes.push({ n: sc.n, title: sc.title, layout, concrete: !!ctx.big || !!ctx.bars || !!ctx.steps || !!ctx.files });
  }

  const header = `// 场景构建器（由 vh scenes 自动生成）。
// 分隔符 //--- 之间是每个 addScene 的第 3 个参数。
// 时间轴由 gen.mjs 从 脚本.md 算出后注入，这里**不写时间**。
// 硬规则：每个 chunk 必须**自包含**——chunk 之间不共享变量/函数。
// 每场一个焦点 + 一个具体对象。
// 重新生成：node vh.mjs scenes --write
`;
  const text = header + '\n' + blocks.join('\n\n//---\n\n') + '\n';
  return { text, report };
}
