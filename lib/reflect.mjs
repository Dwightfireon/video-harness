/* lib/reflect.mjs —— moment of reflection 检查（vh reflect）
 *
 * 依据：Ira Glass（This American Life）说故事只有两个积木——
 *   ① anecdote：一串"发生了什么"（动作序列）
 *   ② moment of reflection：停下来，让人说"这意味着什么"
 * 他的原话是 plot, plot, reflection：先连续推进，再回望。
 *
 * 没有 ② 的片子是"事件通稿"——观众知道发生了什么，但不知道该怎么想。
 * 这一步是观众把"别人的事"变成"我的判断"的唯一机会。
 *
 * 判据（三条，都能机械判）：
 *   1. 全片有没有至少一处"回望句"（意味着/也就是说/换句话说/真正的问题/这才是/所以你看）
 *   2. 回望不能全挤在结尾 —— 中段也要有（观众需要边走边消化）
 *   3. 回望句必须指向**前文的具体内容**，不能是空泛抒情（"这很令人唏嘘"不算）
 */
import fs from 'node:fs';
import path from 'node:path';

/* 回望的标志：把前文收拢成**一句判断**。
   ⚠ 不能只认"也就是说/换句话说"——它们是转述词，常常只是重复上一句
   （真实误报：S6「也就是说，按一万次去排检修」只是同义复述，没有新增判断）。
   所以要求：出现判断词，且这句话**引入了新信息**（有对象/有因果/有对照）。 */
const REFLECT = /(这意味着|也就是说|换句话说|真正的问题|真正的|这才是|所以你看|说明|本质上|说到底|问题不在|关键不在|回过头看|事后看|这就是为什么|所以这条|可以带走)/;
/* 纯复述：判断词后面只是把上一句换个说法 */
/* 纯复述：判断词后面那半句只是换个说法，没有新对象/新因果/新对照。
   判法：判断词之后的部分，如果**只包含前文已有的词**（无数字、无"不是…而是"、无因果连接），
   就当成复述。这里用简化版：判断词后 12 字内没有出现"新实体"（数字/专名/机制词）就算复述。 */
const NEW_INFO = /\d|[零一二三四五六七八九十百千万]{2,}|"{1}[^"]{2,}"{1}|「[^」]{2,}」|[A-Z]{2,}|(不是|而是|因为|所以|导致|说明|问题|错|边界|本质)/;

/* 空泛抒情：不是回望，是感慨 */
const HOLLOW = /(令人唏嘘|令人惋惜|令人深思|不禁让人|不得不说|值得我们|具有.{0,6}意义|产生了.{0,6}影响|留下.{0,4}深刻|堪称|可谓)/;

/* 指向具体内容：数字、年份、专名、或者前文出现的实体 */
const CONCRETE = /\d|一九|[零一二三四五六七八九十百千万]{2,}|"{1}[^"]{2,}"{1}|「[^」]{2,}」|[A-Z]{2,}|(测试|试验|水槽|裂|舷窗|舱口|机身|标准|条款|检查|寿命)/;

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

export function analyze(project, opt = {}) {
  const md = (() => { try { return fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch { return ''; } })();
  if (!md) return { ok: true, scenes: [], findings: [], note: '没有 脚本.md' };
  const scenes = parseScenes(md);
  if (!scenes.length) return { ok: true, scenes: [], findings: [], note: '没有场次' };

  const hits = [];
  const hollowHits = [];
  scenes.forEach(sc => {
    sc.lines.forEach((l, idx) => {
      if (REFLECT.test(l)) {
        const concrete = CONCRETE.test(l);
        const hollow = HOLLOW.test(l) && !concrete;
        /* 判断词之后的部分有没有新信息 */
        const afterMark = (l.match(/(这意味着|也就是说|换句话说|说明)[，,]?([\s\S]*)$/) || [])[2] || '';
        const restate = !!afterMark && !NEW_INFO.test(afterMark);
        hits.push({ scene: sc.n, idx, text: l, concrete, hollow, restate });
        if (hollow) hollowHits.push({ scene: sc.n, text: l });
      }
    });
  });

  const findings = [];

  /* ① 全片一处回望都没有 */
  if (!hits.length) {
    findings.push({
      kind: 'no-reflection',
      msg: '全片没有一处"回望"（"这意味着…""真正的问题…"）—— 观众知道发生了什么，但不知道该拿它怎么办',
      fix: '在关键的 2–3 处停下来，用一句话把刚讲的东西收拢成判断。Ira Glass：plot, plot, reflection。',
    });
  }

  /* ② 全挤在最后 20% */
  const lastStart = scenes.length * 0.8;
  const early = hits.filter(h => h.scene <= lastStart);
  if (hits.length && !early.length) {
    findings.push({
      kind: 'late-reflection',
      msg: `回望全部挤在结尾（第 ${[...new Set(hits.map(h => h.scene))].join('、')} 场）—— 观众要边走边消化，不是最后一次性听懂`,
      fix: '中段也放 1–2 处回望：讲完一个机制就收一句"所以你看到的 X 是这样来的"。',
    });
  }

  /* ③ 只有空泛抒情 */
  if (hits.length && hits.every(h => !h.concrete)) {
    findings.push({
      kind: 'hollow',
      msg: `有 ${hits.length} 处"像回望"的句子，但没有一句指向具体内容 —— 都是感慨，不是判断`,
      fix: '把"这很令人唏嘘"换成"这意味着：试验对象和量产对象不是同一件事"。回望必须落到前文的具体物。',
    });
  }

  /* ④ 中段太稀：超过 3 场没有任何回望 */
  const withReflect = new Set(hits.map(h => h.scene));
  let longest = 0, run = 0, runAt = null;
  for (const sc of scenes) {
    if (withReflect.has(sc.n)) { run = 0; continue; }
    run++;
    if (run > longest) { longest = run; runAt = sc.n; }
  }
  if (longest >= 4) {
    findings.push({
      kind: 'dry-stretch',
      msg: `连续 ${longest} 场没有任何回望（到第 ${runAt} 场）—— 中间一大段是纯叙述，观众会失去"这跟我有什么关系"的锚点`,
      fix: '在这个区间里插一处短回望（一句话就够），把刚讲的内容收拢一次。',
    });
  }

  return {
    ok: findings.length === 0,
    scenes, findings,
    hits: hits.filter(h => !h.restate),
    hollowHits,
    count: hits.filter(h => !h.restate).length,
    concreteCount: hits.filter(h => h.concrete && !h.restate).length,
    sceneCount: scenes.length,
  };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['moment of reflection（有没有停下来让人"想一下"）', ''];
  lines.push(`  回望 ${res.count} 处（其中指向具体内容 ${res.concreteCount} 处）/ 全片 ${res.sceneCount} 场`);
  lines.push('');
  if (res.hits.length) {
    lines.push('  场次  具体  原文');
    for (const h of res.hits.slice(0, 8)) {
      lines.push(`  S${String(h.scene).padStart(2)}   ${h.concrete ? ' ✓ ' : ' · '}  ${String(h.text).slice(0, 44)}`);
    }
    if (res.hits.length > 8) lines.push(`  … 另有 ${res.hits.length - 8} 处`);
  }
  lines.push('');
  if (!res.findings.length) {
    lines.push('✓ 有回望，分布合理，且都落到具体内容');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('依据：Ira Glass 说故事只有两个积木 —— anecdote（动作序列）与 moment of reflection（回望）。');
  lines.push('      plot, plot, reflection：没有 reflection，观众知道发生了什么，但不知道该怎么想。');
  return lines.join('\n');
}
