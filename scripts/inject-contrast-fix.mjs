/* 把实测对比度结果转成“该元素应用的颜色”，并注入场景末尾。
 *
 * 为什么不在源码里找颜色：文字常来自数据数组（rows.map），颜色在别处按条件拼接，
 * 静态替换要么命中不到，要么把浅底上的字一起改坏（实测：76 → 104）。
 * 这里改为在渲染时按文本内容精确改色，只影响实测判定为不足的那些元素。
 *
 * 用法：node scripts/inject-contrast-fix.mjs <项目目录> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { measureContrast } from '../lib/contrast-rendered.mjs';
import { contrastRatio } from '../lib/contrast.mjs';

const MARK_BEGIN = '/* __contrast_fix_begin__ */';
const MARK_END = '/* __contrast_fix_end__ */';

const lum = h => {
  const n = h.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
};
const rgb = h => { const n = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16)); };
const hex = a => '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/* 保持色相，把明度推到能过目标对比度。
 * 方向由“底色明暗”决定：深底要更亮的字，浅底要更暗的字。
 * ⚠ 不能用 lum(fg) vs lum(bg) 判断 —— 深底上"稍亮但不达标"的前景会被误判成该变暗。 */
function pushToContrast(fg, bg, need) {
  if (contrastRatio(fg, bg) >= need) return fg;
  const [r, g, b] = rgb(fg);
  const bgDark = lum(bg) < 0.22;
  let best = null;
  for (let k = 0; k <= 100; k++) {
    const t = k / 100;
    const cand = bgDark
      ? hex([r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t])
      : hex([r * (1 - t), g * (1 - t), b * (1 - t)]);
    if (contrastRatio(cand, bg) >= need) { best = cand; break; }
  }
  return best || (bgDark ? '#ffffff' : '#000000');
}

export function buildFixMap(findings) {
  const map = new Map();
  for (const f of findings) {
    const text = (f.text || '').trim();
    if (!text || text.length < 1) continue;
    const next = pushToContrast(f.color, f.background, f.need);
    const prev = map.get(text);
    // 同一文本出现在多种底色上：取更深的值，保证两种底都能读
    if (!prev || lum(next) < lum(prev.color)) map.set(text, { color: next, ratio: contrastRatio(next, f.background) });
  }
  return map;
}

async function main() {
  const project = process.argv[2];
  const dry = process.argv.includes('--dry');
  const source = path.join(project, 'scenes.src.js');
  if (!fs.existsSync(source)) { console.error('找不到 scenes.src.js'); process.exit(2); }

  const measured = await measureContrast(project);
  console.log(`实测不足：${measured.findings.length} 处`);
  if (!measured.findings.length) return;

  // 按场分组：每条 finding 有 scene 号
  const byScene = new Map();
  for (const f of measured.findings) {
    const n = f.scene || 1;
    if (!byScene.has(n)) byScene.set(n, []);
    byScene.get(n).push(f);
  }

  let text = fs.readFileSync(source, 'utf8');
  // 先移除旧的注入块（可重复运行）
  text = text.replace(new RegExp('\\n?\\s*' + MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g'), '\n');

  const chunks = text.split(/^\/\/---\s*$/m);
  let injected = 0;
  for (const [sceneNo, list] of byScene) {
    const idx = sceneNo - 1;
    let chunk = chunks[idx];
    if (!chunk) continue;
    const map = buildFixMap(list);
    if (!map.size) continue;
    const table = [...map.entries()].map(([t, v]) => [t, v.color]);
    const js = `\n  ${MARK_BEGIN}\n  const __fix = ${JSON.stringify(Object.fromEntries(table))};\n  const __applyFix = () => root.querySelectorAll('*').forEach(el => {\n    const key = (el.textContent || '').trim();\n    if (__fix[key]) el.style.color = __fix[key];\n  });\n  ${MARK_END}`;
    // 插在 render 函数体开头：每帧渲染后都重新套用，避免动画/后续赋值覆盖
    const at = chunk.indexOf('return {');
    if (at < 0) continue;
    const afterReturn = chunk.indexOf('render(', at);
    const brace = chunk.indexOf('{', afterReturn);
    if (afterReturn < 0 || brace < 0) continue;
    chunk = chunk.slice(0, brace + 1) + js + chunk.slice(brace + 1);
    chunks[idx] = chunk;
    injected += table.length;
  }
  console.log(`注入 ${injected} 条文字色修正（跨 ${byScene.size} 场）`);
  if (dry) return;
  fs.writeFileSync(source, chunks.join('\n//---\n'));

  const after = await measureContrast(project);
  console.log(`修后实测：${after.findings.length} 处不足`);
  for (const f of after.findings.slice(0, 10)) console.log(`  · ${f.ratio}:1 S${f.scene} 「${f.text.slice(0, 20)}」`);
}

if (process.argv[1] && process.argv[1].endsWith('inject-contrast-fix.mjs')) await main();
