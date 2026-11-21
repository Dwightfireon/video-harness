/* 按实测对比度修正场景文字颜色。
 *
 * 只做一件事：对实测报出的每个文字，保持色相/饱和度不变，调整明度直到
 * 对比度达标；然后在 scenes.src.js 里找到承载这段文字的那一行，替换它的颜色。
 * 找不到唯一对应行时跳过并报告，绝不瞎改。
 *
 * 用法：node scripts/fix-contrast.mjs <项目目录> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { measureContrast } from '../lib/contrast-rendered.mjs';
import { contrastRatio } from '../lib/contrast.mjs';

const hexToRgb = hex => {
  const n = hex.replace('#', '');
  return { r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16) };
};
const rgbToHex = ({ r, g, b }) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

function toHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? ((G - B) / d + (G < B ? 6 : 0)) : max === G ? ((B - R) / d + 2) : ((R - G) / d + 4);
  return { h: h * 60, s, l };
}
function fromHsl({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return { r: (seg[0] + m) * 255, g: (seg[1] + m) * 255, b: (seg[2] + m) * 255 };
}

/* 保持色相，调明度到达标；背景越亮就越往暗走，反之往亮走。 */
export function adjustForContrast(fgHex, bgHex, need) {
  const fg = hexToRgb(fgHex), bg = hexToRgb(bgHex);
  if (contrastRatio(fgHex, bgHex) >= need) return fgHex;
  const { h, s } = toHsl(fg);
  const bgL = toHsl(bg).l;
  // 背景偏亮 → 文字加深；背景偏暗 → 文字提亮
  const dir = bgL > .5 ? -1 : 1;
  for (let step = 1; step <= 100; step++) {
    const l = Math.max(0, Math.min(1, toHsl(fg).l + dir * step * 0.01));
    const cand = rgbToHex(fromHsl({ h, s, l }));
    if (contrastRatio(cand, bgHex) >= need) return cand;
  }
  // 极端情况：直接给纯黑或纯白
  return contrastRatio('#000000', bgHex) >= contrastRatio('#ffffff', bgHex) ? '#000000' : '#ffffff';
}

const alpha = s => s;

function main() {
  const project = process.argv[2];
  const dry = process.argv.includes('--dry');
  if (!project) { console.error('用法：node scripts/fix-contrast.mjs <项目目录> [--dry]'); process.exit(2); }
  return (async () => {
    const source = path.join(project, 'scenes.src.js');
    let text = fs.readFileSync(source, 'utf8');
    const before = await measureContrast(project);
    console.log(`实测：${before.findings.length} 处不足（采样 ${before.sampled} 帧）`);
    if (!before.findings.length) return;

    // 场景切块，只在对应场里找目标，避免跨场误改
    const chunks = text.split(/^\/\/---\s*$/m);
    let changed = 0, skipped = [];

    for (const f of before.findings) {
      const index = (f.scene || 1) - 1;
      let chunk = chunks[index];
      if (!chunk) { skipped.push(f.text + '（找不到场次）'); continue; }
      const target = f.text.trim();
      if (target.length < 2) { skipped.push(f.text + '（文本过短）'); continue; }

      // 找到含该文字的那一行
      const lines = chunk.split('\n');
      const hits = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes(target.slice(0, Math.min(target.length, 12))));
      if (hits.length !== 1) { skipped.push(`${f.text.slice(0, 16)}（命中 ${hits.length} 行，跳过）`); continue; }

      const wanted = adjustForContrast(f.color, f.background, f.need);
      if (wanted.toLowerCase() === f.color.toLowerCase()) { skipped.push(f.text + '（无法自动调整）'); continue; }

      const line = hits[0].l;
      // 只替换颜色声明；优先精确替换当前生效的色值
      let next = line;
      const colorRe = /(color\s*:\s*)'?\s*(?:var\(--[\w-]+\s*,\s*)?(#[0-9a-fA-F]{3,8})/;
      const m = colorRe.exec(line);
      if (!m) { skipped.push(`${f.text.slice(0, 16)}（这一行没有内联颜色）`); continue; }
      next = line.replace(colorRe, (all, prefix) => prefix + wanted);
      if (next === line) { skipped.push(`${f.text.slice(0, 16)}（替换无变化）`); continue; }
      lines[hits[0].i] = next;
      chunks[index] = lines.join('\n');
      changed++;
    }

    fs.writeFileSync(source, chunks.join('\n//---\n'));
    console.log(`已改 ${changed} 处；跳过 ${skipped.length} 处`);
    for (const s of skipped.slice(0, 12)) console.log('  · ' + s);
    if (dry) { console.log('（--dry：仅测量，未写文件）'); return; }

    const after = await measureContrast(project);
    console.log(`修正后实测：${after.findings.length} 处不足`);
    for (const f of after.findings.slice(0, 10)) console.log(`  · ${f.ratio}:1 S${f.scene} 「${f.text.slice(0, 20)}」`);
  })();
}

main();
