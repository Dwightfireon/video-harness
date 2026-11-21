/* 动作时间点静态线索，不是成片节奏或审美评分。
 * 只识别一部分字面量写法，不能证明动作实际执行、幅度可见或停顿不合理。 */
import fs from 'node:fs';
import path from 'node:path';
import { maskJS } from './js-mask.mjs';

/* 引擎/注入块里可用的动效原语 */
const PRIMITIVES = {
  enter: /(?:^|[^\w.])enter\s*\(/g,             // 入场（位移+模糊）
  pop: /(?:^|[^\w.])pop\s*\(/g,                 // 弹入（缩放）
  reveal: /(?:^|[^\w.])reveal\s*\(/g,           // 揭示（遮罩）
  rollNum: /(?:^|[^\w.])rollNum\s*\(/g,         // 数字滚动
  kf: /(?:^|[^\w.])kf\s*\(/g,                   // 关键帧
  camera: /(?:^|[^\w.])camera\s*\(/g,           // 运镜
  oneTake: /VH_UI\.oneTake\s*\(/g,              // 一镜到底
  dolly: /FX\.dolly\s*\(/g,                     // 推拉
  breathe: /FX\.breathe\s*\(/g,                 // 光斑呼吸
  glyph: /glyphField|glyphLayer/g,              // 字符场
  bars: /\.style\.width\s*=\s*\(/g,             // 条形增长
  countUp: /P\(\s*(?:rt|t)[^)]*\)\s*\*\s*(?:Math|[\d\w])/g,
  /* VH_MOTION 原语（第八批新增）—— 它们都带 { at: 秒 }，是"中段变化"的主力 */
  countTo: /\bmotion\.countTo\s*\(|\bcountTo\s*\(/g,
  slideTo: /\bmotion\.slideTo\s*\(|\bslideTo\s*\(/g,
  growTo: /\bmotion\.growTo\s*\(|\bgrowTo\s*\(/g,
  compiled: /\bcompileMotion\s*\(/g,
};

/* 所有"带 at 的动画调用"都算一个变化点（这是判断密度的主依据） */
const NUM = '(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))(?=\\s*[,})])';
const AT_CALL = new RegExp('\\b(?:countTo|slideTo|growTo|pop|reveal|kf|camera|enter)\\s*\\([^;]{0,240}?\\bat\\s*:\\s*' + NUM, 'g');
/* 也认 eOut3(P(rt, at, dur)) 这种 */
const AT_P = new RegExp('\\bP\\(\\s*(?:rt|t)\\s*,\\s*' + NUM, 'g');
/* 位置参数写法：enter(el, rt, 0.5, {...}) —— 第 3 个参数就是 at */
const AT_POS = new RegExp('\\b(?:enter|pop|reveal)\\s*\\(\\s*[^,;]+,\\s*(?:rt|t)\\s*,\\s*' + NUM, 'g');

export function scan(project, opt = {}) {
  const src = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
   if (!src) return { ok: false, scenes: [], findings: [], note: '没有 scenes.src.js，无法检查动作时间点' };
  const html = (() => { try { return fs.readFileSync(path.join(project, 'scene.html'), 'utf8'); } catch { return ''; } })();
  const ranges = [...html.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);

  const chunks = src.split(/^\/\/---\s*$/m).map(c => c.trim()).filter(Boolean);
  const findings = [];
  const scenes = [];
  const usedTypes = new Set();

  chunks.forEach((raw, i) => {
    const chunk = maskJS(raw);
    const n = i + 1;
    const [a, b] = ranges[i] || [0, 0];
    const dur = Math.max(0, b - a);

    const types = [];
    for (const [k, re] of Object.entries(PRIMITIVES)) {
      re.lastIndex = 0;
      if (re.test(chunk)) { types.push(k); usedTypes.add(k); }
    }
    const compiled = types.includes('compiled');
    const cueDriven = /\.sceneCue\s*\(/.test(chunk);
    const unresolved = compiled || cueDriven;

    /* 变化点：两种写法都算
       ① P(rt, at, dur) —— 时间驱动
       ② 任意带 { at: 秒 } 的动画调用（countTo/slideTo/growTo/pop/reveal/kf/enter） */
    const ats = [
      ...[...chunk.matchAll(AT_P)].map(m => +m[1]),
      ...[...chunk.matchAll(AT_CALL)].map(m => +m[1]),
      ...[...chunk.matchAll(AT_POS)].map(m => +m[1]),
    ];
    const outside = ats.filter(v => v < 0 || (dur > 0 && v >= dur));
    const beats = [...new Set(ats.filter(v => v >= 0 && (!dur || v < dur)).map(v => Math.round(v * 1000) / 1000))].sort((x, y) => x - y);
    const beatCount = beats.length;

    /* 期望段数：每 5 秒一次（4–6 秒的中值），至少 2 段 */
    const expected = Math.max(2, Math.round(dur / 5));
    const gaps = [];
    let prev = 0;
    for (const t of beats) { gaps.push(+(t - prev).toFixed(1)); prev = t; }
    if (dur) gaps.push(+(dur - prev).toFixed(1));
    const maxGap = gaps.length ? Math.max(...gaps) : dur;

    scenes.push({ n, dur: +dur.toFixed(1), types, beats, beatCount, expected, maxGap, gaps,
      coverage: !dur ? 'missing-timing' : compiled ? 'compiled-unresolved' : cueDriven ? 'cue-unresolved' : beatCount ? 'partial' : 'unknown', outside });

    if (!dur) findings.push({ kind: 'missing-timing', scene: n, msg: `第 ${n} 场缺少有效时间范围，不能评估间隔` });
    if (outside.length) findings.push({ kind: 'outside-scene', scene: n,
      msg: `第 ${n} 场 ${[...new Set(outside)].join(' / ')}s 的触发点在场景范围外，未计入` });
    if (unresolved) findings.push({ kind: 'runtime-plan', scene: n,
      msg: `第 ${n} 场使用字幕锚点，静态检查不能展开当前动作起点，数量与间隔未验证`,
      fix: 'build 后对照当前字幕与预览核对动作；不能将未解析的锚点记成零动作或整场静止。' });

    if (!unresolved && dur >= 6 && beatCount < expected) {
      findings.push({
        kind: 'sparse', scene: n,
        msg: `第 ${n} 场 ${dur.toFixed(0)} 秒中仅识别 ${beatCount} 个动作起点（参考 ${expected}）；最长起点间隔 ${maxGap.toFixed(1)} 秒`,
        fix: '对照旁白审阅：是否需要分步揭示、状态变化或拆场？动态表达式/自定义动画可能未识别，阅读停顿不必补动效。',
      });
    }
    if (!unresolved && dur >= 6 && beatCount >= expected && maxGap > 6) {
      findings.push({ kind: 'clustered', scene: n,
        msg: `第 ${n} 场动作起点集中，最长 ${maxGap.toFixed(1)} 秒未识别新起点`,
        fix: '看完整动作过程后判断；起点间隔不等于静止时长，不要为凑次数加无意义运动。' });
    }
    if (!unresolved && dur >= 10 && types.length <= 1) {
      findings.push({
        kind: 'monotone-motion', scene: n,
        msg: `第 ${n} 场仅识别 ${types.length} 种动效（${types[0] || '无'}），需审阅对象是否随讲述推进`,
        fix: '动效种类仅供定位，不是配额；一种恰当的动作也可以讲清关系。',
      });
    }
  });

  /* 全片动效类型数：只有 1–2 种 = 全片一个味 */
  if (chunks.length >= 3 && !scenes.some(s => ['compiled-unresolved', 'cue-unresolved'].includes(s.coverage)) && usedTypes.size <= 2) {
    findings.push({
      kind: 'few-types',
      msg: `全片仅识别 ${usedTypes.size} 种动效：${[...usedTypes].join(' / ') || '（无）'}，请人工检查是否重复套用入场模板`,
      fix: '优先让动作表达内容关系，不要求凑满三种动效。',
    });
  }

  const totalBeats = scenes.reduce((s, x) => s + x.beatCount, 0);
  const totalDur = scenes.reduce((s, x) => s + x.dur, 0);
  return {
    ok: findings.length === 0,
    scenes, findings,
    usedTypes: [...usedTypes],
    totalBeats,
    totalDur: +totalDur.toFixed(1),
    beatsPerMinute: totalDur ? +(totalBeats / (totalDur / 60)).toFixed(1) : 0,
  };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['动作时间点（静态启发式；不等于可见变化或成片质量）', ''];
  lines.push('  场次   时长  变化段*  参考  起点间隔  识别的动效');
  for (const s of res.scenes) {
    const flag = res.findings.some(f => f.scene === s.n) ? ' ?' : '';
    const unresolved = ['compiled-unresolved', 'cue-unresolved'].includes(s.coverage);
    lines.push(`  S${String(s.n).padStart(2)}  ${String(s.dur).padStart(5)}s  ${String(unresolved ? '未解析' : s.beatCount).padStart(5)}${flag}  ${String(s.expected).padStart(4)}  ${String(unresolved ? '未解析' : s.maxGap.toFixed(0) + 's').padStart(8)}  ${s.types.join('+') || '—'}`);
  }
  lines.push('');
  lines.push(`全片 ${res.totalBeats} 段变化 / ${res.totalDur}s = 每分钟 ${res.beatsPerMinute} 段；动效类型 ${res.usedTypes.length} 种：${res.usedTypes.join(' / ') || '无'}`);
  if (res.scenes.some(s => ['compiled-unresolved', 'cue-unresolved'].includes(s.coverage))) lines.push('上面的段数仅含已识别字面量，不包含未展开的字幕锚点或编排计划，不能作为全片运动密度。');
  lines.push('');
  if (!res.findings.length) {
    lines.push('未发现已识别起点的分布疑点；尚未验证可见运动、语音同步或审美质量。');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
    lines.push('');
    lines.push(`${res.findings.length} 处待核对线索；不是审片结论。`);
  }
  lines.push('');
  lines.push('口径：变化段* = 可识别的字面量动作起点，支持 t/rt；已排除注释、字符串及场外起点。');
  lines.push('动态表达式、自定义动画和模板插值可能漏检；起点间隔不是静止时长。阅读停顿不需要持续漂移。');
  return lines.join('\n');
}
