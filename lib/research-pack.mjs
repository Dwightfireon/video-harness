/* 调研正文 → 写作者可用的逐字摘录包。
 *
 * 背景（真实审计，2026-11-12）：选题发现阶段已经把原文全文落盘
 * （out/topic-research/<batch>.json 的 pages[].body，单篇 8–29KB），
 * 但传给制作层的只有题目、看点、建议讲法和每条来源 1 个 quote。
 * 结果：材料里现成的机制、实验条件、限定，一条都没进稿；
 * 三份已交付成片里，机制句比例 0–10%，而材料本身完全够用。
 *
 * 这一层只做三件事，且都可验证：
 *   1. 从原文里挑出「句子本身带机制/条件/数字/限定」的段落；
 *   2. 逐字截取，不改写、不总结、不推断（保真优先于好看）；
 *   3. 标出来源 URL 与取舍说明，让写作者知道这是原文还是编辑判断。
 *
 * 它不做：判断哪条更重要、替作者写结论、核证事实是否支持断言。
 * 机器只能确定「这段原文里确实有这些字」，不能确定「这段能支撑那个结论」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* 单条上限：一条摘录超过这个长度就没有「可扫读」的意义了。 */
const PARA_MAX = 1100;
/* 太短的段落多是导航、按钮、标题碎片，直接丢。 */
const PARA_MIN = 90;
/* 默认总量上限（字符）。约等于 1 页 A4，写作者能真读进去。 */
export const DEFAULT_PACK_CHARS = 7000;

const MECHANISM = /(because|therefore|thus|hence|so that|leads? to|results? in|causes?|mechanism|why|the reason|driven by|due to|in turn|only when|unless|provided that|conditional|we find|we show|we measure|we observe|we estimate|suggests? that|implies? that|explains?)/i;
const LIMIT = /(limitation|we only|only tested|our sample|sample size|n\s*=|confidence interval|95%|caveat|do(?:es)? not|cannot|not evidence|not proof|doesn't mean|unclear|unknown|remains|generaliz\w*|err on|caveat)/i;
const NUMBERED = /(\d+(?:[.,]\d+)?\s?(?:%|％|hours?|minutes?|seconds?|days?|models?|models|tokens?|x\b|times|parameters?|B\b|K\b|M\b|percent|percentage points?|examples?|tasks?|users?|apps?))|(百分之[零〇一二三四五六七八九十百千两]+)|(\d+\s*倍)|(\d{4}年)/i;
const ABSTRACT = /(^#+\s*)?(abstract|summary|tl;?dr|in short|key findings?|findings|results?|what we found|overview|摘要|结论|主要发现)/i;
const ZH_MECHANISM = /(因为|所以|因此|导致|从而|机制|原因|原理|条件|只有当|除非|说明|意味着|抽样|样本|置信区间|无法|不能|不等于|限制|假设)/;
const ZH_NUMBER = /([零〇一二三四五六七八九十百千两\d]+(?:个|项|条|倍|%|％|小时|分钟|秒|天|年|款|家|人|次|轮|亿|万))/;
const NOISE = /(skip to content|sign in|log in|cookie|subscribe|newsletter|all rights reserved|privacy policy|terms of service|分享|登录|注册|订阅|版权|广告|上一篇|下一篇|相关阅读|返回顶部|导航)/i;

/* 段落切分：空行优先；没有空行的（HTML 清洗后的长文）退到句末标点。 */
function paragraphs(body) {
  const byBlank = String(body || '').split(/\n[ \t\r]*\n/);
  const out = [];
  for (const block of byBlank) {
    const clean = block.trim();
    if (!clean) continue;
    if (clean.length <= PARA_MAX * 1.4) { out.push(clean); continue; }
    /* 超长块按句子切开，保留原句边界。 */
    // Slice at sentence ends, never at a decimal point or an arbitrary numeric prefix.
    const sentences = clean.match(/[\s\S]*?[。！？.!?](?=\s|$)|[\s\S]+$/g) || [clean];
    let buf = '';
    for (const sentence of sentences) {
      if ((buf + sentence).length > PARA_MAX && buf) { out.push(buf); buf = ''; }
      buf += sentence;
    }
    if (buf) out.push(buf);
  }
  return out;
}

/* 导航/目录段的特征：链接密度高、单行短句多、没有句末标点。
 * 分享按钮/分页条/tag 列表是真实事故现场：它们含 URL 与「utm_」，会骗过关键词打分，
 * 又被写作者当成正文读，所以这里单独拦一遍。 */
function looksLikeChrome(text) {
  if (NOISE.test(text) && text.length < 400) return true;
  if (/(utm_|twitter\.com\/intent|linkedin\.com\/share|facebook\.com\/sharer|reddit\.com\/submit|%23|%2F)/i.test(text)) return true;
  const links = (text.match(/\]\(|https?:\/\//g) || []).length;
  if (links >= 2 && text.length < 900) return true;
  /* 列表项连成一段（- [ …] / * [ …]）：是目录，不是叙述。 */
  const listLines = text.split('\n').filter(line => /^\s*[-*|]\s/.test(line)).length;
  if (listLines >= 2) return true;
  const punctuation = (text.match(/[。.!?！？；;]/g) || []).length;
  if (text.length > 200 && punctuation === 0 && links > 0) return true;
  return false;
}

function score(text, { heading = '' } = {}) {
  let value = 0;
  if (MECHANISM.test(text) || ZH_MECHANISM.test(text)) value += 3;
  if (NUMBERED.test(text) || ZH_NUMBER.test(text)) value += 2;
  if (LIMIT.test(text)) value += 2;
  if (ABSTRACT.test(heading)) value += 2;
  /* 有从句、有具体主体的段落比口号段更可能承载解释。 */
  if ((text.match(/[。.!?！？]/g) || []).length >= 2) value += 1;
  if (text.length < 140) value -= 2;
  return value;
}

/* 保留最近的小标题，用来判断「这段在 abstract 里还是导航里」。 */
function * blocksWithHeading(body) {
  let heading = '';
  const lines = String(body || '').split('\n');
  let buffer = [];
  for (const line of lines) {
    const h = /^#{1,4}\s+(.{2,120})$/.exec(line.trim());
    if (h) {
      if (buffer.join('\n').trim()) yield { heading, text: buffer.join('\n') };
      buffer = [];
      heading = h[1];
      continue;
    }
    if (!line.trim()) {
      if (buffer.join('\n').trim()) { yield { heading, text: buffer.join('\n') }; buffer = []; }
      continue;
    }
    buffer.push(line);
  }
  if (buffer.join('\n').trim()) yield { heading, text: buffer.join('\n') };
}

// Do not infer rendering duplicates. "77" is indistinguishable from two rendered
// sevens; LaTeX commands may carry numbers, minus signs, or logical conditions.
// Direct quotes keep those bytes. Any explanation/normalization belongs outside them.

const squash = value => String(value).replace(/\s+/g, ' ').trim();

/* 逐字截取：只在句子边界收口，绝不改写原文用词。 */
function verbatim(text) {
  const clean = text.trim();
  if (clean.includes('\0')) return null;
  if (clean.length <= PARA_MAX) return clean;
  const ends = [...clean.matchAll(/[。！？.!?](?=\s|$)/g)].filter(m => m.index < PARA_MAX);
  const boundary = ends.at(-1)?.index;
  // No safe sentence boundary: omit, rather than fabricate a truncated number/formula.
  return boundary == null ? null : clean.slice(0, boundary + 1);
}

/* 记录文件必须落在工作台根目录内：与 reference-sources 同一条边界。 */
function insideRoot(root, target) {
  let real, base;
  try { base = fs.realpathSync(root); } catch { return null; }
  try { real = fs.realpathSync(path.resolve(root, target)); } catch { return null; }
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  return real;
}

/**
 * 从调研记录里取逐字摘录。
 * @returns {{available:boolean, reason?:string, pages:number, items:Array, dropped:number, chars:number}}
 */
export function researchPack(root, recordPath, { maxChars = DEFAULT_PACK_CHARS } = {}) {
  const empty = (reason) => ({ available: false, reason, pages: 0, items: [], dropped: 0, chars: 0 });
  if (!recordPath || typeof recordPath !== 'string') return empty('选题没有保存调研正文记录');
  if (!Number.isFinite(maxChars) || maxChars < 800) throw new Error('摘录预算必须是 ≥800 的有限数');
  const file = insideRoot(root, recordPath);
  if (!file) return empty('调研记录不在工作台目录内，未读取');
  let data;
  let recordBytes;
  try { recordBytes = fs.readFileSync(file); data = JSON.parse(recordBytes.toString('utf8')); }
  catch (error) { return empty('调研记录无法解析：' + (error.code || 'JSON')); }
  const pages = Array.isArray(data?.pages) ? data.pages.map((page, pageIndex) => ({ page, pageIndex }))
    .filter(({ page }) => page && typeof page.body === 'string' && page.body.length > 200) : [];
  if (!pages.length) return empty('调研记录里没有可读到的原文正文（只有搜索摘要不算原文）');
  const candidates = [];
  let omitted = 0;
  const hash = value => createHash('sha256').update(value).digest('hex');
  const recordSha256 = hash(recordBytes);
  for (const { page, pageIndex } of pages) {
    const bodySha256 = hash(page.body);
    let index = 0;
    for (const block of blocksWithHeading(page.body)) {
      for (const para of paragraphs(block.text)) {
        if (para.length < PARA_MIN) continue;
        if (looksLikeChrome(para)) continue;
        const value = score(para, { heading: block.heading });
        if (value < 3) continue;
        const text = verbatim(para);
        const start = text == null ? -1 : page.body.indexOf(text);
        if (start < 0) { omitted++; continue; }
        candidates.push({ url: page.url, heading: block.heading, text, value, index: index++,
          source: { recordPath, recordSha256, pageIndex,
            bodySha256, start, end: start + text.length } });
      }
    }
  }
  if (!candidates.length) return empty(omitted ? '候选无法安全逐字提取，已跳过，未输出清洗或截断后的引文' : '原文里没有检出机制/条件/数字类段落（可能是纯导航页）');

  /* 每篇先保底 1 条，再按分值轮流取，避免被单一长文吃满预算。
   * 注意：同一段落可能在多篇正文里出现（同一论文的 HTML 与 PDF 版本），
   * 去重键用「归一化后的前 80 字」，不足 80 字的短段直接用它本身。 */
  const byPage = new Map();
  for (const item of candidates) {
    if (!byPage.has(item.url)) byPage.set(item.url, []);
    byPage.get(item.url).push(item);
  }
  for (const list of byPage.values()) list.sort((a, b) => b.value - a.value || a.index - b.index);
  const picked = [], seen = new Set();
  const accept = item => {
    const key = squash(item.text).slice(0, 80).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); picked.push(item); return true;
  };
  for (const list of byPage.values()) if (list.length) accept(list[0]);
  let round = 1, added = true;
  while (added) {
    added = false;
    const ordered = [...byPage.values()].map(list => list[round]).filter(Boolean)
      .sort((a, b) => b.value - a.value);
    for (const item of ordered) if (accept(item)) added = true;
    round++;
  }

  const items = [];
  let chars = 0;
  for (const item of picked) {
    if (chars + item.text.length > maxChars && items.length) break;
    items.push({ url: item.url, heading: item.heading || '', text: item.text, source: item.source });
    chars += item.text.length;
  }
  return { available: true, pages: pages.length, items, dropped: picked.length - items.length, omitted, chars };
}

/** 把摘录包渲染成给写作者的一段文字。空包返回空串，调用方据此保持原行为。 */
export function formatResearchPack(pack, { caveats = [] } = {}) {
  if (!pack || !pack.available || !pack.items.length) return '';
  const lines = [];
  lines.push(`原文逐字摘录（${pack.items.length} 条，来自 ${pack.pages} 篇已抓取正文，共 ${pack.chars} 字符）`);
  lines.push('这些是从调研记录里按「含机制 / 条件 / 数字 / 限定」逐字截取的原文片段，没有改写也没有总结；保留原始空白、排版残留和公式，不自动折叠疑似重复数字。');
  lines.push('读它们的目的：看清材料本身讲了什么过程、在什么条件下成立、作者自己承认哪些边界。');
  lines.push('用法：能用原文支撑的判断才写进口播；原文没说到的，不要替材料补因果。摘录无论多完整都不能代替核实。');
  for (const [i, item] of pack.items.entries()) {
    lines.push('');
    lines.push(`[${i + 1}] ${item.url}${item.heading ? ' · ' + item.heading : ''}`);
    if (item.source) lines.push(`定位：${item.source.recordPath} · sha256 ${item.source.recordSha256} · 正文 ${item.source.pageIndex} · 字符 ${item.source.start}–${item.source.end}`);
    lines.push('原文：' + item.text);
  }
  if (caveats.length) {
    lines.push('');
    lines.push('编辑登记的材料限定（不是原文摘录，是选材时的判断）：');
    for (const caveat of caveats) lines.push('- ' + caveat);
  }
  if (pack.dropped > 0) lines.push('', `另有 ${pack.dropped} 条同类片段因字数预算未列出；需要时按记录路径自取。`);
  if (pack.omitted > 0) lines.push('', `另有 ${pack.omitted} 条候选无法安全逐字提取，已跳过，未擅自清洗或截断。`);
  return lines.join('\n');
}
