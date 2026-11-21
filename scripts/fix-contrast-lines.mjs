/* 逐行按“该元素最近声明的底色”修正文字色。
 *
 * 为什么不能用全局替换：同一个 var(--ink3) 在浅纸底上要变深、在深卡上要变浅。
 * 全局替换必然把另一半改坏（真实试过：76 处 → 104 处）。
 *
 * 策略：按场切块 → 逐行扫描 → 记住最近的 background → 遇到 color 声明时按明暗映射。
 * 只改 color 声明，不动 background / 图形色。
 *
 * 用法：node scripts/fix-contrast-lines.mjs <项目目录> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { contrastRatio, luminance } from '../lib/contrast.mjs';
import { measureContrast } from '../lib/contrast-rendered.mjs';

/* 浅底用深字、深底用浅字；都取能过 4.5:1 的安全值。 */
const DARK_TEXT = { ink: '#1e2721', ink2: '#3c453f', ink3: '#59635b' };
const LIGHT_TEXT = { ink: '#eef1f6', ink2: '#c3cbd8', ink3: '#aab4c2' };

const isDark = hex => luminance(hex) < 0.22;
const BG_VAR = /background\s*:\s*(?:var\(--[\w-]+\s*,\s*)?(#[0-9a-fA-F]{3,8})/;
const BG_ANY = /background\s*:\s*#[0-9a-fA-F]{3,8}/;

function mapFor(bg) {
  if (!bg) return null;
  return isDark(bg) ? LIGHT_TEXT : DARK_TEXT;
}

export function fixLines(source, { engineVars = {} } = {}) {
  const chunks = source.split(/^\/\/---\s*$/m);
  const report = [];
  const out = chunks.map((chunk, ci) => {
    const lines = chunk.split('\n');
    let bg = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const bgm = BG_VAR.exec(line) || BG_ANY.exec(line);
      if (bgm) {
        const raw = bgm[1] || (line.match(/#[0-9a-fA-F]{3,8}/) || [])[0];
        // var(--surface, #14161b) 这类：引擎没定义 surface，回退值才是真实底色
        bg = raw;
      }
      // 只看颜色声明
      const cm = /(color\s*:\s*)(['"]?)(?:var\(--(ink\d?)\s*,\s*)?(#[0-9a-fA-F]{3,8})/.exec(line);
      if (!cm) continue;
      const [, prefix, quote, varName, fallback] = cm;
      const table = mapFor(bg);
      if (!table) continue;
      const key = varName === 'ink' ? 'ink' : varName === 'ink2' ? 'ink2' : varName === 'ink3' ? 'ink3' : null;
      if (!key) continue;
      const target = table[key];
      const current = engineVars[varName] || fallback;
      // 已达标就不动
      if (contrastRatio(current, bg) >= 4.5) continue;
      const next = line.replace(cm[0], `${prefix}${quote}${target}`);
      if (next === line) continue;
      lines[i] = next;
      report.push({ scene: ci + 1, line: i + 1, bg, from: current, to: target, varName });
    }
    return lines.join('\n');
  });
  return { source: out.join('\n//---\n'), report };
}

async function main() {
  const project = process.argv[2];
  const dry = process.argv.includes('--dry');
  if (!project) { console.error('用法：node scripts/fix-contrast-lines.mjs <项目目录> [--dry]'); process.exit(2); }
  const source = path.join(project, 'scenes.src.js');
  const engine = (() => { try { return fs.readFileSync(path.join(project, 'engine.tpl.html'), 'utf8'); } catch { return ''; } })();
  const engineVars = Object.fromEntries([...engine.matchAll(/--(ink\d?)\s*:\s*(#[0-9a-fA-F]{3,8})/g)].map(m => [m[1], m[2]]));
  const before = fs.readFileSync(source, 'utf8');
  const { source: after, report } = fixLines(before, { engineVars });
  console.log(`引擎变量：${JSON.stringify(engineVars)}`);
  console.log(`将修正 ${report.length} 处文字颜色`);
  const byScene = {};
  for (const r of report) (byScene[r.scene] = byScene[r.scene] || []).push(r);
  for (const [s, rs] of Object.entries(byScene)) console.log(`  S${s}: ${rs.length} 处（底色 ${[...new Set(rs.map(r => r.bg))].join(',')}）`);
  if (dry) return;
  fs.writeFileSync(source, after);
  const result = await measureContrast(project);
  console.log(`实测对比度：${result.findings.length} 处不足`);
  for (const f of result.findings.slice(0, 12)) {
    console.log(`  · ${f.ratio}:1 S${f.scene} 「${f.text.slice(0, 20)}」 ${f.color} on ${f.background}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('fix-contrast-lines.mjs')) await main();
