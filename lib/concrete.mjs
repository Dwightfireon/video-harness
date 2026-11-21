/* lib/concrete.mjs —— 体感数字检查（vh concrete）
 *
 * 为什么需要：3060 次、16000 次、10000 次 —— 这些数字读者记不住，因为没有"体感"。
 * 观众能记住的是"每天飞 3 班、飞 3 年"这种。
 *
 * 判据：
 *   1. 每个大数字（≥100 或"万/倍"）附近，有没有一个换算/类比
 *   2. 换算必须是观众能想象的东西（天/年/人/次/倍/相当于/也就是）
 *   3. 不允许"约 XX 次"这种同义反复（还是次数，没换成体感）
 *
 * 这是内容层唯一能机械判的"是否好懂"指标。
 */
import fs from 'node:fs';
import path from 'node:path';

/* 中文数字 → 数值（与 skill 的 check-script 同口径，避免两套解析） */
const ZH_D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_U = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
export function zh2num(s) {
  let tot = 0, sc = 0, cur = 0;
  for (const ch of String(s)) {
    if (ZH_D[ch] !== undefined) cur = ZH_D[ch];
    else if (ZH_U[ch] !== undefined) {
      const un = ZH_U[ch];
      if (un >= 10000) { sc = (sc + cur) * un; tot += sc; sc = 0; cur = 0; }
      else { if (cur === 0) cur = 1; sc += cur * un; cur = 0; }
    }
  }
  return tot + sc + cur;
}

/* 大数字：阿拉伯数 ≥100，或中文数 ≥100，或带万/亿/倍。
   ⚠ 真实误报：全片写的是"三千零六十次""八百公里"，只匹配 \d 会一个都扫不到 —— 
   那就等于这个检查器从没工作过。 */
const BIG = /(\d{2,}(?:\.\d+)?|[零一二三四五六七八九十百千两]{1,8})\s*(万|亿|倍|次|小时|天|年|人|架|米|公里|吨)?/g;

/* 换算标志：把抽象量换成可感知量 */
/* 换算必须**落到另一个单位**（天/年/月/人/倍/一生…），
   不能只是"换句话说"这种转述词 —— 真实误报：
   "换句话说，问题不在一次用力过猛" 被算成换算，其实没换任何单位。 */
/* 换算的合法形式：
   ① 换成另一个**时间/数量单位**（天/年/小时/人/倍/班…）
   ② 换成**一个具体可想象的物体**（游泳池 / 埃菲尔铁塔 / 足球场…）
      真实漏报：「相当于三个埃菲尔铁塔叠起来的高度」是标准的好换算，但旧单位表里只有时间单位。
   ③ 用"相当于/也就是/等于"引出，后面必须跟着一个**名词性对象**（不是空话）。 */
const CONCRETE = new RegExp(
  '(相当于|也就是|等于|差不多是)[^。]{0,24}(' +
    // ① 时间/数量单位
    '天|年|月|小时|分钟|人|倍|趟|架|班|圈|层|个' +
    // ② 具体物体
    '|游泳池|足球场|埃菲尔铁塔|篮球场|双人床|冰箱|电梯|教室|地铁|公交|一层楼|飞机|汽车' +
  ')' +
  '|每天[^。]{0,10}(飞|跑|开|用)|每年[^。]{0,10}(飞|跑|开|用)|一生[^。]{0,10}(飞|跑|用)|一年[^。]{0,8}(飞|跑)|一天[^。]{0,8}(飞|跑|班)|打个比方'
);

/* "约 XX 次"这种不算换算：还是原单位 */
const FAKE = /(大约|约|近|超过)\s*\d+\s*(次|小时|天|年|米)\s*$/;

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
  if (!md) return { ok: true, nums: [], findings: [], note: '没有 脚本.md' };
  const scenes = parseScenes(md);

  const nums = [];
  for (const sc of scenes) {
    sc.lines.forEach((l, idx) => {
      for (const m of l.matchAll(BIG)) {
        const raw = m[1];
        const v = /^\d/.test(raw) ? +raw : zh2num(raw);
        const unit = m[2] || '';
        /* 只关心"大"的：≥100，或带万/亿/倍 */
        const isBig = v >= 100 || /万|亿|倍/.test(unit);
        if (!isBig) continue;
        /* 年份不算（1954 / 一九五四 这种是标识，不是量） */
        if (/^(19|20)\d{2}$/.test(raw) && !unit) continue;
        if (/^[零一二三四五六七八九十]{2,4}$/.test(raw) && !unit && /(一九|二〇|二零)/.test(l)) continue;
        nums.push({ scene: sc.n, line: l, value: (raw.length > 6 ? String(v) : raw) + unit, numeric: v, idx });
      }
    });
  }

  const findings = [];
  const byScene = {};        // 场号 → 未换算的关键数字
  const seen = new Set();
  for (const n of nums) {
    const key = n.scene + ':' + n.value;
    if (seen.has(key)) continue;
    seen.add(key);

    /* 换算的判定范围：**整场**（不只是相邻两句）。
       真实误报：S6 第 1 句说"一万次"，第 4 句才换算"每天飞三班、飞十四年" ——
       按"相邻 3 句"判会漏掉，而那一场其实换算得很好。
       一场里只要有一处真换算，就算这一场把量级讲清了。 */
    const sc = scenes.find(s => s.n === n.scene);
    const near = sc.lines.join(' ');
    const hasConcrete = CONCRETE.test(near) && !FAKE.test(near);
    n.concrete = hasConcrete;
    if (!hasConcrete) {
      /* 只收"关键数字"：≥1000、或带万/亿/倍。之后按场合并成一条 ——
         19 条警告等于没有警告（真实教训）。 */
      const val = n.numeric || 0;
      if (val >= 1000 || /万|亿|倍/.test(n.value)) {
        (byScene[n.scene] = byScene[n.scene] || []).push(n.value);
      }
    }
  }

  /* 按场合并：每场最多一条 */
  for (const [scene, vals] of Object.entries(byScene)) {
    const uniq = [...new Set(vals)];
    findings.push({
      kind: 'abstract',
      scene: +scene,
      msg: `第 ${scene} 场有 ${uniq.length} 个关键数字没换算：${uniq.slice(0, 4).join('、')}${uniq.length > 4 ? '…' : ''} —— 观众记不住量级`,
      fix: '挑最重要的 1–2 个换算成"相当于…"（例如 3060 次 ≈ 每天飞 3 班、飞 3 年），其余保留精确值。',
    });
  }

  /* 全片一个换算都没有 → 说明整片是"数据通稿"，不是"讲人话" */
  const anyConcrete = nums.some(n => n.concrete);
  if (nums.length >= 3 && !anyConcrete) {
    findings.push({
      kind: 'no-conversion',
      msg: `全片 ${nums.length} 个大数字，一个都没换算成可感知的量`,
      fix: '挑 2–3 个最关键的换算：「相当于每天飞 3 班、飞 3 年」，其余保留精确值即可。',
    });
  }

  return { ok: findings.length === 0, nums, findings, bigCount: nums.length, concreteCount: nums.filter(n => n.concrete).length };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['体感数字（大数字换算成能想象的东西）', ''];
  lines.push(`  大数字 ${res.bigCount} 个，其中 ${res.concreteCount} 个有换算`);
  lines.push('');
  if (res.nums.length) {
    lines.push('  场次  数值        有换算  原句');
    const seen = new Set();
    for (const n of res.nums) {
      const k = n.scene + ':' + n.value;
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(`  S${String(n.scene).padStart(2)}   ${String(n.value).padEnd(10)} ${n.concrete ? '  ✓  ' : '  ·  '}  ${String(n.line).slice(0, 34)}`);
    }
  }
  lines.push('');
  if (!res.findings.length) {
    lines.push('✓ 关键数字都有体感换算');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('口径：换算是"相当于/也就是/每天/一生"这类把抽象量落到可感知经验的表达；');
  lines.push('      "约 3000 次"不算换算（还是次数，没换单位）。');
  return lines.join('\n');
}
