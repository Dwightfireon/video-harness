/* 按“实测到的（文本 → 实际底色）”修正文字颜色。
 * 实测来自真实浏览器渲染 + 像素采样，因此不依赖代码里颜色与底色是否相邻。
 *
 * 用法：node scripts/fix-contrast-by-measure.mjs <项目目录> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { measureContrast } from '../lib/contrast-rendered.mjs';

const LIGHT = { 1: '#eef1f6', 2: '#c3cbd8', 3: '#aab4c2' };
const DARK = { 1: '#1e2721', 2: '#3c453f', 3: '#59635b' };
const lum = h => {
  const n = h.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
};
const pick = (bg, level) => lum(bg) < .22 ? LIGHT[level] : DARK[level];

/* 从实测结果里提取“这段文本该用什么颜色”：同一文本可能出现在不同底色上，取最暗的底。 */
export function plan(finding) {
  return pick(finding.background, 1);
}

async function main() {
  const project = process.argv[2];
  const dry = process.argv.includes('--dry');
  const source = path.join(project, 'scenes.src.js');
  let text = fs.readFileSync(source, 'utf8');
  const result = await measureContrast(project);
  console.log(`实测：${result.findings.length} 处对比度不足`);
  if (!result.findings.length) return;

  // 按文本长度排序，先替换长的，避免短串命中长串
  const targets = [...result.findings].sort((a, b) => b.text.length - a.text.length);
  let changed = 0, skipped = [];
  for (const f of targets) {
    const wanted = plan(f);
    if (wanted.toLowerCase() === f.color.toLowerCase()) { skipped.push(f.text.slice(0, 14) + '（无色差可改）'); continue; }
    const needle = f.text;
    if (!needle || needle.length < 2) { skipped.push('文本过短'); continue; }
    // 找到含该文本的行（单引号/双引号里的字符串）
    const lines = text.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(needle)) continue;
      if (/color\s*:|\.style\.cssText|mk\(/.test(lines[i])) hits.push(i);
    }
    if (hits.length !== 1) { skipped.push(`${needle.slice(0, 14)}（命中 ${hits.length} 行）`); continue; }
    const i = hits[0], line = lines[i];
    // 替换这一行里最接近实测色的那个颜色字面量；没有的话把颜色加到 cssText
    const colorRe = new RegExp(f.color.replace('#', '#'), 'ig');
    let next;
    if (colorRe.test(line)) next = line.replace(colorRe, wanted);
    else if (/color\s*:/.test(line)) next = line.replace(/color\s*:\s*['"]?[^;'"]+/, 'color:' + wanted);
    else if (/\.style\.cssText\s*\+=/.test(line)) next = line.replace(/(\.style\.cssText\s*\+=\s*)(['"])/, (m, a, q) => `${a}${q}color:${wanted};`);
    else continue;
    if (next === line) { skipped.push(needle.slice(0, 14) + '（无匹配色值）'); continue; }
    lines[i] = next;
    text = lines.join('\n');
    changed++;
  }
  console.log(`已改 ${changed} 处；跳过 ${skipped.length}`);
  for (const s of skipped.slice(0, 10)) console.log('  · ' + s);
  if (dry) { console.log('（--dry 未写文件）'); return; }
  fs.writeFileSync(source, text);
  const after = await measureContrast(project);
  console.log(`修后实测：${after.findings.length} 处不足`);
  for (const f of after.findings.slice(0, 12)) console.log(`  · ${f.ratio}:1 S${f.scene} 「${f.text.slice(0, 20)}」 ${f.color} on ${f.background}`);
}

if (process.argv[1] && process.argv[1].endsWith('fix-contrast-by-measure.mjs')) await main();
