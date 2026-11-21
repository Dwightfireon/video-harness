/* lib/score.mjs —— 质量总分与回归对比（vh score）
 *
 * 把五关合成一张表，并能和上一次比：哪一项变好了、哪一项变坏了。
 * 注意：分数只代表"机器能查的形式"，**不代表讲得清楚**（详见 references/lexicon.md 末尾）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyze as clarityA } from './clarity.mjs';
import { analyze as depthA } from './depth.mjs';
import { analyze as screenA } from './screen-check.mjs';
import { analyze as layoutA } from './layout-check.mjs';

const scorePath = (project) => path.join(project, '.snapshots', 'score.json');

export function compute(project) {
  const c = clarityA(project);
  const d = depthA(project);
  const s = screenA(project);
  const l = layoutA(project);
  const dims = {
    clarity: { label: '解释形式（非内容审稿）', ok: c.fail.length === 0, pending: c.pending.length,
      warnings: c.fail.length + c.warn.length + c.pending.length,
      detail: `${c.fail.length} 未通过 / ${c.pending.length} 待核；不代表讲通` },
    depth: { label: '内容深度', ok: d.ok, warnings: d.hard.length, detail: `${d.count} 场 / ${Math.round(d.est)}s` + (d.target ? `（目标 ${Math.round(d.target)}s）` : '') },
    screen: { label: '图文对应', ok: s.ok, warnings: s.findings.length, detail: `${s.findings.length} 处疑点` },
    layout: { label: '版式', ok: l.findings.length === 0, warnings: l.findings.length, detail: `${l.findings.length} 项` + (l.dupCount ? `（抄旁白 ${l.dupCount}）` : '') },
  };
  const okCount = Object.values(dims).filter(x => x.ok).length;
  return { at: new Date().toISOString(), dims, okCount, total: Object.keys(dims).length };
}

export function save(project, score) {
  const p = scorePath(project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let all = [];
  try { all = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  all.push(score);
  fs.writeFileSync(p, JSON.stringify(all.slice(-20), null, 2));   // 只留最近 20 次
  return p;
}

export function compare(project, cur) {
  let all = [];
  try { all = JSON.parse(fs.readFileSync(scorePath(project), 'utf8')); } catch {}
  const prev = all[all.length - 1];
  if (!prev) return { first: true };
  const changes = [];
  for (const k of Object.keys(cur.dims)) {
    const a = prev.dims[k], b = cur.dims[k];
    if (!a) continue;
    if (a.ok !== b.ok) changes.push({ dim: k, label: b.label, dir: b.ok ? 'better' : 'worse', from: a.warnings, to: b.warnings });
    else if (a.warnings !== b.warnings) changes.push({ dim: k, label: b.label, dir: b.warnings < a.warnings ? 'better' : 'worse', from: a.warnings, to: b.warnings });
  }
  return { prev, changes };
}

export function report(cur, cmp) {
  const lines = [`质量总分：${cur.okCount}/${cur.total} 关通过`];
  for (const [k, v] of Object.entries(cur.dims)) {
    lines.push(`  ${v.ok ? '✓' : '✗'} ${v.label.padEnd(6)} ${v.detail}`);
  }
  lines.push('');
  lines.push('  ⚠ 分数只代表机器能查的形式（术语/深度/具体性/版式），不代表讲得清楚；');
  lines.push('    静音可读性与图文对应仍需人看（vh screen --frames）。');
  if (cmp && cmp.first) lines.push('\n（首次评分，已保存；下次 vh score 会对比）');
  else if (cmp && cmp.changes.length) {
    lines.push(`\n与上次相比（${new Date(cmp.prev.at).toLocaleString('zh-CN')}）：`);
    for (const c of cmp.changes) {
      lines.push(`  ${c.dir === 'better' ? '↑' : '↓'} ${c.label}：${c.from} → ${c.to}`);
    }
  } else if (cmp) lines.push('\n与上次相比：没有变化');
  return lines.join('\n');
}
