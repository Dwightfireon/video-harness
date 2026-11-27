/* 选题去重纯函数契约：零 I/O、零跨模块依赖。
 *
 * 职责边界：
 *   - 字面 2-gram 兜底 + 底层机制/概念锚点匹配 + 规范化 URL 同源重合检测 + 早期历史压缩格式；
 *   - 不读写磁盘、不联网、不调用模型，供 discovery.mjs 与 discovery-prompts.mjs 单向复用。
 */

export const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');

export function similar(a, b, { minLength = 10, minRatio = 0.75, threshold = 0.8 } = {}) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < minLength || Math.min(a.length, b.length) / Math.max(a.length, b.length) < minRatio) return false;
  const grams = value => new Set(Array.from({ length: value.length - 1 }, (_, i) => value.slice(i, i + 2)));
  const x = grams(a), y = grams(b), shared = [...x].filter(part => y.has(part)).length;
  return shared / (x.size + y.size - shared) >= threshold;
}

export function sourceIdentity(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

/* 通用高频英文泛词：不能单独作为去重依据 */
const EN_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which', 'how', 'why',
  'llm', 'llms', 'ai', 'gpt', 'chatgpt', 'claude', 'gemini', 'llama', 'openai', 'anthropic', 'google', 'apple', 'meta',
  'agent', 'agents', 'model', 'models', 'system', 'systems', 'data', 'code', 'tool', 'tools', 'user', 'users',
  'task', 'tasks', 'work', 'time', 'cost', 'price', 'study', 'paper', 'research', 'human', 'prompt', 'prompts',
  'text', 'long', 'short', 'high', 'low', 'real', 'test', 'news', 'new', 'use', 'using', 'into', 'over', 'more',
]);

/* 高辨识度中文机制/效应锚点（命中同一特定现象或机制时，即使换了大白话标题也高度疑似撞题） */
const ZH_NAMED_MECHANISMS = [
  '上下文退化', '逆诅咒', '模型崩溃', '自消耗训练', '间接提示注入',
  '捷径学习', '奖励作弊', '规格博弈', '对抗样本', '对抗脆弱性', '姆潘巴',
  '辛普森悖论', '回归均值', '火积云', '火风暴', '实体混淆', '准液态层', '内聚力张力',
  '菌根真菌', '生物标志气体', '查询优化器',
];

/* 组合型机制锚点（修饰词必须与对应主体成对出现，避免“长时程迁移”与“长时程 agent”跨领域误撞） */
const COMPOSITE_MECHANISMS = [
  { id: 'long-horizon-agent', pattern: /(?:长时程.{0,16}(?:agent|智能体)|(?:agent|智能体).{0,16}长时程)/i },
  { id: 'indirect-prompt-injection', pattern: /(?:隐藏指令|间接提示注入|prompt\s*injection)/i },
];

/* 正交维度词（如“计费/定价/花多少钱” vs “技术机制/体验”）：避免把同一产品的不同切口误杀 */
const COST_DIMENSION = /(?:计费|定价|收费|成本|花(?:的)?钱|预算|token\s*算|省(?:下|多少)|账单|订阅费)/i;

/* 中文泛词停用片段：剥除后再做概念相似度，避免“大模型/为什么/机制”制造假相似 */
const ZH_FILLER = /(?:大语言模型|大模型|人工智能|机器学习|深度学习|为什么|凭什么|是不是|会不会|到底|怎么|如何|什么|真的|反而|越来越|其实|问题|机制|原理|原因|现象|过程|影响|变化|研究|实验|分析|系统|技术|方法|模式|表现|效果|任务|内容|工具|模型|以及|还是|或者|一个|一种|两种|同一|不同|普通人|用户|企业|公司|团队)/g;

function extractEnglishTerms(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  // 只提取多词/连字符英文专有机制短语（如 llm-as-a-judge, context rot, mpemba effect, prompt injection），
  // 避免单个泛用英文词（如 coding/cursor/control/github）造成跨题误杀。
  for (const m of s.matchAll(/\b[a-z][a-z0-9]{2,}(?:[- ][a-z][a-z0-9]{1,}){1,3}\b/g)) {
    const phrase = m[0].replace(/\s+/g, ' ').trim();
    const parts = phrase.split(/[- ]/);
    const specificCount = parts.filter(p => p.length >= 4 && !EN_STOP.has(p)).length;
    if (specificCount >= 2 || (parts.length >= 3 && specificCount >= 1)) out.add(phrase);
  }
  return out;
}

function extractZhBigrams(text) {
  const cleaned = String(text || '').replace(ZH_FILLER, ' ').replace(/[^\u4e00-\u9fff]+/g, ' ').trim();
  const grams = new Set();
  for (const seg of cleaned.split(/\s+/)) {
    if (seg.length < 2) continue;
    for (let i = 0; i < seg.length - 1; i++) grams.add(seg.slice(i, i + 2));
  }
  return grams;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return { score: shared / (a.size + b.size - shared), shared };
}

export function extractConceptSignature(item = {}) {
  const topic = String(item.topic || '');
  const subject = String(item.subject || '');
  const core = String(item.coreQuestion || '');
  const full = `${topic} ${subject} ${core}`;
  const namedZh = new Set(ZH_NAMED_MECHANISMS.filter(term => full.includes(term)));
  for (const { id, pattern } of COMPOSITE_MECHANISMS) {
    if (pattern.test(full)) namedZh.add(id);
  }
  const enTerms = extractEnglishTerms(full);
  const subjectGrams = extractZhBigrams(subject || topic);
  const coreGrams = extractZhBigrams(core || topic);
  const isCostAngle = COST_DIMENSION.test(full);
  return { namedZh, enTerms, subjectGrams, coreGrams, isCostAngle };
}

/**
 * 高精度概念重合判定：只拦截「底层机制或专有概念一致且讲述维度非正交」的改写重复题，
 * 不误杀同一对象下完全不同切口（如“语音打断机制” vs “语音计费成本”）。
 */
export function hasConceptOverlap(a, b) {
  const sigA = extractConceptSignature(a);
  const sigB = extractConceptSignature(b);
  // 若一方明确讲计费/成本而另一方讲非成本机制，视为正交切口，不误杀
  if (sigA.isCostAngle !== sigB.isCostAngle) return false;

  // 1. 命中同一高辨识度中文机制锚点（如“长时程”“逆诅咒”“辛普森悖论”“模型崩溃”）
  for (const term of sigA.namedZh) {
    if (sigB.namedZh.has(term)) return true;
  }

  // 2. 命中同一高辨识度英文多词专有机制短语（如 context rot / mpemba effect / llm-as-a-judge）
  for (const term of sigA.enTerms) {
    if (sigB.enTerms.has(term)) return true;
  }

  // 3. subject 与 coreQuestion 去泛词后的双重高重叠（防止仅换口语标题绕过）
  const subj = jaccard(sigA.subjectGrams, sigB.subjectGrams);
  const core = jaccard(sigA.coreGrams, sigB.coreGrams);
  if (subj.shared >= 3 && subj.score >= 0.45 && core.shared >= 2 && core.score >= 0.35) return true;

  return false;
}

/* 语义判断主靠编辑提示词；本地兜底覆盖字面近似 + 高精度机制/概念锚点重合。 */
export function duplicateOf(item, known) {
  const topic = normalized(item.topic);
  const core = normalized(item.coreQuestion);
  const subject = normalized(item.subject);
  return known.find(previous => {
    if (similar(topic, normalized(previous.topic))) return true;
    const prevCore = normalized(previous.coreQuestion);
    const prevSubject = normalized(previous.subject);
    if (core && prevCore) {
      if (similar(core, prevCore) && (!subject || !prevSubject || similar(subject, prevSubject))) return true;
      if (subject && prevSubject && subject.length >= 2 && subject === prevSubject &&
        similar(core, prevCore, { minLength: 8, minRatio: 0.6, threshold: 0.6 })) return true;
    }
    if (hasConceptOverlap(item, previous)) return true;
    return false;
  });
}

/**
 * 调查完成后的同源重合检测：
 * 共享单一综合报道不直接判重，但若「≥2 篇核心来源重合」或「全部来源重合且概念锚点重叠」，
 * 返回对应历史记录供写进限定提示或阻止自动入队重复翻拍。
 */
export function findSourceOverlap(sources, known, { ignoreId = '', updateOf = '', target = null } = {}) {
  const currentUrls = [...new Set((Array.isArray(sources) ? sources : []).map(sourceIdentity).filter(Boolean))];
  if (!currentUrls.length) return null;
  const currentSet = new Set(currentUrls);
  let best = null;
  for (const previous of Array.isArray(known) ? known : []) {
    if (!previous || previous.id === ignoreId || previous.id === updateOf || previous.status === 'duplicate') continue;
    const prevUrls = [...new Set([
      ...(Array.isArray(previous.sources) ? previous.sources : []),
      ...(Array.isArray(previous.research?.sources) ? previous.research.sources.map(s => s?.url) : []),
    ].map(sourceIdentity).filter(Boolean))];
    if (!prevUrls.length) continue;
    const sharedUrls = prevUrls.filter(url => currentSet.has(url));
    if (!sharedUrls.length) continue;
    const fullOverlap = sharedUrls.length === currentUrls.length;
    const conceptHit = target ? hasConceptOverlap(target, previous) : false;
    if (sharedUrls.length >= 2 || (fullOverlap && conceptHit)) {
      if (!best || sharedUrls.length > best.sharedUrls.length) {
        best = { previous, sharedUrls, total: currentUrls.length, fullOverlap };
      }
    }
  }
  return best;
}

/**
 * 压缩早期历史条目（第 41 条以后）：在保留简洁标题的同时附带精简机制/对象锚点，
 * 避免模型只看到大白话标题而认不出底层机制已讲过。
 */
export function formatOlderHistoryEntry(item) {
  const title = String(item?.topic || '').trim();
  if (!title) return '';
  const subject = String(item?.subject || '').trim();
  if (!subject) return title;
  const normTitle = normalized(title);
  const normSubj = normalized(subject);
  if (!normSubj || normTitle.includes(normSubj) || normSubj.includes(normTitle)) return title;
  const compactSubj = subject.length > 26 ? subject.slice(0, 26) + '…' : subject;
  return `${title}〔${compactSubj}〕`;
}
