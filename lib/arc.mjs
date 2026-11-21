/* lib/arc.mjs —— 叙事弧检查（vh arc）
 *
 * 依据两套结构：
 *   ① Randy Olson 的 ABT：And（共识）→ But（缺口/冲突）→ Therefore（结果）
 *      AAA（and, and, and）是"讲课"，ABT 才是"讲故事"。区别只在那个 BUT。
 *      出处：MIT CommLab《Scientific Storytelling: The ABT Method》
 *   ② Kenn Adams 的 Story Spine（Pixar 采用）：
 *      Once upon a time → Every day → But one day → Because of that → Until finally → Ever since
 *
 * 这个模块查三件事：
 *   1. AND 段（出事之前的世界）相关的词句
 *   2. BUT 段中冲突与补充说明的部分词面线索
 *   3. Ever since 段可能涉及的当下关系
 *
 * 这是可选叙事框架的词面线索，不是所有讲解的必需结构；
 * 不判断内容是否清楚，也不能据此要求作者编造冲突。
 */
import fs from 'node:fs';
import path from 'node:path';

/* AND：建立"当时大家都觉得没问题"的共识 */
const AND_RE = /(当时|那时|一九.{0,6}年|所有人|普遍认为|行业认为|被视为|都以为|看起来|正常运行|投入运营|已经开始|标准是)/;
/* BUT：真冲突 —— "可是这里说不通"。
   ⚠ 不能只靠词命中：真实误报——S7"更麻烦的是"被算成 BUT，
   但那只是"再加一条"，不是"这里有个说不通的地方"。
   真冲突的特征是三件事同时成立：
     ① 点出一个反常（"说不通/对不上/解释不了/怎么会"）
     ② 指向具体的对象（哪个数、哪个现象）
     ③ 后面有"所以/于是"接住它
   这里用 ① + ② 判：必须有明确的反常词，而不是"但/更麻烦/不过"。 */
const BUT_STRONG = /(说不通|对不上|解释不了|无法解释|矛盾|蹊跷|反常|怎么会|偏偏|就在这时|问题就出|真正的问题|不是.{1,8}而是.{0,6}(问题|错)|按理说.{0,20}(却|但))/;
/* BUT 弱化版：只是补充说明 */
const BUT_WEAK = /^(但|不过)/;
/* THEREFORE：结果/解法/标准 */
const THEREFORE = /(所以|于是|因此|由此|这才|从此|结果|改进|改成|要求|标准|规定|转向|变成)/;
/* EVER SINCE：跟今天/跟观众的关系 */
const EVER_SINCE = /(今天|现在|如今|你(坐|看|用|身边)|你我|我们(今天|现在)|每(一)?架|现行|沿用|至今|后来.{0,8}都)/;

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

export function analyze(project) {
  const md = (() => { try { return fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch { return ''; } })();
  if (!md) return { ok: true, scenes: [], findings: [], note: '没有 脚本.md' };
  const scenes = parseScenes(md);
  if (scenes.length < 2) return { ok: true, scenes, findings: [], note: '场次太少' };

  const firstHalf = scenes.slice(0, Math.max(1, Math.ceil(scenes.length * 0.6)));
  const allText = scenes.map(s => s.lines.join(' ')).join('\n');
  const headText = firstHalf.map(s => s.lines.join(' ')).join(' ');
  const tailText = scenes.slice(Math.floor(scenes.length * 0.6)).map(s => s.lines.join(' ')).join(' ');

  const findings = [];

  /* ① AND：出事之前的世界 */
  const andHit = headText.match(AND_RE);
  if (!andHit) {
    findings.push({
      kind: 'no-and',
      msg: '前 60% 未识别到常态描写的相关词句；关键词不能判断背景是否清楚。',
      fix: '需要背景时，检查观众能否理解对象和条件；不必为套结构补造常态。',
    });
  }

  /* ② BUT：真冲突（必须点出反常 + 带具体对象） */
  const strongLines = [];
  for (const sc of scenes) {
    for (const l of sc.lines) {
      if (!BUT_STRONG.test(l)) continue;
      /* 带具体对象：不能只是空喊"这很奇怪"。
         具体对象 = 阿拉伯/中文数字、年份、专名、或者**点明了一个具体机制/现象**
         （真实误报："设计越保守，越没人怀疑它会在几千次之后自己裂开" —— 
          这里没有阿拉伯数字，但"几千次""裂开"就是具体对象，之前被误判成空话）。 */
      const concrete = /\d|一九|[零一二三四五六七八九十百千万]{2,}|"[^"]{2,}"|「[^」]{2,}」|[A-Z]{2,}|[a-zA-Z]{3,}|(裂|断|掉|烧|沉|超载|失效|老化|疲劳|腐蚀|漏|卡死|失控)/.test(l);
      if (concrete) strongLines.push({ scene: sc.n, line: l });
    }
  }
  const strong = strongLines;
  const weakCount = scenes.filter(s => s.lines.some(l => BUT_WEAK.test(l))).length;
  if (!strong.length) {
    findings.push({
      kind: 'no-but',
      msg: `未识别到符合当前关键词规则的冲突句；${weakCount} 场以"但/不过"开头。`,
      fix: '根据原文和题材判断是否需要讲矛盾；不要为套 ABT 编造冲突。',
    });
  }

  /* ③ THEREFORE：不只是"出现所以"，还要**解法回应了冲突**。
     真实教训：老判据只要文本里出现"所以/于是"就通过 ——
     但"所以天气不好"这种和冲突无关的"所以"也会过，等于没检查。 */
  const thereforeHit = THEREFORE.test(allText);
  let responds = null;
  if (thereforeHit && strongLines.length) {
    /* 冲突句里的关键词（去掉停用词），看解法段里有没有回应 */
    const STOP = new Set('的了是在和与或就都也很不没有这那个一你我的他她它们为以对从到被把让给还而且但如果因为所以然后可以什么怎么为什么怎样多少'.split(''));
    const kwOf = (t) => {
      const out = new Set();
      for (const m of String(t).matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        for (let i = 0; i < m[0].length - 1; i++) {
          const bg = m[0].slice(i, i + 2);
          if (!STOP.has(bg[0]) && !STOP.has(bg[1])) out.add(bg);
        }
      }
      return out;
    };
    const conflictKw = new Set();
    for (const sl of strongLines) for (const k of kwOf(sl.line)) conflictKw.add(k);
    /* 解法段 = 第一次 THEREFORE 之后的所有文本 */
    const firstT = allText.search(THEREFORE);
    const solutionText = firstT >= 0 ? allText.slice(firstT) : '';
    const solKw = kwOf(solutionText);
    let overlap = 0;
    for (const k of conflictKw) if (solKw.has(k)) overlap++;
    responds = overlap >= 2;
  }
  if (!thereforeHit) {
    findings.push({
      kind: 'no-therefore',
      msg: '未识别到"所以/于是/从此"等结果词；不代表内容没有交代结果。',
      fix: '需要交代结果时，结合全文检查结果或判断是否明确。',
    });
  } else if (thereforeHit && strongLines.length && responds === false) {
    findings.push({
      kind: 'there-ignores-but',
      msg: '结果句与冲突句的关键词重合较少；不代表二者一定无关。',
      fix: '结合上下文核对结果是否回应相关问题，不必为匹配关键词改句。',
    });
  }

  /* ④ EVER SINCE：跟今天的关系 */
  if (!EVER_SINCE.test(tailText)) {
    findings.push({
      kind: 'no-ever-since',
      msg: '结尾未识别到"今天/你身边"等词句；相关性不能仅凭关键词判定。',
      fix: '如有必要，检查影响或用途是否交代清楚，不必硬加当下关联。',
    });
  }

  /* ⑤ 结构顺序：BUT 不该出现在最后 20% 才第一次出现 */
  const firstBut = strongLines.length ? Math.min(...strongLines.map(x => x.scene)) : null;
  if (firstBut !== null && firstBut > scenes.length * 0.8) {
    findings.push({
      kind: 'late-but',
      scene: firstBut,
      msg: `符合规则的冲突句首次出现在第 ${firstBut} 场（全片 ${scenes.length} 场）；只记录位置。`,
      fix: '结合主题和论述顺序检查是否易于理解，不必按固定比例前移。',
    });
  }

  return {
    ok: findings.length === 0,
    scenes, findings,
    seg: {
      and: !!andHit,
      but: strong.length,
      butWeak: weakCount,
      therefore: thereforeHit,
      thereforeResponds: responds,
      everSince: EVER_SINCE.test(tailText),
    },
    firstBut,
  };
}

export function report(res) {
  if (res.note) return res.note;
  const y = (b) => (b ? '已识别' : '未识别');
  const lines = ['可选叙事弧形式线索（ABT + Story Spine；不适用于所有讲解）', ''];
  lines.push(`  AND   出事之前的常态     ${y(res.seg.and)}`);
  lines.push(`  BUT   真冲突（"可是…"）   ${y(res.seg.but > 0)}${res.seg.but ? `  ${res.seg.but} 处` : ''}`);
  lines.push(`  THEREFORE  结果/解法      ${y(res.seg.therefore)}${res.seg.thereforeResponds === false ? '  词面重合少（待核）' : res.seg.thereforeResponds ? '  词面有重合（待核）' : ''}`);
  lines.push(`  EVER SINCE 落到今天       ${y(res.seg.everSince)}`);
  lines.push('');
  if (!res.findings.length) {
    lines.push('未触发当前规则提示；词面特征不代表内容审阅通过。');
  } else {
    for (const f of res.findings) {
      lines.push(`· ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('参考：ABT 和 Story Spine 是可选框架；讲解可按原文主线组织，不必强加冲突。');
  lines.push('这是词面检测，不证明理解效果；--strict 仅检查这些可选结构规则。');
  return lines.join('\n');
}
