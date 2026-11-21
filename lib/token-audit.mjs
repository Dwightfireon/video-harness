/* lib/token-audit.mjs —— 设计 token 纪律（vh tokens）
 *
 * 为什么需要：引擎里有 22 个设计 token（颜色/圆角/阴影），换品牌只改 :root 一处。
 * 但场景能随时写 `background:#147A3A`、`border-radius:12px`——
 * 于是"换主题"实际上换不动，圆角也永远不统一。
 *
 * art-directions.md 自己写着：**圆角不统一 = 不高级，比配色更致命**。
 *
 * 三条判据（都能机械判定）：
 *   1. 颜色：不许写 hex / rgb() / hsl()，必须走 var(--*)
 *      （例外：白/黑纯色、以及 <svg> 里的 currentColor）
 *   2. 圆角：必须用 var(--radius) 或明确的档位（2px 细线/999px 胶囊）
 *   3. 阴影：必须用 var(--shadow-sm|md)，别手写 rgba 长串
 *
 * 不判"颜色好不好看"——那需要人。它只判"有没有走统一的路"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripVisualIntent } from './scene-visual.mjs';

/* 允许的字面量：纯白/纯黑/透明（这三种没有品牌语义，改了也不影响换肤） */
const OK_LITERAL = /^(#fff(fff)?|#000(000)?|white|black|transparent|currentColor)$/i;

/* 引擎 :root 里有定义的 token 名（从 engine.tpl.html 读，不写死） */
export function tokensOf(project) {
  const tpl = (() => { try { return fs.readFileSync(path.join(project, 'engine.tpl.html'), 'utf8'); } catch { return ''; } })();
  const start = tpl.indexOf(':root{');
  const end = tpl.indexOf('}', start);
  const block = start >= 0 ? tpl.slice(start, end) : '';
  const names = [...block.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]);
  const values = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) values[m[1]] = m[2].trim();
  return { names, values };
}

const COLOR_PROP = /(?:^|[;{\s])(background(?:-color)?|color|border(?:-[a-z]+)?-color|fill|stroke|box-shadow)\s*:\s*([^;}"']+)/g;

export function scan(project, opt = {}) {
  const src = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
  if (!src) return { ok: true, scenes: [], findings: [], note: '没有 scenes.src.js' };
  const tk = tokensOf(project);
  const known = new Set(tk.names);

  const chunks = src.split(/^\/\/---\s*$/m).map(c => stripVisualIntent(c.trim())).filter(Boolean);
  const findings = [];
  const scenes = [];

  chunks.forEach((chunk, i) => {
    const n = i + 1;
    const colors = [];
    const radii = [];
    const shadows = [];

    /* ① 颜色字面量（hex / rgb / hsl），排除 svg 内联与 currentColor */
    for (const m of chunk.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
      const v = m[0];
      if (OK_LITERAL.test(v)) continue;
      colors.push(v);
    }
    for (const m of chunk.matchAll(/\brgba?\([^)]*\)/g)) {
      const v = m[0];
      // rgba(0,0,0,.x) 这类纯黑半透明遮罩允许（遮罩不是品牌色）
      if (/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/.test(v)) continue;
      if (/^rgba?\(\s*255\s*,\s*255\s*,\s*255\s*[,)]/.test(v)) continue;
      colors.push(v);
    }

    /* ② 圆角字面量 */
    for (const m of chunk.matchAll(/border-radius:\s*([^;}"']+)/g)) {
      const v = m[1].trim();
      if (/var\(--/.test(v)) continue;
      // 允许：细线 1–4px、胶囊 999px / 50%
      const nums = [...v.matchAll(/([\d.]+)px/g)].map(x => +x[1]);
      if (nums.length && nums.every(x => x <= 4)) continue;
      if (/999|50%/.test(v)) continue;
      radii.push(v);
    }

    /* ③ 阴影字面量 */
    for (const m of chunk.matchAll(/box-shadow:\s*([^;}"']+)/g)) {
      const v = m[1].trim();
      if (/var\(--/.test(v)) continue;
      if (/^none$/i.test(v)) continue;
      shadows.push(v.slice(0, 48));
    }

    scenes.push({ n, colors, radii, shadows });

    if (colors.length) {
      findings.push({
        kind: 'color', scene: n,
        msg: `第 ${n} 场有 ${colors.length} 处颜色写死：${[...new Set(colors)].slice(0, 4).join(' / ')}`,
        fix: '改用 var(--accent) / var(--ink) 等 token；换主题时才换得动。',
      });
    }
    if (radii.length) {
      findings.push({
        kind: 'radius', scene: n,
        msg: `第 ${n} 场有 ${radii.length} 处圆角写死：${[...new Set(radii)].slice(0, 4).join(' / ')}`,
        fix: '统一用 var(--radius)（卡）或 2px（细线）/999px（胶囊）。圆角不统一比配色不协调更致命。',
      });
    }
    if (shadows.length) {
      findings.push({
        kind: 'shadow', scene: n,
        msg: `第 ${n} 场有 ${shadows.length} 处阴影写死：${shadows[0]}…`,
        fix: '用 var(--shadow-sm) 或 var(--shadow-md)；别每个元素都加阴影。',
      });
    }
  });

  /* 跨场一致性：全片用了几个圆角值（这是"高级感"的直接指标） */
  const allRadii = [...new Set(scenes.flatMap(s => s.radii))];
  const allColors = [...new Set(scenes.flatMap(s => s.colors))];
  if (allRadii.length >= 3) {
    findings.push({
      kind: 'radius-inconsistent',
      msg: `全片出现 ${allRadii.length} 种圆角：${allRadii.join(' / ')} —— 这是"不高级"最直接的来源`,
      fix: '选 1–2 个值（卡 20–26px、小块 8–12px），全片统一。',
    });
  }

  return { ok: findings.length === 0, scenes, findings, tokens: tk.names.length, allRadii, allColors };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['设计 token 纪律（颜色 / 圆角 / 阴影是否走统一的路）', ''];
  lines.push(`引擎里可用 token ${res.tokens} 个`);
  lines.push('');
  if (!res.findings.length) {
    lines.push('✓ 场景全部走 token —— 换主题时能整体换掉');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
    lines.push('');
    lines.push(`✗ ${res.findings.length} 处（改完就能"换主题"了，这是可逆的工程问题）`);
  }
  return lines.join('\n');
}
