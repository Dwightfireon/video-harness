/* lib/hook.mjs —— 开场钩子检查（vh hook）
 *
 * 只识别可选的讲述形式，不判断开场清楚与否、观众留存或学习效果。
 * Muller 对特定情境下已有误解的研究，不代表所有主题都需要悬念或反转。
 * 这个模块查前 N 句里有没有这些形式线索：
 *   ① 设问（真问题，不是反问修辞）
 *   ② 反常识断言（"其实不是…""你以为是 X，其实"）
 *   ③ 具体场景（有人、有地点、有动作 —— Ira Glass 的 anecdote）
 *
 * 不判"钩子好不好"，也不要求作者凑设问；主题、去向与例子的关系需实际审稿。
 */
import fs from 'node:fs';
import path from 'node:path';

/* 设问：句中或句尾有问号，且不是反问修辞（"难道…吗"）。
   ⚠ 真实误报：S1 写的是「那真正的凶手是什么？这一期带你从头查一遍。」——
   问号在句中（后面接了一句过渡），按"句尾问号"判会漏掉全片最重要的那个问题。 */
const QUESTION = /[？?]/;
const RHETORICAL = /(难道|岂不|不是吗|何必|何尝)/;
/* 反常识：直接否定一个常见说法 */
/* 反常识：直接否定一个说法。
   两种句式都算：
     ① "不是 X，而是 Y"（完整对照）
     ② "…不是 X"（直接否定，X 常是那个流行说法）
   真实误报：S1 写「裂开的地方不是乘客舷窗」，是强反转，但旧判据只认 ①。 */
const COUNTER = /(其实不是|并不是|不是[^。]{1,14}(而是|造成的)|你以为|大家都以为|你大概听过|常说法|流传|误解|错在|真正的.{0,6}(不是|原因)|反过来|不是[^。]{2,12}[。，])/;
/* 具体场景：有人称/地点/动作（Ira Glass：a sequence of actions，不是"是什么"） */
const SCENE = /(有人|一个人|那天|当时|一九|195\d|他|她|调查组|工程师|飞行员|机组|乘客|走进|打开|登上|坐进|把.{1,12}(放进|推进|抬到|搬到))/;
/* 以讲述意图开场：只作形式线索，不代表抽象或不清楚 */
const ABSTRACT = /^(这|那|本|该)?(一期|本片|今天|我们|这条)?.{0,6}(讲|说|聊|介绍|带你|要讲)/;

/* ---------- 开场形式特征（兼容旧 scoreHook API，不预测效果） ----------
 * 按四类词面特征计分（满分 10）：
 *   ① 前 3 句里有没有一个**具体到能想象的东西**（人/地点/数字/动作）
 *   ② 有没有**打破预期**（"其实不是""大家都以为"）
 *   ③ 有没有**悬念**（问题 + 不马上回答）
 *   ④ 第一句的字数（仅作统计）
 */
export function scoreHook(lines) {
  const head = lines.slice(0, 3);
  const text = head.join(' ');
  const first = head[0] || '';
  const reasons = [];
  let score = 0;

  /* ① 具体对象：有人/有地点/有数字/有动作 */
  const concreteHit = /(有人|一个人|他|她|调查组|工程师|飞行员|机组|乘客|一九|\d{2,})/.test(text)
    && /(走进|打开|登上|坐进|放|推|抬|搬|飞|坠|解体|失联|测量|加压|裂)/.test(text);
  if (concreteHit) { score += 3; reasons.push('命中对象与动作词'); }
  else if (/(有人|一个人|调查组|一九|\d{2,})/.test(text)) { score += 1.5; reasons.push('命中对象词，未命中动作词'); }

  /* ② 打破预期 */
  const surprise = /(其实不是|并不是|大家都以为|你大概听过|流传|误解|被写进|反而是|恰恰相反)/.test(text);
  if (surprise) { score += 3; reasons.push('命中反差词句'); }

  /* ③ 悬念：有问号，且前 3 句里没给出答案（"答案在下面"的迹象） */
  const hasQ = head.some(l => /[？?]/.test(l));
  const answeredAtOnce = /(答案是|原因就是|因为这就是)/.test(text);
  if (hasQ && !answeredAtOnce) { score += 2.5; reasons.push('有问号，未命中即时回答词'); }
  else if (hasQ) { score += 1; reasons.push('有问号和即时回答词'); }

  /* ④ 第一句够短 */
  const firstLen = (first.match(/[\u4e00-\u9fff]/g) || []).length;
  if (firstLen > 0 && firstLen <= 26) { score += 1.5; reasons.push(`第一句 ${firstLen} 字`); }
  else if (firstLen <= 40) { score += 0.5; reasons.push(`第一句 ${firstLen} 字`); }
  else { reasons.push(`第一句 ${firstLen} 字`); }

  return { score: Math.round(score * 10) / 10, reasons, firstLen, concreteHit, surprise, hasQ };
}

export function analyze(project, opt = {}) {
  const md = (() => { try { return fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch { return ''; } })();
  if (!md) return { ok: true, scenes: [], findings: [], note: '没有 脚本.md' };

  /* 解析场次 */
  const scenes = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
    if (h) { cur = { n: +h[1], title: (h[2] || '').trim(), lines: [] }; scenes.push(cur); continue; }
    if (/^##\s/.test(raw)) { cur = null; continue; }
    const lm = raw.match(/^\s*\d+[.、)]\s*(.+)$/);
    if (cur && lm) cur.lines.push(lm[1].trim());
  }
  const real = scenes.filter(s => s.lines.length);
  if (!real.length) return { ok: true, scenes: [], findings: [], note: '没有场次' };

  const findings = [];
  const detail = real.map(s => {
    const head = s.lines.slice(0, 3).join(' ');
    const q = s.lines.slice(0, 3).some(l => QUESTION.test(l) && !RHETORICAL.test(l));
    const c = COUNTER.test(head);
    const sc = SCENE.test(head);
    const abs = s.lines.slice(0, 2).every(l => ABSTRACT.test(l)) && !q && !c;
    const strength = s.n === 1 ? scoreHook(s.lines) : null;
    return { n: s.n, title: s.title, hasQuestion: q, hasCounter: c, hasScene: sc, isAbstract: abs, first: s.lines[0], strength };
  });

  /* ① 前三句的形式线索，不表示必须有钩子 */
  const s1 = detail[0];
  if (!s1.hasQuestion && !s1.hasCounter) {
    findings.push({
      kind: 'no-hook',
      scene: 1,
      msg: '开场前 3 句未检测到设问或反常识断言；直接交代主题也是有效讲法。',
      fix: '检查观众能否知道主题、为什么讲和接下来要回答什么；有真实疑问时再考虑设问。',
    });
  }
  /* ② 统计设问形式；陈述式讲解也可以清楚 */
  /* 全片的设问数：扫**所有句**，不只是前 3 句
     （真实误报：S1 的真问题写在第 5 句，按前 3 句统计就漏了） */
  const allQ = real.flatMap(sc => sc.lines.filter(l => QUESTION.test(l) && !RHETORICAL.test(l)));
  const qCount = allQ.length;
  if (qCount === 0) {
    findings.push({
      kind: 'no-question',
      msg: '全片未检测到设问句；这不代表讲解缺少问题意识。',
      fix: '检查各段是否围绕主题展开，必要时补明前提或段落关系，不必为数量添加设问。',
    });
  }
  /* ③ 统计以讲述意图开场的场次，不判内容质量 */
  const absCount = detail.filter(d => d.isAbstract).length;
  if (absCount >= Math.ceil(real.length / 2)) {
    findings.push({
      kind: 'too-abstract',
      msg: `${absCount}/${real.length} 场以"这一期讲…"一类词句开头；仅凭句式无法判断是否清楚。`,
      fix: '检查每场是否承接主线，并在需要时展开对象、原因和例子。',
    });
  }

  /* 兼容旧分数：形式特征少不代表质量差 */
  const st = detail[0].strength;
  if (st && st.score < 5) {
    findings.push({
      kind: 'weak-hook',
      scene: 1,
      msg: `开场形式特征 ${st.score}/10（${st.reasons.join('；')}）；分数不预测留存或理解。`,
      fix: '实际检查主题是否清楚、前提是否足够、例子是否服务内容，不必凑形式分。',
    });
  }

  /* 设问位置只作记录，不要求一定前移 */
  if (s1.hasCounter && (() => {
    const firstQ = real[0].lines.findIndex(l => QUESTION.test(l) && !RHETORICAL.test(l));
    return firstQ >= 3;
  })()) {
    findings.push({
      kind: 'late-question',
      scene: 1,
      msg: '开场的设问出现在第 4 句之后；这里只记录出现的位置。',
      fix: '检查前面的内容是否已经交代主题和去向，按讲述需要决定是否调整。',
    });
  }

  // 这些仅是形式观察，不能作为失败或语义质量判断。
  return { ok: true, scenes: detail, findings: findings.map(f => ({ ...f, severity: 'info' })), questionCount: qCount, abstractCount: absCount, allQuestions: allQ, hookStrength: detail[0].strength };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['开场形式线索（不能证明内容清楚或预测观众留存）', ''];
  lines.push('  场次  设问  反常识  具体场景  开场句');
  for (const s of res.scenes) {
    const m = (b) => (b ? ' ✓ ' : ' · ');
    lines.push(`  S${String(s.n).padStart(2)} ${m(s.hasQuestion)}${m(s.hasCounter)}${m(s.hasScene)}   ${String(s.first).slice(0, 30)}`);
  }
  lines.push('');
  if (res.hookStrength) {
    lines.push(`形式特征 ${res.hookStrength.score}/10（${res.hookStrength.reasons.join('；')}；非质量评分）`);
  }
  lines.push(`设问 ${res.questionCount} 处 / 讲述意图式开场 ${res.abstractCount} 场`);
  lines.push('');
  if (!res.findings.length) {
    lines.push('✓ 未发现当前规则提示的形式线索；不代表内容审阅通过');
  } else {
    for (const f of res.findings) {
      lines.push(`· ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('参考：Muller 的研究针对特定教学情境中的已有误解，不能推成所有视频必须设问或制造反转。');
  lines.push('以上线索均为信息，不会使 --strict 判失败；也不代表内容审阅通过。');
  lines.push('主题、论述顺序和理解效果需按原文与受众实际审稿。');
  return lines.join('\n');
}
