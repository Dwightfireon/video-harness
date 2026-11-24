/* 选题材料规则：纯函数，不访问网络/磁盘，不把模型自报的检索当工具证据。 */
import { dateOnly, normalizeTopicResearch } from './topic-contract.mjs';
import { classifyDiscipline, DISCIPLINE } from './discovery-prompts.mjs';
export { dateOnly, normalizeTopicResearch } from './topic-contract.mjs';
const clean = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const compact = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const dayMs = 86400000;
function urlKey(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}

/* 只执行可明确解析的时间范围；其余原文限制仍交给编辑，不假称全部已机器校验。 */
export function discoveryWindow(query, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10), end = Date.parse(today + 'T00:00:00Z');
  const range = String(query).match(/(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(\d{4}-\d{2}-\d{2})/);
  if (range && dateOnly(range[1]) && dateOnly(range[2]) && range[1] <= range[2]) return { from: range[1], to: range[2] < today ? range[2] : today, explicit: true };
  if (/昨天|昨日/.test(query)) { const day = new Date(end - dayMs).toISOString().slice(0, 10); return { from: day, to: day }; }
  if (/今天|今日/.test(query)) return { from: new Date(end - 2 * dayMs).toISOString().slice(0, 10), to: today };
  const match = String(query).match(/(?:最近|过去|近)\s*(\d{1,3}|一|两|二|三|七|十)?\s*(天|日|周|个月|月)/);
  if (!match) return null;
  const count = Number(match[1]) || ({ 一: 1, 两: 2, 二: 2, 三: 3, 七: 7, 十: 10 }[match[1]]) || 1;
  const days = Math.min(3650, count * ({ 天: 1, 日: 1, 周: 7, 个月: 30, 月: 30 }[match[2]]));
  return { from: new Date(end - (days - 1) * dayMs).toISOString().slice(0, 10), to: today };
}

export function collectDiscoveryResearch(events) {
  const searches = [], pages = [], failures = [];
  for (const event of events) {
    if (event?.type !== 'tool_use') continue;
    const part = event.part || {}, state = part.state || {};
    const tool = part.tool || event.tool, input = state.input || {};
    // 失败的工具调用要留证据：否则界面只会说“没搜到”，用户不知道是没额度、被拦还是网络问题。
    if (['websearch', 'webfetch'].includes(tool) && state.status !== 'completed') {
      const error = clean(state.error || state.output, 300) || ('工具调用未完成（' + (state.status || '未知状态') + '）');
      failures.push({ tool, target: clean(tool === 'websearch' ? input.query : input.url, 300), error,
        status: /HTTP\s*(\d{3})/i.exec(error)?.[1] || null });
      continue;
    }
    if (state.status !== 'completed' || typeof state.output !== 'string' || !state.output.trim()) continue;
    if (tool === 'websearch') {
      const query = clean(input.query, 2000);
      if (query && !searches.some(item => item.query === query)) searches.push({ query, output: state.output });
    }
    if (tool === 'webfetch') {
      const url = urlKey(input.url);
      // 失败页/拦截页不能当原文，模型也不得用搜索摘要补成“已读”。
      const blocked = /^(?:#\s*)?(?:error\s*:|failed\s*:|fetch failed|access denied\b|verify you are human\b|just a moment\b|请完成验证|访问被拒绝)|cloudflare ray id\s*:/i.test(state.output.trim());
      if (url && !blocked) pages.push({ url, body: state.output });
    }
  }
  return { searches, pages, failures };
}

const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function dateInQuote(date, quote) {
  if (!dateOnly(date)) return false;
  const [y, m, d] = date.split('-').map(Number), value = compact(quote).toLowerCase();
  const numeric = new RegExp(`(?<!\\d)${y}\\s*(?:[-/.]|年)\\s*0?${m}\\s*(?:[-/.]|月)\\s*0?${d}(?:日|号)?(?!\\d)`);
  const month = months[m - 1], enMonth = `(?:${month}|${month.slice(0, 3)}\\.?)`;
  return numeric.test(value) || new RegExp(`\\b${enMonth}\\s+0?${d}(?:st|nd|rd|th)?[,]?\\s+${y}\\b`).test(value) ||
    new RegExp(`\\b0?${d}\\s+${enMonth}[,]?\\s+${y}\\b`).test(value);
}

/* ---------- 按学科分层的权威来源域名白名单 ----------
 * 只用于"不要求一手论文全文"的放宽路径，不影响一般的原文可读性检查。
 * 营销号、问答帖、AI 水文无论哪个学科都拒绝。 */
const NATURAL_SCIENCE_AUTHORITATIVE = /(?:^|\.)(?:nature\.com|science\.org|sciencedirect\.com|cell\.com|pnas\.org|thelancet\.com|nejm\.org|bmj\.com|nih\.gov|cdc\.gov|who\.int|nasa\.gov|noaa\.gov|quantamagazine\.org|sciencedaily\.com|phys\.org|eurekalert\.org|ncbi\.nlm\.nih\.gov|pmc\.ncbi\.nlm\.nih\.gov)$/i;
const SOCIAL_SCIENCE_AUTHORITATIVE = /(?:^|\.)(?:oecd\.org|worldbank\.org|imf\.org|ilo\.org|pewresearch\.org|nber\.org|ssrn\.com|ourworldindata\.org|brookings\.edu|rand\.org|piie\.com|cepr\.org|voxeu\.org|journals\.uchicago\.edu|academic\.oup\.com|cambridge\.org|jstor\.org)$/i;
const PHILOSOPHY_AUTHORITATIVE = /(?:^|\.)(?:plato\.stanford\.edu|iep\.utm\.edu|philpapers\.org|jstor\.org|cambridge\.org|academic\.oup\.com|gutenberg\.org|sacred-texts\.com|marxists\.org|earlymoderntexts\.com)$/i;
/* 所有学科通用拒绝名单：营销号、鸡汤、论坛、AI水文 */
const JUNK_DOMAINS = /(?:^|\.)(?:zhihu\.com|quora\.com|reddit\.com|medium\.com|csdn\.net|jianshu\.com|toutiao\.com|sohu\.com|163\.com|sina\.com\.cn|baijiahao\.baidu\.com|mp\.weixin\.qq\.com|zhuanlan\.zhihu\.com)$/i;

function domainOf(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase(); } catch { return ''; }
}

export function isAuthoritativeForDiscipline(url, discipline) {
  const host = domainOf(url);
  if (!host) return false;
  if (JUNK_DOMAINS.test(host)) return false;
  switch (discipline) {
    case DISCIPLINE.NATURAL_SCIENCE: return NATURAL_SCIENCE_AUTHORITATIVE.test(host);
    case DISCIPLINE.SOCIAL_SCIENCE: return SOCIAL_SCIENCE_AUTHORITATIVE.test(host);
    case DISCIPLINE.PHILOSOPHY: return PHILOSOPHY_AUTHORITATIVE.test(host);
    default: return false;
  }
}

export function assessDiscoveryCandidate(candidate, { sources, research, now = Date.now(), window = null, discipline: explicitDiscipline } = {}) {
  const reject = reason => ({ ok: false, reason });
  if (!['news', 'evergreen'].includes(candidate.kind)) return reject('未区分新闻与深度材料');
  if (![candidate.selectionReason, candidate.why, candidate.outline].every(value => clean(value).length >= 12)) return reject('推荐理由或讲述材料不足');
  const allowed = new Set((sources || []).map(urlKey).filter(Boolean)), evidence = [], caveats = [];
  const today = new Date(now).toISOString().slice(0, 10);
  /* 检测学科：外部可显式指定，否则从候选文本中推断 */
  const discipline = explicitDiscipline || classifyDiscipline([candidate.topic, candidate.coreQuestion, candidate.why, candidate.outline].filter(Boolean).join(' '));
  for (const item of (Array.isArray(candidate.evidence) ? candidate.evidence : []).slice(0, 8)) {
    const url = urlKey(item?.url), quote = clean(item?.quote), supports = clean(item?.supports, 1000);
    if (!url || !allowed.has(url) || compact(quote).length < 40 || supports.length < 12) continue;
    /* 通用拒绝：营销号等垃圾域名的内容不可作为依据 */
    if (JUNK_DOMAINS.test(domainOf(url))) continue;
    const pages = research.pages.filter(page => page.url === url);
    const page = pages.find(page => compact(page.body).includes(compact(quote)));
    if (!page) continue;
    const entry = { url, title: clean(item.title, 300), sourceType: item.sourceType, quote, supports };
    for (const [key, quoteKey] of [['publishedAt', 'publicationQuote'], ['eventDate', 'eventQuote']]) {
      const date = dateOnly(item[key]), dateQuote = clean(item[quoteKey], 600);
      const publicationOnly = key === 'eventDate' && /^(?:(?:last\s+)?(?:published|updated|posted)(?:\s+(?:on|at))?\s*[:：]?\s*\d|(?:last\s+)?(?:published|updated|posted)\s*[:：]\s*|(?:发表|发布|更新)(?:日期|时间|于)\s*[:：]?)/i.test(dateQuote);
      if (!publicationOnly && date && date <= today && compact(dateQuote).length >= 8 && compact(page.body).includes(compact(dateQuote)) && dateInQuote(date, dateQuote)) {
        entry[key] = date; entry[quoteKey] = dateQuote;
      } else if (item[key]) caveats.push(key === 'eventDate' ? '事件日期未能匹配原文，未采信' : '发表日期未能匹配原文，未采信');
    }
    if (!evidence.some(old => old.url === url)) evidence.push(entry);
  }
  if (!evidence.length) return reject('没有可匹配已读取原文的有效片段');
  if (candidate.kind === 'news' && !evidence.some(item => item.eventDate)) return reject('新闻缺少可核对的事件日期');
  const dateKey = candidate.kind === 'news' ? 'eventDate' : 'publishedAt';
  const enforceWindow = Boolean(window && (candidate.kind === 'news' || window.explicit));
  if (enforceWindow && !evidence.some(item => item[dateKey] >= window.from && item[dateKey] <= window.to)) return reject('材料日期不在明确要求的时间范围内');
  if (window && !enforceWindow && !evidence.some(item => item[dateKey] && item[dateKey] >= window.from && item[dateKey] <= window.to)) {
    caveats.push('本题为长期机制材料，未按近期时间范围排除较早资料');
  }
  if (!evidence.some(item => item.publishedAt)) caveats.push('来源发表日期未确认');
  /* 按学科分层的一手来源要求 */
  const hasPrimary = evidence.some(item => item.sourceType === 'primary');
  if (!hasPrimary) {
    if (discipline === DISCIPLINE.TECH) {
      caveats.push('未提供一手来源，需在写稿时继续追溯');
    } else if (discipline === DISCIPLINE.PHILOSOPHY) {
      /* 哲学：权威学术百科（SEP/IEP/PhilPapers）直接作为一级依据，不要求一手论文 */
      const hasPhilAuthority = evidence.some(item => isAuthoritativeForDiscipline(item.url, DISCIPLINE.PHILOSOPHY));
      if (hasPhilAuthority) {
        caveats.push('依据来自权威学术百科/综述，非一手论文');
      } else {
        caveats.push('未提供一手来源或权威学术百科，需在写稿时继续追溯');
      }
    } else if (discipline === DISCIPLINE.SOCIAL_SCIENCE) {
      /* 社科：机构报告/工作论文/政策简报直接作为一级依据 */
      const hasSocialAuthority = evidence.some(item => isAuthoritativeForDiscipline(item.url, DISCIPLINE.SOCIAL_SCIENCE));
      if (hasSocialAuthority) {
        caveats.push('依据来自权威机构报告/工作论文，非一手实证论文');
      } else {
        caveats.push('未提供一手来源或权威机构报告，需在写稿时继续追溯');
      }
    } else if (discipline === DISCIPLINE.NATURAL_SCIENCE) {
      /* 自然科学：允许「摘要/DOI页 + 权威解读」组合 */
      const hasNatSciAuthority = evidence.some(item => isAuthoritativeForDiscipline(item.url, DISCIPLINE.NATURAL_SCIENCE));
      if (hasNatSciAuthority) {
        caveats.push('核心论文在付费墙后，依据来自权威机构解读，非开放全文');
      } else {
        caveats.push('未提供一手来源，需在写稿时继续追溯');
      }
    } else {
      caveats.push('未提供一手来源，需在写稿时继续追溯');
    }
  }
  if (clean(candidate.limitations)) caveats.push(clean(candidate.limitations, 500));
  const result = normalizeTopicResearch({ version: 1, kind: candidate.kind, checkedAt: now,
    selectionReason: candidate.selectionReason, caveats: [...new Set(caveats)], sources: evidence }, sources);
  return { ok: true, research: result, sources: evidence.map(item => item.url), discipline };
}
