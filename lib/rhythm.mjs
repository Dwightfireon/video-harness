/* lib/rhythm.mjs —— 垂直节奏与间距一致性（vh rhythm）
 *
 * 为什么需要：实测 e2e 8 场的标题 y 起点有 7 种（0.03/0.04/0.05/0.14/0.20/0.26/0.30）。
 * 观众不会说"这个标题低了 40px"，但会觉得"每屏都在晃"。
 * 一致性是高级感的地基，而这一层之前完全没有工具。
 *
 * 仅提供标题起点和间距的静态线索，不认识画面用途，也不等同全片韵律。
 * 统一可建立秩序，有意变化也可以建立层级；需要看实际画面判断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripVisualIntent } from './scene-visual.mjs';

/* 允许的间距阶梯（4px 基准，取常用档） */
const SPACING_OK = new Set([0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 30, 32, 36, 40, 44, 48, 56, 64, 72, 80, 96, 120]);

export function scan(project) {
  const src = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
  if (!src) return { ok: true, scenes: [], findings: [], note: '没有 scenes.src.js' };
  const chunks = src.split(/^\/\/---\s*$/m).map(c => stripVisualIntent(c.trim())).filter(Boolean);
  const findings = [];
  const scenes = [];

  chunks.forEach((chunk, i) => {
    const n = i + 1;
    /* ① 标题起点：找**第一个文字元素**的 y。
       注意：很多场是 `const t = line(...); abs(t.el, pad, Y, ...)` ——
       第一个 abs 的 y 是变量 t 的，不是标题的真实位置。
       所以先把 `const X = line(...)` 的变量名收集起来，再看 abs(X.el, ...) 的 y。 */
    const textVars = [...chunk.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*line\(/g)].map(m => m[1]);
    let firstY = null;
    for (const tv of textVars) {
      const m = chunk.match(new RegExp('abs\\(\\s*' + tv + '\\.el\\s*,\\s*([^,]+),\\s*([^,]+),'));
      if (m) { firstY = m[2].trim(); break; }
    }
    if (!firstY) {
      // 退路：直接 abs(mk(...)) 的第一个
      const absCalls = [...chunk.matchAll(/\babs\(\s*mk\([^)]*\)\s*,\s*([^,]+),\s*([^,]+),/g)];
      firstY = absCalls.length ? absCalls[0][2].trim() : null;
    }
    /* 把所有 y 表达式归一化成"相对安全区的比例"，便于跨场比较 */
    const norm = (expr) => {
      if (!expr) return null;
      const m = expr.match(/S\.top\s*\+\s*S\.h\s*\*\s*([\d.]+)/);
      if (m) return { kind: 'ratio', v: +m[1] };
      const m2 = expr.match(/S\.bottom\s*-\s*S\.h\s*\*\s*([\d.]+)/);
      if (m2) return { kind: 'fromBottom', v: +m2[1] };
      const m3 = expr.match(/S\.top\s*\+\s*([\d.]+)/);
      if (m3) return { kind: 'abs', v: +m3[1] };
      return { kind: 'other', v: expr.slice(0, 20) };
    };
    const yNorm = norm(firstY);

    /* ② 间距：padding / margin / gap 的 px 值 */
    const spacing = [];
    for (const m of chunk.matchAll(/\b(?:padding|margin|gap)\s*:\s*([^;}"']+)/g)) {
      for (const px of m[1].matchAll(/([\d.]+)px/g)) spacing.push(+px[1]);
    }
    const badSpacing = [...new Set(spacing)].filter(v => !SPACING_OK.has(v));

    scenes.push({ n, firstY, yNorm, spacing: [...new Set(spacing)], badSpacing });

    if (badSpacing.length) {
      findings.push({
        kind: 'spacing', scene: n,
        msg: `第 ${n} 场间距不在阶梯内：${badSpacing.map(v => v + 'px').join(' / ')}（常用 8/12/16/24/32/48）`,
        fix: '对照相邻同类元素检查关系；属于内容所需的差异可以保留，不必机械取整。',
      });
    }
  });

  /* ③ 跨场：标题起点有几种
     但**大字断言/章节页要排除**：它们的标题本来就该在画面偏上居中，
     和"内容场的标题"不是同一套对齐（真实误报：S1/S8 的 20% 被判成不统一）。 */
  const statementLike = (chunk, idx) => {
    const layoutTag = (chunk.match(/@layout\s+([^\s*·\n]+)/) || [])[1] || '';
    return /大字|断言|章节|标题页|钩子|hero/i.test(layoutTag);
  };
  const contentScenes = scenes.filter((s, idx) => {
    const y = s.yNorm;
    /* 大字场的标志：标题起点 ≥ 15%（明显偏上/居中），或 @layout 标了大字 */
    const looksStatement = y && y.kind === 'ratio' && y.v >= 0.15;
    return !looksStatement;
  });
  const ratios = contentScenes.map(s => s.yNorm).filter(x => x && x.kind === 'ratio');
  const uniqRatio = [...new Set(ratios.map(r => r.v))];
  if (uniqRatio.length >= 3) {
    findings.push({
      kind: 'inconsistent-top',
      msg: `内容场识别到 ${uniqRatio.length} 种标题起点：${uniqRatio.map(v => (v * 100).toFixed(0) + '%').join(' / ')}（启发式，大字场按位置排除）`,
      fix: '对照静帧检查同类信息是否无意跳动；章节、焦点或构图有意变化时可以保留。',
    });
  }

  return { ok: findings.length === 0, scenes, findings, uniqRatio, scenesCount: chunks.length };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['垂直节奏与间距一致性', ''];
  lines.push('  场次  标题起点        间距（px）');
  for (const s of res.scenes) {
    const y = s.yNorm ? (s.yNorm.kind === 'ratio' ? (s.yNorm.v * 100).toFixed(0) + '%'
      : s.yNorm.kind === 'fromBottom' ? '底-' + (s.yNorm.v * 100).toFixed(0) + '%'
      : String(s.yNorm.v).slice(0, 14)) : '—';
    const sp = s.spacing.length ? s.spacing.join('/') + (s.badSpacing.length ? ` ✗(${s.badSpacing.join('/')})` : '') : '—';
    lines.push(`  S${String(s.n).padStart(2)}  ${y.padEnd(14)}  ${sp}`);
  }
  lines.push('');
  if (!res.findings.length) {
    lines.push('未发现已识别的起点/间距疑点，不代表全片节奏或构图通过。');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('口径：仅从源码猜测第一个文字元素的 y 与 padding/margin/gap；未验证真实布局，不判断审美。');
  return lines.join('\n');
}
