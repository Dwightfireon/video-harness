/* lib/depth.mjs —— 内容深度体检（vh depth）
 *
 * 为什么需要它：clarity 只查「术语有没有解释、依赖有没有闭合」，
 * 查不出「讲了结论但没讲过程」——上一版 6 场 121 秒、每场 3 句短句，
 * 术语和依赖全绿，但观众看完没得到机制。这个模块补上那一层。
 *
 * 它不做打分，只做两件事：① 指出这一场**缺什么**；② 给出**具体补写建议**。
 * 估时口径与 gen.mjs 保持一致（cjk/3.4 + 固定间隔），这样能对上成片时长。
 */
import fs from 'node:fs';
import path from 'node:path';

const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/* ---------- 解析：## Sn · 标题 + 编号行 + ← 依赖 ---------- */
export function parseScenes(md) {
  const scenes = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
    if (h) { cur = { n: +h[1], title: (h[2] || '').trim(), lines: [], deps: null }; scenes.push(cur); continue; }
    if (/^##\s/.test(raw)) { cur = null; continue; }
    if (!cur) continue;
    const dep = raw.match(/^←\s*依赖\s*[：:]\s*(.+)$/);
    if (dep) { cur.deps = dep[1].trim(); continue; }
    const lm = raw.match(/^\s*(\d+)[.、)]\s*(.+)$/);
    if (lm) cur.lines.push(lm[2].trim());
  }
  return scenes;
}

const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;
/* 与 gen.mjs 相同的估时：每句 max(0.9, 汉字数/3.4) + 收尾 0.4，场间 0.5，句间 0.6 */
export function estimateSeconds(scenes) {
  const LEAD = 0.5, GAP = 0.6, TAIL = 0.4, BEAT = 0.5;
  let t = LEAD;
  for (const g of scenes) {
    g.lines.forEach((line, i) => { if (i > 0) t += GAP; t += Math.max(0.9, cjk(line) / 3.4) + TAIL; });
    t += BEAT;
  }
  return t;
}

/* ---------- 每场的「展开度」线索 ---------- */
// 提示性词表：宁可漏报也不要逼作者写机器爱看的词（人话优先）
const NEED = [
  { key: '机制', label: '机制展开（为什么 / 过程）',
    re: /(因为|于是|所以|导致|一旦|就变成|来源于|学来|被强化|把.{1,12}(变成|拆成|分成|换成)|中间|第一步|那一步)/,
    advice: '补一句「为什么会这样」或「中间发生了什么」——不要从 A 直接跳到 C' },
  { key: '例子', label: '具体例子 / 走查',
    re: /(例如|比如|举例|举个|看一个|想象|假设|设想|走一遍|先.{1,12}再|场景|拿.{1,10}(走|试)|比方)/,
    advice: '补一个可想象的具体场景或走查（谁、在哪、做了什么）' },
  { key: '边界', label: '反例或边界（什么时候不适用）',
    re: /(反例|反过来|否则|不适用|什么时候|边界|例外|并不总是|不一定要|不是所有|也有.{0,6}不|但不要)/,
    advice: '补一句边界：什么情况不成立、什么情况别这么做' },
  { key: '收束', label: '本场的收束（判据 / 一句话）',
    re: /(判据|记住|一句|结论|标准是|也就是说|总之|这条|这三点|所以这条|一句话说清)/,
    advice: '补一句本场收束：这一场要观众带走的那一句' },
];

/* ---------- 体检 ---------- */
/* 叙事型识别：每场都在讲"发生了什么"（时间/事故/经过），
   不必强塞"反例/边界/收束"——那是讲解型的模板。
   判据：全片时间词密度高（年/月/日/年号）且"机制词"少。 */
function isNarrative(scenes) {
  const text = scenes.map(s => s.lines.join(' ')).join(' ');
  const timeWords = (text.match(/\d{4}年|\d{1,2}月|一九\d|同年|当年|事故|坠|失联|解体|调查/g) || []).length;
  const mechWords = (text.match(/因为|所以|机制|原理|算法|函数|参数|步骤/g) || []).length;
  return timeWords >= 6 && mechWords <= timeWords;
}

export function analyze(project, opt = {}) {
  const md = readIf(path.join(project, '脚本.md'));
  const plan = readIf(path.join(project, '方案.md'));
  const scenes = parseScenes(md);
  const est = estimateSeconds(scenes);

  // 目标时长：方案.md 里写「目标时长：4 分钟」或「时长预算：约 4 分钟」
  let target = null;
  const tm = plan.match(/(?:目标时长|时长预算)[^\n]{0,40}?(\d+(?:\.\d+)?)\s*(分钟|分|秒)/);
  if (tm) target = tm[2] === '秒' ? parseFloat(tm[1]) : parseFloat(tm[1]) * 60;
  else {
    const sm = md.match(/(?:目标时长|时长)[^\n]*?(\d+(?:\.\d+)?)\s*(分钟|分|秒)/);
    if (sm) target = sm[2] === '秒' ? parseFloat(sm[1]) : parseFloat(sm[1]) * 60;
  }
  // 场数期望：讲解型 ≥ 6 场；按目标时长推（约 30 秒一场）
  const perScene = opt.perScene || 60;              // 讲解型每场约 60 秒
  const minScenes = opt.minScenes || (target ? Math.max(6, Math.round(target / perScene)) : 6);

  /* 每场的必需项不同：开场只要现象落地与去向；练习场不强行要求反例；收尾场要求"检验" */
  const narrative = isNarrative(scenes);
  const needsFor = (scene) => {
    // 广告场不要求机制/走查/边界：它只要说清「是什么 / 前提 / 怎么行动 / 这是广告」
    if (/广告/.test(scene.title)) return [];
    if (scene.n === 1) return NEED.filter(n => n.key === '收束');
    /* 叙事型（历史/事故/经过）：每场只需讲清"发生了什么 + 为什么"，
       不强制"例子/边界/收束"——那是讲解型（教程/工具）的模板。
       强行要求会让作者往叙事里塞与内容无关的"反例"，反而变差。 */
    if (narrative) return NEED.filter(n => n.key === '机制' || n.key === '收束');
    if (/练习|怎么做|操作/.test(scene.title)) return NEED.filter(n => n.key !== '边界');
    if (/收尾|结尾|总结/.test(scene.title)) return NEED.filter(n => n.key !== '反例');
    return NEED;
  };
  const findings = [];
  for (const s of scenes) {
    const text = s.lines.join(' ');
    const chars = cjk(text);
    const per = s.lines.map(l => cjk(l));
    const avg = s.lines.length ? Math.round(chars / s.lines.length) : 0;
    const miss = needsFor(s).filter(n => !n.re.test(text));
    const isAd = /广告/.test(s.title);
    const issues = [];
    if (!isAd) {
      if (s.lines.length < 4) issues.push(`只有 ${s.lines.length} 句（深度版建议 ≥ 4 句）`);
      if (avg < 22) issues.push(`平均每句 ${avg} 字，偏短（建议 ≥ 22 字：一句要把条件或过程说完）`);
      if (chars < 120) issues.push(`本场共 ${chars} 字（形式参考 ≥ 120 字，不代表信息量不足）`);
    }
    for (const m of miss) issues.push(`未匹配「${m.label}」相关词 → 结合上下文核对是否需要：${m.advice}`);
    findings.push({ n: s.n, title: s.title, lines: s.lines.length, chars, avg, issues, missing: miss.map(m => m.key) });
  }

  const hard = [];
  if (scenes.length < minScenes) hard.push(`只有 ${scenes.length} 场，目标时长 ${target ? Math.round(target) + 's' : '未写'} 下建议 ≥ ${minScenes} 场`);
  if (target && est < target * 0.75) hard.push(`估算时长 ${est.toFixed(0)}s，距目标 ${Math.round(target)}s 差 ${Math.round((target - est) / Math.max(1, target) * 100)}% —— 核对是否需要补充机制与例子，不为指标凑内容`);
  const thinScenes = findings.filter(f => f.issues.length >= 3);
  if (thinScenes.length) hard.push(`${thinScenes.length} 个场次触发多项展开度形式规则：第 ${thinScenes.map(f => f.n).join('、')} 场`);

  return { scenes: findings, count: scenes.length, est, target, minScenes, hard, ok: hard.length === 0 };
}

/* ---------- 报告 ---------- */
export function report(project, res) {
  const lines = [];
  lines.push(`内容深度体检：${res.count} 场 · 估算时长 ${res.est.toFixed(0)}s` + (res.target ? ` · 目标 ${Math.round(res.target)}s` : ' · 目标（未在方案.md 写）'));
  lines.push(res.ok ? '未触发展开度形式规则；内容是否充分仍需人工审阅。' : `${res.hard.length} 项形式线索，需结合原文核对，不必为指标凑内容：`);
  for (const h of res.hard) lines.push('  · ' + h);
  const bad = res.scenes.filter(s => s.issues.length);
  if (bad.length) {
    lines.push('');
    lines.push('逐场线索（句数和关键词不代表讲解是否充分）：');
    for (const s of bad) {
      lines.push(`  第 ${s.n} 场「${s.title}」（${s.lines} 句 / ${s.chars} 字 / 均 ${s.avg} 字）`);
      for (const i of s.issues) lines.push('    - ' + i);
    }
  }
  return lines.join('\n');
}
