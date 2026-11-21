/* lib/type-audit.mjs —— 字号纪律（vh type）
 *
 * 为什么单独做：引擎里写好了 7 档字号阶梯（176/112/54/40/26/24/24）和"一屏最多 3 档"的规矩，
 * 但场景里全是硬编码 font-size:20px/21px/23px/25px/30px。
 * 实测 e2e 8 场：6 场违规，其中两场同屏出现 5 档字号。
 *
 * 这是"看着不高级"的第一原因——不是配色，是字号在打架。
 * 专业排版是"少而大跨度"（176 → 54 → 26 三档就够），我们每场塞 4–5 档。
 *
 * 判据（全部可量化，不给审美意见）：
 *   1. 场内的 font-size 必须落在阶梯内（20/21/23/25/30 都不在）
 *   2. 同一场可见的档数 ≤ 3（hero 一屏一个）
 *   3. 优先用 type(el, 'h1') / var(--fs-*)，别写 px
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripVisualIntent } from './scene-visual.mjs';

/* 引擎阶梯（横屏）。竖屏/方屏按 PRESET 缩放，这里按"档位名"判，不按绝对值 */
export const LADDER = ['hero', 'display', 'h1', 'h2', 'body', 'note', 'label'];

/* 从 scene.html 读当前方向的各档字号 */
export function ladderOf(project) {
  const html = (() => { try { return fs.readFileSync(path.join(project, 'scene.html'), 'utf8'); } catch { return ''; } })();
  const orient = (html.match(/const ORIENT = '(landscape|portrait|square)'/) || [])[1] || 'landscape';
  const block = html.slice(html.indexOf('const PRESET = {'));
  const seg = block.slice(block.indexOf('\n  ' + orient + ':'));
  const fsBlock = (seg.match(/fs:\s*\{([^}]+)\}/) || [])[1] || '';
  const out = {};
  for (const m of fsBlock.matchAll(/(\w+):\s*(\d+)/g)) out[m[1]] = +m[2];
  return { orient, sizes: out, list: Object.values(out).sort((a, b) => b - a) };
}

/* 读场景里所有 font-size（inline + 通过 type() 的类） */
export function scan(project, opt = {}) {
  const src = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
  if (!src) return { ok: true, scenes: [], findings: [], note: '没有 scenes.src.js' };
  const ladder = ladderOf(project);
  const allowed = new Set(ladder.list);

  const chunks = src.split(/^\/\/---\s*$/m).map(c => stripVisualIntent(c.trim())).filter(Boolean);
  const scenes = [];
  const findings = [];

  chunks.forEach((chunk, i) => {
    const n = i + 1;
    /* ① 硬编码 font-size */
    const hard = [...chunk.matchAll(/font-size:\s*([\d.]+)px/g)].map(m => +m[1]);
    /* ② type(el, 'h1') 这类——按档位名，天然合法 */
    const byClass = [...chunk.matchAll(/\btype\(\s*[^,]+,\s*'(\w+)'/g)].map(m => m[1]);
    /* ③ label(el, 26, 400, ...) —— 这其实是硬编码的变体，也要算 */
    const byLabel = [...chunk.matchAll(/\blabel\(\s*[^,]+,\s*(\d+)\s*,/g)].map(m => +m[1]);

    const all = [...hard, ...byLabel];
    const taken = new Set([...byClass, ...[...new Set(all)].map(px => {
      const hit = ladder.list.find(v => Math.abs(v - px) <= 1);
      return hit ? Object.keys(ladder.sizes).find(k => ladder.sizes[k] === hit) : null;
    }).filter(Boolean)]);

    const offLadder = [...new Set(all)].filter(px => !ladder.list.some(v => Math.abs(v - px) <= 1));
    const tiers = new Set();
    byClass.forEach(k => tiers.add(k));
    all.forEach(px => {
      const hit = Object.keys(ladder.sizes).find(k => Math.abs(ladder.sizes[k] - px) <= 1);
      tiers.add(hit || ('px' + px));
    });

    scenes.push({
      n, hard, byLabel, byClass,
      tiers: [...tiers],
      tierCount: tiers.size,
      offLadder,
    });

    if (offLadder.length) {
      findings.push({
        kind: 'off-ladder', scene: n,
        msg: `第 ${n} 场有 ${offLadder.length} 处字号不在阶梯内：${offLadder.map(v => v + 'px').join(' / ')}` +
          `（合法档位 ${ladder.list.join(' / ')}）`,
        fix: `改用 type(el, 'h1'|'body'|'note') 或 var(--fs-h1)；要略小就换一档，别写中间值。`,
      });
    }
    if (tiers.size > 3) {
      findings.push({
        kind: 'too-many-tiers', scene: n,
        msg: `第 ${n} 场同屏 ${tiers.size} 档字号：${[...tiers].join(' / ')} —— 超过 3 档，画面会"字打架"`,
        fix: '砍到 3 档：大标题 / 正文 / 说明。中间档全部并到相邻档。',
      });
    }
    const heroes = byClass.filter(k => k === 'hero').length + hard.filter(px => Math.abs(px - (ladder.sizes.hero || 176)) <= 2).length;
    if (heroes > 1) {
      findings.push({
        kind: 'multi-hero', scene: n,
        msg: `第 ${n} 场有 ${heroes} 个 hero 级大字 —— 一屏只能有一个主角`,
        fix: '只留一个 hero，其余降到 h1 或 h2。',
      });
    }
  });

  return { ok: findings.length === 0, scenes, findings, ladder };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['字号纪律（阶梯 + 一屏最多 3 档）', ''];
  lines.push(`当前方向 ${res.ladder.orient}　合法档位：${res.ladder.list.join(' / ')}`);
  lines.push('');
  lines.push('  场次  档数  用到的档位');
  for (const s of res.scenes) {
    const flag = s.tierCount > 3 ? ' ✗' : '';
    lines.push(`  S${String(s.n).padStart(2)}  ${String(s.tierCount).padStart(3)}${flag}  ${s.tiers.join(' / ') || '（全部用 type() 类，无法静态判断）'}`);
  }
  lines.push('');
  if (!res.findings.length) {
    lines.push('✓ 所有场都在阶梯内，且同屏不超过 3 档');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
    lines.push('');
    lines.push(`✗ ${res.findings.length} 处（这是可以照着改的，不需要争论审美）`);
  }
  return lines.join('\n');
}
