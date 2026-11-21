/* lib/loop.mjs —— 悬念闭环检查（vh loop）
 *
 * 用词面线索提示可能需要交代的问题，不判断观众的反应。
 *
 * 判据：
 *   1. 每个设问句，后面有没有对应的回答（按关键词重叠 + 距离判）
 *   2. 问题与匹配句相隔较远时提示人工核对
 *
 * 关键词匹配不等于理解了问题或答案，问与答是否对应须人工审阅。
 */
import fs from 'node:fs';
import path from 'node:path';

/* 停用词：不参与关键词匹配 */
const STOP = new Set('的了是在和与或就都也很不没有这那个一你我的他她它们为以对从到被把让给还而且但如果因为所以然后可以什么怎么为什么怎样多少'.split(''));

/* 抽关键词：中文二元组 + 英文词 + 数字 */
function keywords(text) {
  const t = String(text);
  const out = new Set();
  for (const m of t.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seg = m[0];
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2);
      if (!STOP.has(bg[0]) && !STOP.has(bg[1])) out.add(bg);
    }
  }
  for (const m of t.matchAll(/[A-Za-z]{3,}|\d{2,}/g)) out.add(m[0].toLowerCase());
  return out;
}

function parseScenes(md) {
  const out = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
    if (h) { cur = { n: +h[1], title: (h[2] || '').trim(), lines: [] }; out.push(cur); continue; }
    if (/^##\s/.test(raw)) { cur = null; continue; }
    const lm = raw.match(/^\s*\d+[.、)]\s*(.+)$/);
    if (cur && lm) cur.lines.push(lm[1].trim());
  }
  return out.filter(s => s.lines.length);
}

/* 句中或句尾有问号都算（问号后面常接一句过渡，按句尾判会漏掉） */
const isQuestion = (l) => /[？?]/.test(l) && !/(难道|岂不|不是吗|何必)/.test(l);

export function analyze(project) {
  const md = (() => { try { return fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch { return ''; } })();
  if (!md) return { ok: true, questions: [], findings: [], note: '没有 脚本.md' };
  const scenes = parseScenes(md);
  if (!scenes.length) return { ok: true, questions: [], findings: [], note: '没有场次' };

  /* 收集所有设问 */
  const questions = [];
  for (const sc of scenes) {
    sc.lines.forEach((l, idx) => {
      if (isQuestion(l)) questions.push({ scene: sc.n, idx, text: l, kw: keywords(l) });
    });
  }

  const findings = [];
  const answered = [];

  for (const q of questions) {
    /* 在它**之后**的场次里找回答：关键词重叠 ≥2，或同场后续 */
    const laterLines = [];
    for (const sc of scenes) {
      sc.lines.forEach((l, idx) => {
        if (sc.n < q.scene) return;
        if (sc.n === q.scene && idx <= q.idx) return;
        laterLines.push({ scene: sc.n, text: l, kw: keywords(l) });
      });
    }
    let best = null;
    for (const cand of laterLines) {
      let hit = 0;
      for (const k of q.kw) if (cand.kw.has(k)) hit++;
      if (!best || hit > best.hit) best = { ...cand, hit };
    }
    /* 收尾场的"可以多问一句…"是给观众的呼吁，不是悬念 —— 豁免 */
    const isClosingCall = q.scene === scenes.length && /(可以多问|不妨|下次看到|以后看到|你可以)/.test(q.text);
    if (isClosingCall) { answered.push({ ...q, answerScene: q.scene, answerHit: 99, answerLine: '（收尾呼吁，不需回答）', distance: 0, closing: true }); continue; }
    /* 重叠阈值按问题长度自适应：短问题（<12 字）只要 1 个重叠就算接上了，
       否则"那这个说法对吗？"这种三字问题永远匹配不上（真实误报）。 */
    const need = q.text.replace(/[？?\s]/g, '').length <= 12 ? 1 : 2;
    /* 另一种合法回答方式：**紧跟着的下一句就是答案**，不需要共享关键词。
       （"那这个说法对吗？" → "调查组画出的三处裂点…" —— 这是同一口气说完的。）
       判据：下一句不含新问号，且不是过渡句（"这一期""接下来"）。 */
    const nextLine = (() => {
      const idx = scenes.findIndex(x => x.n === q.scene);
      if (idx < 0) return null;
      const arr = scenes[idx].lines;
      /* 往后最多看 3 句，跳过"这一期讲…"这类过渡句 */
      for (let k = 1; k <= 3; k++) {
        const nxt = arr[q.idx + k];
        if (!nxt) break;
        if (isQuestion(nxt)) break;               // 又抛新问题，说明上一问还没答
        if (/^(这一期|接下来|下面|我们|那么)/.test(nxt)) continue;
        return nxt;
      }
      return null;
    })();
    const ok = (best && best.hit >= need) || !!nextLine;
    const useNext = !(best && best.hit >= need) && !!nextLine;
    answered.push({ ...q, answerScene: ok ? (useNext ? q.scene : best.scene) : null, answerHit: best ? best.hit : 0, answerLine: ok ? (useNext ? nextLine : best.text) : null, distance: ok ? (useNext ? 0 : best.scene - q.scene) : null });
    if (!ok) {
      findings.push({
        kind: 'unanswered',
        scene: q.scene,
        msg: `第 ${q.scene} 场的设问未匹配到回答：「${q.text.slice(0, 30)}」；可能是同义表述或无需回答的问句。`,
        fix: '结合上下文核对它是否需要回答，以及答案是否足够明确。',
      });
    } else if (best.scene - q.scene > Math.max(3, scenes.length * 0.5) && !(q.scene === 1 && /真正的|到底|究竟是什么/.test(q.text))) {
      /* 开场就抛出的"真问题"贯穿全片是设计，不是失误（豁免） */
      findings.push({
        kind: 'too-late',
        scene: q.scene,
        msg: `第 ${q.scene} 场的问题与匹配句相隔 ${best.scene - q.scene} 场，需确认两者是否对应。`,
        fix: '按内容检查问题是否得到交代，不必为满足固定间隔插入线索。',
      });
    }
  }

  return { ok: findings.length === 0, questions: answered, findings, sceneCount: scenes.length };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['设问与回答的词面线索（不代表人工审阅）', ''];
  if (!res.questions.length) {
    lines.push('  （未检测到设问句；无需为此添加设问）');
  } else {
    lines.push('  提问场次  问题                              回答场次  间隔');
    for (const q of res.questions) {
      const a = q.answerScene ? `S${q.answerScene}` : '未匹配';
      const d = q.distance == null ? '' : `${q.distance} 场`;
      lines.push(`  S${String(q.scene).padStart(2)}      ${String(q.text).slice(0, 32).padEnd(34)} ${String(a).padEnd(8)} ${d}`);
    }
  }
  lines.push('');
  if (!res.findings.length) {
    lines.push(res.questions.length ? '未发现词面匹配疑点；是否回答充分仍需人工核对。' : '没有需要词面匹配的设问；内容是否清楚仍需人工审阅。');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('口径：按问号和部分反问词粗略识别；结果可能误判，不能代替上下文理解。');
  return lines.join('\n');
}
