/* lib/claims.mjs —— 事实对账（vh claims）
 *
 * 背景：claims.json 里每条断言都登记了来源与口径，但**没有任何检查器读它**。
 * 于是会出现：脚本写 27%、claims 登记 73%；或 claims 登记了某条，脚本早改了。
 * 这个模块做机器能做的对账：
 *   1. 抽脚本里的"数字与量词"（27% / 3 倍 / 约两成 / 145 个项目），逐条查 claims 有没有登记
 *   2. claims 里登记了、脚本里却找不到对应数字 → 报"过期登记"
 *   3. claims 每条必须齐备 url / kind / scope（缺字段 → 报）
 * 说明：它核的是"有没有登记"，**不核"登记的对不对"**（那要人看原文）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeClaim, validateClaimEvidence } from './claim-evidence.mjs';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

export function claimsDocumentState(project) {
  const file = path.join(project, 'claims.json');
  if (!fs.existsSync(file)) return { ok: false, state: 'missing' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) || Array.isArray(data?.claims) ? { ok: true, state: 'structured' }
      : { ok: false, state: 'invalid', reason: '证据表须为数组或含 claims 数组的对象' };
  } catch { return { ok: false, state: 'incomplete', reason: 'JSON 尚未闭合或格式无效，不代表已写完' }; }
}

/* All three reconciliation directions use the same numeric token boundaries.
 * Evidence can support a registered claim, but a number occurring only in an
 * unrelated quote is not itself a registration. These are heuristics, not
 * semantic fact checking. Bare years are not quantities; a year-shaped value
 * with a unit (e.g. 2049 个) is still a quantity.
 *
 * Chinese numerals are included because Chinese narration writes quantities as
 * 「三个入口」「七八类」far more often than as digits. Before this, such a script
 * produced "0 个数字断言 · 0 处疑点": the reconciliation looked clean while
 * checking nothing at all (observed on a real project, 2026-11-05).
 *
 * Classification is heuristic in both directions, so the rule is deliberately
 * two-tiered rather than a single classifier whitelist (which silently drops
 * real counts like 「四路进攻」「三个阶段」):
 *   1. Arabic digits + any unit-ish token  -> always a quantity (unchanged).
 *   2. Chinese numeral + a character that is NOT a common numeric measure word
 *      (个/条/类/层/家/... / 元/米/秒) -> an idiom or an ordinal, skipped.
 *      This is what keeps 「一个 App」「这一期」「第一层」「十分清楚」out.
 * Both tiers were checked against ordinary 财经/医学/历史/技术 scripts, not one
 * project's wording. */
const ARABIC = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
// 十/百/千 are multipliers inside the numeral. 万/亿 stay in UNIT because
// 「三 万」and「3 万」must normalize to the same quantity.
const ZH_NUM = '[零〇一二三四五六七八九两十百千]+';
const NUMBER = `${ARABIC}|${ZH_NUM}`;

/* Units that may follow a quantity, Arabic or Chinese. Deliberately broad: a
 * missed unit means a missed reconciliation, which is the failure mode this
 * whole change exists to fix. */
const UNIT = '%|‰|℃|个百分点|百分点|倍|成|个|项|条|只|支|台|部|辆|架|艘|枚|颗|粒|间|套|副|双|对|打|群|批|堆|串|列|组|份|张|页|篇|本|册|幅|帧|段|节|章|回|轮|场|次|遍|趟|期|届|任|位|名|员|户|家|所|校|院|店|铺|厂|种|样|类|级|别|层|等|步骤|步|点|线|面|块|片|团|把|根|枝|杆|座|栋|幢|楼层|门|窗|格|档|栏|行|排|系列|款|型|号码|路|阶段|维度|层面|环节|方面|部位|层次|梯队|组别|档位|天地|毫秒|字节|字|克|吨|升|度|岁|元|块|角|米|厘|平|方|公里|斤|公斤|亩|万|亿|千|百|十|GB|MB|KB|token|分钟|小时|天|秒|月|日';

// A comma following text can separate quantities (3个,4个); a comma after a
// digit must not let a malformed or partial grouped number match its suffix.
const numberBoundary = '(?<![0-9A-Za-z_.])(?<![0-9],)';
const RANGE_SEP = '\\s*(?:到|至|~|—|–|-)\\s*';

const ARABIC_RE = /^\d/;
const ZH_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_MULT = { 十: 10, 百: 100, 千: 1000 };

/* 「二十三」→23、「一百零五」→105、「十」→10。
 * Returns null for forms this parser cannot read, so callers can skip rather
 * than silently invent a value. */
function zhToNumber(text) {
  let section = 0, digit = null, sawAny = false;
  for (const ch of text) {
    if (ch in ZH_DIGITS) { digit = ZH_DIGITS[ch]; sawAny = true; }
    else if (ch in ZH_MULT) {
      section += (digit === null ? 1 : digit) * ZH_MULT[ch];
      digit = null; sawAny = true;
    } else return null;
  }
  if (digit !== null) section += digit;
  return sawAny ? section : null;
}

/* 「七八」「三五」are deliberately vague ranges ("seven or eight"), not 78/35.
 * Normalize to "7-8" so a claim quoting the same phrase matches. */
function zhPairAsRange(text) {
  const chars = [...text];
  if (chars.length !== 2 || !chars.every(c => c in ZH_DIGITS)) return null;
  const [a, b] = chars.map(c => ZH_DIGITS[c]);
  if (!(a > 0 && b > 0) || b <= a) return null;
  return `${a}-${b}`;
}

/* Canonical comparison key. Arabic and Chinese forms of the same quantity must
 * produce the same key, otherwise registration checks never line up. */
const numberKey = value => {
  const raw = String(value).replace(/,/g, '').trim();
  if (ARABIC_RE.test(raw)) {
    const [whole, fraction = ''] = raw.split('.');
    const integer = whole.replace(/^0+(?=\d)/, ''), decimal = fraction.replace(/0+$/, '');
    return decimal ? integer + '.' + decimal : integer;
  }
  const pair = zhPairAsRange(raw);
  if (pair) return pair;
  const n = zhToNumber(raw);
  return n === null ? raw : String(n);
};

const numberPattern = () => new RegExp(`${numberBoundary}(${NUMBER})(?![0-9])`, 'g');
const rangeQuantityPattern = () =>
  new RegExp(`${numberBoundary}(?:约|近|超过|不足)?\\s*(${NUMBER})${RANGE_SEP}(${NUMBER})\\s*(${UNIT})(?![A-Za-z0-9_])`, 'g');
const quantityPattern = () =>
  new RegExp(`${numberBoundary}(?:约|近|超过|不足)?\\s*(${NUMBER})\\s*(${UNIT})(?![A-Za-z0-9_])`, 'g');

const mentionedNumbers = text => [...String(text).matchAll(numberPattern())];

/* Quantities WITH a unit, including explicit ranges like「三到五个」.
 * `value` keeps the surface form for reports; `key` is the canonical form for
 * comparison, so Arabic and Chinese spellings of one quantity line up.
 *
 * Only an ORDINAL (第X层/第X步) or a bare multiplier that is part of a name
 * (百日千万) is skipped for Chinese numerals. Everything else with a real unit
 * counts, because Chinese classifiers are an open set: a whitelist silently
 * dropped 「四路进攻」「三个阶段」「五步流程」 in testing, which is the same class of
 * failure as the original "0 个数字断言". */
const isOrdinal = (source, index) => /[第]/.test(source.slice(Math.max(0, index - 1), index));
/* 「这一期」: the character BEFORE the numeral already makes it a demonstrative
 * («this one»), not a count. Same for 「那两件事」. */
const isDemonstrative = (source, index) => /[这那]/.test(source.slice(Math.max(0, index - 1), index));
const BARE_MULTIPLIER = new Set(['百', '千', '万', '亿']);
/* 「一模一样」「一些」: the character after the numeral is a fixed-expression
 * particle, not a classifier. These are the only Chinese forms needing a veto;
 * real classifiers are open-ended (路/阶段/维度/层次/步 …), so this stays a short
 * deny-list instead of a whitelist that would silently drop real counts. */
const ZH_FIXED_TAIL = new Set(['样', '些', '点儿', '旦']);

const chineseQuantityRejected = (source, index, numeral, unit) => {
  if (ARABIC_RE.test(numeral)) return false;
  if (BARE_MULTIPLIER.has(numeral)) return true;
  if (isOrdinal(source, index) || isDemonstrative(source, index)) return true;
  return ZH_FIXED_TAIL.has(unit);
};

const quantities = text => {
  const source = String(text), out = [], taken = [];
  const overlaps = (start, end) => taken.some(([s, e]) => start < e && end > s);
  for (const m of source.matchAll(rangeQuantityPattern())) {
    const a = numberKey(m[1]), b = numberKey(m[2]);
    if (!/^\d/.test(a) || !/^\d/.test(b)) continue;
    if (chineseQuantityRejected(source, m.index, m[1], m[3]) || chineseQuantityRejected(source, m.index, m[2], m[3])) continue;
    taken.push([m.index, m.index + m[0].length]);
    out.push({ key: `${a}-${b}`, value: `${m[1]}-${m[2]}`, raw: m[0].trim(), unit: m[3] });
  }
  for (const m of source.matchAll(quantityPattern())) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    if (chineseQuantityRejected(source, m.index, m[1], m[2])) continue;
    out.push({ key: numberKey(m[1]), value: m[1], raw: m[0].trim(), unit: m[2] });
  }
  return out;
};


/* 从脚本抽"断言里的量"：百分比、倍数、成、百分点、带单位的数 */
export function extractNumbers(script) {
  const out = [];
  const lines = script.split('\n');
  let scene = 0;
  for (const raw of lines) {
    const h = raw.match(/^##\s*S(\d+)/);
    if (h) { scene = +h[1]; continue; }
    const m = raw.match(/^\s*\d+[.、)]\s*(.+)$/);
    if (!m) continue;
    const line = m[1];
    // 只看有量词的数字；裸年份、坐标和序号本来就不会被匹配。
    for (const q of quantities(line)) {
      out.push({ scene, value: q.value, key: q.key, raw: q.raw, unit: q.unit, context: line.slice(0, 60) });
    }
  }
  // 去重（同场同值同量词）
  const seen = new Set();
  return out.filter(x => { const k = x.scene + '|' + x.raw; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function analyze(project) {
  const script = read(path.join(project, '脚本.md'));
  const claimsRaw = read(path.join(project, 'claims.json'));
  const findings = [];
  const blocks = [];

  if (!script) return { findings, numbers: [], claims: [], blocks, ok: true, note: '没有 脚本.md' };
  const numbers = extractNumbers(script);

  let claims = [];
  if (!claimsRaw) {
    if (numbers.length) findings.push({ kind: 'missing-file', msg: `脚本里有 ${numbers.length} 个数字断言，但还没有 claims.json` });
    return { findings, numbers, claims, blocks, ok: findings.length === 0 };
  }
  try {
    const j = JSON.parse(claimsRaw);
    claims = Array.isArray(j) ? j : j?.claims;
    if (!Array.isArray(claims)) throw new Error('须为数组或含 claims 数组的对象');
  } catch (e) {
    findings.push({ kind: 'bad-json', msg: 'claims.json 不是合法 JSON：' + e.message.split('\n')[0] });
    return { findings, numbers, claims, blocks, ok: false };
  }

  // ① 两种既有字段统一对账；作者建议/计算用真实本地材料，不要求伪造 URL。
  const provenance = validateClaimEvidence(project, claims);
  findings.push(...provenance.findings);
  claims = provenance.claims;
  for (const c of claims) {
    // 允许"待核"：kind 里含"待核"或 url 里含"待补"不算缺
    if (c.url && /待补|待核/.test(c.url) && !/待核/.test(c.kind || '')) {
      findings.push({ kind: 'claim-pending', msg: `claims ${c.id || '?'} 的来源仍是「待补」，但 kind 没标待核` });
    }
  }

  // ② 脚本里的数字 → 有没有 claims 登记
  // Registration matches on the canonical key, so 「三个入口」in the script is
  // satisfied by 「3 个入口」or 「三个入口」in the claim alike. Quantity keys
  // (e.g. the range 3-5 from 「三到五个」) count as registration too, otherwise a
  // range written in Chinese can never match the same range written in digits.
  const claimText = claims.map(c => [c.assertion, c.scriptLine].filter(Boolean).join(' ')).join('\n');
  const registeredNumbers = new Set([
    ...[...mentionedNumbers(claimText)].map(m => numberKey(m[1])),
    ...quantities(claimText).map(q => q.key),
  ]);
  for (const n of numbers) {
    // 整个数字须出现在断言或 scriptLine，不能用 300 命中 3 或用摘录代替登记。
    if (!registeredNumbers.has(n.key)) {
      findings.push({ kind: 'unclaimed', msg: `第 ${n.scene} 场「${n.raw}」在 claims.json 里找不到登记（${n.context}…）`, number: n.raw, scene: n.scene });
    }
  }

  // ③ claims 登记了、脚本里却没这个数字 → 可能过期
  const scriptedKeys = new Set(numbers.map(n => n.key));
  for (const c of claims) {
    const nums = quantities(String(c.assertion || '') + ' ' + String(c.scriptLine || ''));
    for (const q of nums) {
      if (!scriptedKeys.has(q.key)) {
        findings.push({ kind: 'stale-claim', msg: `claims ${c.id || '?'} 里的「${q.raw}」在脚本中找不到 —— 可能改稿后没同步` });
      }
    }
  }

  // ④ 广告场专项：广告场必须在 claims 里有登记（否则就是没核）
  const adScenes = [];
  {
    let scene = 0;
    for (const raw of script.split('\n')) {
      const h = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
      if (h) { scene = +h[1]; if (/广告/.test(h[2] || '')) adScenes.push(scene); }
    }
  }
  // 广告场里出现的域名/链接（用来核对 claims 有没有真的登记它）
  const adText = (() => {
    const blocks = script.split(/^##\s*/m);
    return blocks.filter(b => /^S(\d+)\s*[·•\-—]?\s*广告/.test(b)).join('\n');
  })();
  const adUrls = [...adText.matchAll(/[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s，。；、「」）)]*)?/gi)]
    .map(m => m[0].replace(/[.,;:]+$/, ''))
    .filter(u => !/^(例如|比如)/.test(u));
  for (const n of adScenes) {
    // 命中条件（三者之一）：① 条目里写了 `"scene": n`  ② 条目 url 命中广告里的域名  ③ 条目 kind 明确写"广告"
    const hit = claims.some(c => {
      if (c.scene != null && +c.scene === n) return true;
      const url = String(c.url || '');
      if (url && adUrls.some(d => url.includes(d.replace(/^https?:\/\//, '').split('/')[0]))) return true;
      if (/^广告/.test(String(c.kind || ''))) return true;
      return false;
    });
    if (!hit) {
      findings.push({ kind: 'ad-unverified',
        msg: `第 ${n} 场是广告，但 claims.json 里没有对应登记 —— 无法证明它核对过用户给的链接`,
        scene: n });
    }
  }

  // ⑤ 编造检测（只查"能查的"，不硬比中文与英文）
  //    教训：来源常是英文原文、脚本是中文，逐词比对必然全不匹配（第一版就误报了 14 条）。
  //    现在只查两件确定的事：
  //      ① 英文专有名词/术语（≥3 字母）在脚本里出现、但来源摘录里没有 → 可疑
  //      ② 数字出现在脚本但既不在来源也不在其它 claims 里 → 该条最可疑（已有 unclaimed 覆盖，这里只查本条）
  for (const c of claims) {
    const url = String(c.url || '');
    if (/待核/.test(String(c.kind || '')) || /待补|待核/.test(url)) continue;
    const quote = (Array.isArray(c.evidence)
      ? c.evidence.map(e => String(e.quote || '')).join(' ')
      : String(c.evidence || ''));
    const line = String(c.scriptLine || c.assertion || c.statement || '');
    if (!quote.trim() || !line.trim()) continue;

    // ① 英文术语：脚本里出现的拉丁词，来源里找不到 → 可疑
    // 来源名/品牌名不算"编造"（来源摘录里通常不会重复自己的刊名）
    const EN_STOP = new Set(['ChatGPT', 'OpenAI', 'Plus', 'Pro', 'AI', 'API', 'Web', 'ORM', 'SQL',
      'HTML', 'CSS', 'JS', 'TS', 'Stack', 'Overflow', 'GitHub', 'Google', 'Microsoft',
      'Python', 'Django', 'FastAPI', 'JavaScript', 'TypeScript']);
    const enWords = [...new Set((line.match(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g) || []))]
      .filter(w => !EN_STOP.has(w))
      .filter(w => !/[./]/.test(w))                        // 域名/路径/文件
      .filter(w => !/^[A-Z0-9]{6,}$/.test(w));             // 邀请码这类全大写短码
    const missingEn = enWords.filter(w => !quote.toLowerCase().includes(w.toLowerCase()));
    if (enWords.length >= 2 && missingEn.length === enWords.length) {
      findings.push({ kind: 'unsupported',
        msg: `claims ${c.id || '?'}：脚本里的英文术语（${missingEn.slice(0, 4).join('、')}）在来源摘录里都找不到 —— 可能编造`,
        scene: c.scene });
    }

    // ② 本条自己的数字，在来源里找不到 → 来源可能记错（不与其他 claims 比）
    const nums = mentionedNumbers(line).filter(m => !/^(19|20)\d{2}$/.test(m[1]) ||
      new RegExp(`^\\s*(?:${UNIT})(?![A-Za-z0-9_])`).test(line.slice(m.index + m[0].length)));
    const quotedNumbers = new Set(mentionedNumbers(quote).map(m => numberKey(m[1])));
    const missingNum = nums.map(m => m[1]).filter(n => !quotedNumbers.has(numberKey(n)));
    if (nums.length >= 2 && missingNum.length === nums.length) {
      findings.push({ kind: 'unsupported-number',
        msg: `claims ${c.id || '?'}：脚本里的数字（${missingNum.slice(0, 4).join('、')}）在来源摘录里都找不到 —— 来源与脚本对不上`,
        scene: c.scene });
    }
  }

  // ⑥ 广告场：只做可靠的两件事（语义比对试过 5 轮，误报率高，已放弃）
  //    ① 必须有 kind 以「广告」开头的 claims（证明做过来源登记）
  //    ② 该 claims 必须有 url + evidence.quote（证明真抓过页面，而不是凭印象）
  //    ③ 广告场的每句都要在 claims 的 scriptLine 里出现（逐句可追）
  const adClaims = claims.filter(c => /^广告/.test(String(c.kind || '')));
  if (adScenes.length && !adClaims.length) {
    findings.push({ kind: 'ad-no-claim', msg: `有 ${adScenes.length} 个广告场，但没有 kind 为「广告」的 claims 条目` });
  }
  for (const c of adClaims) {
    if (!c.url) findings.push({ kind: 'ad-no-url', msg: `广告 claims ${c.id || '?'} 缺 url —— 无法证明核对过链接` });
    const hasQuote = Array.isArray(c.evidence) && c.evidence.some(e => String(e.quote || '').trim().length >= 10);
    if (!hasQuote) findings.push({ kind: 'ad-no-quote', msg: `广告 claims ${c.id || '?'} 缺原文摘录（evidence.quote）—— 无法证明不是编的` });
  }
  // 逐句可追：广告场每句的"前 8 个字"必须出现在某条广告 claims 的 scriptLine/assertion 里
  for (const n of adScenes) {
    const block = script.split(/^##\s*/m).find(b => new RegExp('^S' + n + '\\s*[·•\\-—]?\\s*广告').test(b));
    if (!block) continue;
    const text = adClaims.map(c => String(c.scriptLine || '') + String(c.assertion || '')).join('')
      .replace(/[\s*「」“”'\"（）()，。；、！？：:—\-]/g, '');
    const lines = block.split('\n').filter(l => /^\s*\d+[.、)]\s+/.test(l)).map(l => l.replace(/^\s*\d+[.、)]\s*/, '').trim());
    for (const line of lines) {
      if (/^(最后|首先|这段|这是|本节|本条).{0,6}广告/.test(line)) continue;
      if (/(可以跳过|不依赖|跟前面|与前面|没有关系|不影响)/.test(line)) continue;
      const head = line.replace(/[\s*「」“”'\"（）()，。；、！？：:—\-]/g, '').slice(0, 8);
      if (head.length >= 6 && !text.includes(head)) {
        findings.push({ kind: 'ad-untracked',
          msg: `第 ${n} 场广告：这句没写进广告 claims 的 scriptLine →「${line.slice(0, 30)}…」`,
          scene: n });
      }
    }
  }

  return { findings, numbers, claims, blocks, adScenes, warnings: provenance.warnings, ok: findings.length === 0 };
}

/* 人看的对照表：每条 claims 的断言 + 原文摘录并排 */
export function reviewTable(claims) {
  const lines = ['# 事实核对表（人看）', '',
    '> 机器只查"有没有登记"，下面是**断言 vs 原文摘录**并排，扫一遍就知道有没有写歪。', ''];
  for (const raw of claims) {
    const c = normalizeClaim(raw);
    const q = Array.isArray(c.evidence) ? (c.evidence[0]?.quote || '') : String(c.evidence || '');
    lines.push(`## ${c.id || '?'}${c.scene ? '（第 ' + c.scene + ' 场）' : ''}`);
    lines.push('');
    lines.push('**脚本说的**：' + String(c.scriptLine || c.assertion || '（未填）').slice(0, 200));
    lines.push('');
    lines.push('**来源原文**：' + (q ? String(q).slice(0, 300) : '（无摘录）'));
    lines.push('');
    lines.push(`来源：${c.evidence[0]?.path || c.url || '（无）'}　类型：${c.kind || '（无）'}　核证状态：${c.status || '未登记'}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function report(res) {
  if (res.note) return '事实对账：' + res.note;
  const lines = [`事实对账：脚本 ${res.numbers.length} 个数字断言 · claims ${res.claims.length} 条 · ${res.findings.length} 处疑点`];
  for (const warning of res.warnings || []) lines.push('  待核：' + warning.msg);
  if (!res.findings.length) {
    lines.push('  ✓ 识别出的数量在登记的断言或脚本文字中有相同数值；带单位登记未发现过期');
  } else {
    for (const f of res.findings.slice(0, 15)) lines.push(`  · [${f.kind}] ${f.msg}`);
    if (res.findings.length > 15) lines.push(`  …（还有 ${res.findings.length - 15} 处）`);
    lines.push('');
  }
  lines.push('  注意：仅检查可识别的阿拉伯数字及量词和登记情况；相同数值可能来自不同断言或单位。不证明事实为真或来源支持断言，仍需核对原文。');
  return lines.join('\n');
}
