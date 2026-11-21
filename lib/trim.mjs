/* 超时删减顾问（vh trim）
 *
 * 为什么需要：四分钟硬上限只告诉你"超了 25 秒"，不告诉你"该删哪一段"。
 * 用户于是只能整篇重写，反复测量——上一支片子就是这么拖长的。
 *
 * 这里做三件事，全部只读：
 *   1. 用已经实测的每句时长算出每个场的真实代价（不是按字数估）
 *   2. 从显式依赖找零引用候选，不据此证明没有隐含前提
 *   3. 展示时长代价，广告/开场/收尾默认保护；不估算教学价值
 * 输出待语义复核的候选及秒数，不是自动可执行的删稿方案。
 *
 * ⚠ 它不替用户做取舍。删除会让内容变薄，这是内容判断，必须人决定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseScript, parseChunks } from './state.mjs';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/* 从脚本里读每场的依赖行：← 依赖：S3「…」、S2、S1 */
export function dependencies(script) {
  const scenes = parseScript(script);
  return scenes.map((s, i) => {
    const block = script.split(new RegExp(`^##\\s*S${s.n}\\s*`, 'm'))[1] || '';
    const body = block.split(/^##\s*S\d+/m)[0] || '';
    const line = (body.split('\n').find(l => /依赖[：:]/.test(l)) || '');
    const refs = [...line.matchAll(/S(\d+)/g)].map(m => +m[1]);
    return { n: s.n, title: s.title, refs: refs.filter(r => r !== s.n), lines: s.lines.map(l => l.t) };
  });
}

/* 每场的实测时长：优先 timing.json 的 subs（逐句真实长度），否则按字数估。
 * A scene's cost is not only (end - start): it also carries the leading gap
 * and inter-scene spacing, otherwise the sum is smaller than DURATION and the
 * trim advisor says "over 0s" while the render gate rejects the same timeline.
 * Allocate the non-scene time (lead-in + inter-scene gaps) proportionally so
 * the totals agree exactly. */
export function sceneDurations(project, deps) {
  let subs = null, scenes = null, dur = null;
  try {
    const d = JSON.parse(read(path.join(project, 'timing.json')));
    if (Array.isArray(d.subs) && d.subs.length) subs = d.subs;
    if (Array.isArray(d.scenes) && d.scenes.length) scenes = d.scenes;
    if (Number.isFinite(d.dur) && d.dur > 0) dur = d.dur;
  } catch {}
  if (scenes && scenes.length === deps.length) {
    const spans = scenes.map(([a, b]) => +(b - a).toFixed(2));
    const spanSum = spans.reduce((a, b) => a + b, 0);
    if (dur && spanSum > 0 && Math.abs(dur - spanSum) > 0.01) {
      // Distribute lead-in + gaps by span share; the last scene absorbs the
      // rounding remainder so the sum equals DURATION exactly.
      const list = spans.map(v => +(v * dur / spanSum).toFixed(2));
      const drift = +(dur - list.reduce((a, b) => a + b, 0)).toFixed(2);
      list[list.length - 1] = +(list[list.length - 1] + drift).toFixed(2);
      return { source: '实测', list };
    }
    return { source: '实测', list: spans };
  }
  // 没有实测：按中文 3.4 字/秒 + 每句 1.0s 停顿（与 gen.mjs 估算口径一致）
  return {
    source: '估算',
    list: deps.map(d => +(d.lines.reduce((a, t) => a + Math.max(0.9, cjk(t) / 3.4), 0) + d.lines.length * 1.0).toFixed(2)),
  };
}

/* 谁被依赖：被引用次数越多，越不能动 */
function referenceCounts(deps) {
  const count = new Map(deps.map(d => [d.n, 0]));
  for (const d of deps) for (const r of d.refs) if (count.has(r)) count.set(r, count.get(r) + 1);
  return count;
}

/* 广告 / 开场 / 收尾：结构位，不参与"按价值排序删除" */
const isAd = (d) => /广告|推广/.test(d.title);
const isOpening = (d, i) => i === 0 || /开场/.test(d.title);
const isClosing = (d, i, n) => i === n - 1 || /收尾|结尾|总结|两个问题|回顾/.test(d.title);

export function trimPlan(project, { limit, keepScenes = [] } = {}) {
  const script = read(path.join(project, '脚本.md'));
  if (!script) return { ok: false, error: '没有 脚本.md，无法给出删减方案' };
  const deps = dependencies(script);
  if (!deps.length) return { ok: false, error: '脚本里没有解析到场次（## S1 · 标题 格式）' };
  const chunks = parseChunks(path.join(project, 'scenes.src.js'));
  const { source, list } = sceneDurations(project, deps);
  const total = list.reduce((a, b) => a + b, 0);
  const max = limit?.maxSeconds;
  const over = max ? total - max : 0;

  const refs = referenceCounts(deps);
  const keep = new Set(keepScenes.map(Number));
  const n = deps.length;

  const scored = deps.map((d, i) => {
    const dur = list[i] || 0;
    const structural = isAd(d) || isOpening(d, i) || isClosing(d, i, n) || keep.has(d.n);
    const refCount = refs.get(d.n) || 0;
    const chars = d.lines.reduce((a, t) => a + cjk(t), 0);
    return {
      n: d.n, title: d.title, dur, refCount, chars,
      structural,
      // Eligibility is only structural, not semantic permission to delete.
      deletable: !structural,
      density: dur > 0 ? chars / dur : 0,   // speech density, NOT content value
    };
  });

  /* Only rank time cost; zero explicit references do not prove dispensability. */
  const candidates = scored
    .filter(s => s.deletable)
    .sort((a, b) => {
      if (a.refCount !== b.refCount) return a.refCount - b.refCount;  // 没人依赖的先
      return b.dur - a.dur;
    });

  const cuts = [];
  let saved = 0;
  for (const c of candidates) {
    if (over <= 0 || saved >= over) break;
    /* ⚠ 只整场删"零依赖"的场。被引用过的场（哪怕只被引用一次）
       一旦删掉，后面那场的「← 依赖」就指向不存在的场次，链条断。
       真实事故：第一版把 refCount=1 的 S2 也列成"可整场删"，说"链条不断"，是错的。 */
    if (c.refCount > 0) continue;
    cuts.push(c);
    saved += c.dur;
  }

  /* Compatibility field: review candidates, NOT permission to compress. */
  const compressible = scored
    .filter(s => s.deletable && s.refCount > 0)
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 4);

  return {
    ok: true, total: +total.toFixed(2), max, over: +Math.max(0, over).toFixed(2),
    source, scenes: scored, cuts,
    saved: +saved.toFixed(2),
    enough: saved >= over,
    compressible, requiresSemanticReview: true,
    notes: buildNotes({ deps, scored, chunks, source, over, max, total, saved, cuts, compressible }),
  };
}

function buildNotes({ deps, scored, chunks, source, over, max, total, saved, cuts, compressible }) {
  const notes = [];
  notes.push('候选仅基于显式引用和时长；零引用不保证可删，语速密度不代表内容价值。先保护理解所需的对象、前提、行动过程、判断依据和限定。');
  if (max == null) {
    notes.push('没有启用时长硬上限，只报告现状，不因片长建议删减必要解释。');
    return notes;
  }
  if (over <= 0) {
    notes.push(`当前 ${total.toFixed(1)}s，在 ${max}s 以内，不需要删减。`);
    /* 估算模式下仍要提醒：估算时长通常偏长，别看完估算就以为超了。
       （真实事故：同一稿估算 363s / 实测 265s，差近 100 秒。） */
    if (source === '估算') {
      notes.push('⚠ 这里是**估算**时长（按字数折算）。实测通常明显更短，先跑 vh measure 再判断要不要删。');
    }
    return notes;
  }
  notes.push(`超出 ${over.toFixed(1)}s（${(over / max * 100).toFixed(0)}%）。`);
  if (source === '估算') {
    notes.push('⚠ 这里是**估算**时长。实测通常会比估算短（中文实际语速约 4 字/秒），先跑 vh measure 再删，别按估算砍掉真内容。');
  }
  const protectedOnes = scored.filter(s => s.structural).map(s => `S${s.n}`);
  if (protectedOnes.length) notes.push(`不参与删除的结构位：${protectedOnes.join('、')}（开场 / 收尾 / 广告 / 你指定的保留场）。`);
  if (!cuts.length) {
    notes.push('没有零引用整场候选。可缩小支线并同步改写后续，或讨论拆集/由用户调整上限；不要强行删必要解释。改稿后自查内容并重新测量，不自动启用模型审稿。');
    return notes;
  }
  const shortfall = over - saved;
  if (shortfall > 0.5) {
    notes.push(`即使候选全部可删仍差 ${shortfall.toFixed(1)}s；继续缩支线或讨论拆集/由用户放宽上限，不默认场内削薄。`);
    if (compressible && compressible.length) {
      notes.push('其他时长复核候选（不是语义可删结论）：');
      for (const c of compressible) notes.push(`  · S${c.n} · ${c.title} — ${c.dur}s，每秒 ${c.density.toFixed(1)} 字`);
    }
  } else {
    notes.push(`上面 ${cuts.length} 场的候选秒数足够；只有确认是可删支线且不损害理解，才可采用。`);
  }
  const thin = deps.length && chunks.length && chunks.length !== deps.length;
  if (thin) notes.push('⚠ scenes.src.js 的场块数与脚本不一致，删场时记得同步删块。');
  notes.push('删减是内容判断：确认是支线后改 脚本.md 和 scenes.src.js，自查讲述后 build 和 measure；仅显式要求审稿的项目才重审。');
  return notes;
}

export function report(project, plan) {
  const L = [];
  if (!plan.ok) { L.push('✗ ' + plan.error); return L; }
  L.push(`超时删减顾问：${plan.total}s${plan.max ? ` / 上限 ${plan.max}s` : ''}（时长来源：${plan.source}）`);
  if (plan.over > 0) L.push(`超出 ${plan.over}s`);
  L.push('');
  L.push('  场次  时长     被依赖  字数  候选  标题');
  for (const s of plan.scenes) {
    const mark = plan.cuts.some(c => c.n === s.n) ? '✂' :
      (s.structural ? '锁' : '·');
    L.push(`  S${String(s.n).padEnd(4)} ${String(s.dur).padStart(6)}s ${String(s.refCount).padStart(5)}  ` +
      `${String(s.chars).padStart(4)}  ${mark}    ${s.title}`);
  }
  L.push('');
  if (plan.cuts.length) {
    L.push('待语义复核候选（按显式引用与时长排序，不是教学价值）：');
    for (const c of plan.cuts) L.push(`  ✂ S${c.n} · ${c.title} — ${c.dur}s（被 ${c.refCount} 场依赖）`);
    L.push(`  合计可省 ${plan.saved}s${plan.enough ? ' ✓ 可达标' : ' （还不够）'}`);
  }
  L.push('');
  for (const n of plan.notes) L.push('· ' + n);
  return L;
}
