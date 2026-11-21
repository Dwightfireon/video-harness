/* 从项目里收集「可以放进简介的参考链接」。
 *
 * 四个来源，都是作者或调研过程已经留下的东西：
 *   1. claims.json 的 external 证据（有就优先用，字段更完整）
 *   2. 脚本.md 的 `## 数字与来源` 小节（content-first 策略下没有 claims.json，
 *      但这一节按技能契约必须写，里面通常已经带了网址或 arXiv 编号）
 *   3. materials/选题.md、materials/原文.md 的「检索来源」段落（入队时保存，
 *      常含 DOI 或论文页；不读正文里的其他链接）
 *   4. research/ 下的调研资料（每条小标题下第一个链接）
 *
 * 只做提取、归一、去重和排版。**不判断来源是否支持断言，也不核证链接是否可达。**
 * 提取不到就给空列表，绝不补编——简介里出现一个编造的链接比没有链接更糟。
 *
 * 归一：脚本里常写成 `openai.com/index/xxx`（省略 https://）、`arXiv:2604.08525v3`
 * 或 `doi:10.1038/…`。这些是给人读的写法，简介里必须是可点开的完整 URL。
 */
import fs from 'node:fs';
import path from 'node:path';
import { referenceSources } from './publish-refs.mjs';
import { doiUrl, doiTokens, normalizeUrl, urlIdentity, arxivUrl } from './url-identity.mjs';
import { writeReferences } from './reference-write.mjs';

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return '' }; };

/* 链接归一与身份判断集中在 url-identity.mjs，这里转出供既有调用方使用。 */
export { doiUrl, normalizeUrl, urlIdentity, arxivUrl };

/* 从一行来源说明里抠出所有可引用链接。
 * 一行常包含多个来源：「→ OpenAI《…》，openai.com/…；OpenAI《…》(2026-01-16)。」
 * 也可能写成 `arXiv:2604.08525v3（COLM 2026）`——编号后面紧跟全角括号。
 * 论文常只写 `doi:10.1038/s41591-026-04297-7`，读者没法直接点开。
 * 所以用全局匹配直接找链接，而不是按标点切分（切分会把编号和括号切开）。
 */export function linksInLine(line) {
  const text = String(line || '');
  const out = [];
  const seen = new Set();
  const push = item => {
    if (!item?.url) return;
    const key = urlIdentity(item.url);
    if (!key || seen.has(key)) return;
    seen.add(key); out.push(item);
  };

  /* DOI：兼容 doi: 前缀、裸 DOI 与 doi.org 链接。编号语法在 url-identity 里只写一次。 */
  for (const id of doiTokens(text)) {
    const url = doiUrl(id);
    if (url) push({ url, label: `doi:${id}`, kind: 'doi' });
  }

  /* arXiv：允许后面跟任意非字母数字字符（版本号之后常接全角括号）。 */
  for (const match of text.matchAll(/arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/gi)) {
    push({ url: `https://arxiv.org/abs/${match[1]}`, label: `arXiv ${match[1]}${match[2] || ''}`, kind: 'arxiv' });
  }

  /* 完整 URL。全角括号也要截断：脚本表格里常写「https://x/pricing（2026-11-10 抓取）」，
   * 不截断会把日期和括号一起算进链接，读者点不开。 */
  for (const match of text.matchAll(/https?:\/\/[^\s，。；、）》)\]"'<>（）【】「」]+/gi)) {
    push({ url: normalizeUrl(match[0]), label: hostLabel(match[0]), kind: 'web' });
  }

  /* 裸域名：openai.com/index/xxx、help.openai.com/... 。
   * 前后必须不是字母数字，避免把句子里的英文单词当域名。 */
  for (const match of text.matchAll(/(?:^|[^\w.\/-])((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s，。；、）》)\]"'<>（）【】「」]*)?)/gi)) {
    const url = normalizeUrl(match[1]);
    if (url) push({ url, label: hostLabel(url), kind: 'web' });
  }

  return out;
}

function hostLabel(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
    return tail ? `${u.hostname} / ${decodeURIComponent(tail)}` : u.hostname;
  } catch { return url; }
}

/* 解析 research/ 下的调研资料：每条「### 标题」下的第一个链接作为该来源。
 *
 * 为什么需要这一层：脚本的「数字与来源」常写成表格（数字｜出处｜口径），
 * 出处只写机构名和日期，不放 URL。真正的链接在 research/ 的调研资料里。
 * 只看脚本会得到 0 条——第一支 ChatGPT 广告片就有这个问题。
 *
 * 只取 research/*.md，且只认每条小标题下的第一个 URL：
 * 那是这条资料的出处；后面出现的多是旁证或"另见"，混在一起会让清单变噪音。
 */
export function researchSources(project) {
  const dir = path.join(project, 'research');
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch { return []; }

  const out = [];
  for (const name of files) {
    const md = read(path.join(dir, name));
    if (!md) continue;
    let label = '';
    let skipped = false;
    for (const raw of md.split('\n')) {
      const line = raw.trim();
      // 小标题：换成新的一条来源，重置"这条还没取到链接"的状态
      const heading = /^#{2,4}\s+(.+)$/.exec(line);
      if (heading) {
        label = heading[1].replace(/^\d+[.、)]\s*/, '').trim();
        // 明确标为二手/未读到的条目不作为公开来源
        skipped = /仅二手|未取得|未读到|抓取失败|不作为/.test(label);
        continue;
      }
      if (skipped || !label) continue;
      const links = linksInLine(line);
      if (!links.length) continue;
      out.push({ ...links[0], label: cleanLabel(label), from: name });
      label = '';  // 一条小标题只取一个链接
    }
  }
  return out;
}

/* 解析脚本.md 的 `## 数字与来源`：每条记录的「说明」当 label，链接单独取。 */
export function scriptSources(project) {
  const md = read(path.join(project, '脚本.md'));
  if (!md) return [];
  const lines = md.split('\n');
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^##\s*(.+?)\s*$/.exec(lines[i]);
    if (!heading) continue;
    if (start < 0 && /数字与来源|来源|参考资料/.test(heading[1])) { start = i; continue; }
    if (start >= 0) { end = i; break; }
  }
  if (start < 0) return [];

  const out = [];
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.trim();
    if (!line || /^[-=]{3,}$/.test(line) || /^\|\s*:?-{2,}/.test(line)) continue;
    /* 说明部分：去掉行首列表符号和「→」前的断言，只留来源描述。
     * 断言不是给读者看的参考信息，塞进简介会显得在辩护自己。
     * label 只取箭头后第一个分句，并且必须真的含有链接——否则会出现
     * 「Wu → arxiv.org/...」这种把作者姓氏当标题的情况。 */
    const body = line.replace(/^\s*[-*•]\s*/, '');
    const afterArrow = body.includes('→') ? body.slice(body.lastIndexOf('→') + 1) : body;
    const links = linksInLine(afterArrow);
    if (!links.length) continue;
    const label = cleanLabel(tableLabel(line, afterArrow));
    for (const link of links) {
      out.push({ ...link, label: label && !/^[\w\s.-]{1,12}$/.test(label) ? label : link.label, from: '脚本.md' });
    }
  }
  return out;
}

/* 「数字与来源」常用表格：| 数字 | 说法 | 来源 | 性质 |。
 * 整行当标签会带竖线和被截断的网址，读者看不懂。优先取「说法」列：
 * 跳过数字列和含链接的来源列。没有表格结构时退回箭头后的第一个分句。 */
function tableLabel(line, fallback) {
  const plain = fallback.split(/[，,；;]/u)[0];
  if (!/^\|.*\|/.test(line)) return plain;
  const cells = line.split('|').slice(1, -1).map(cell => cell.trim()).filter(Boolean);
  if (cells.length < 2) return plain;
  const numeric = cell => /^[\d.,%]+(?:\s*(?:美元|次|秒|分钟|小时|天|倍|token|个|万|条|元))?$/.test(cell);
  const candidates = cells.filter(cell => cell.length >= 4 && !numeric(cell) && !/https?:\/\/|\.(?:ai|com|org|io|net|rest|top)\b/i.test(cell));
  // 表格通常是「数字｜说法｜来源｜性质」：第一个像说明的列就是读者要的标题。
  return candidates[0] || plain;
}

/* label 清洗：去书名号、去尾部年份括号、去括号里的过程说明。
 *   「Ahrefs 2026-02-11（已抓到全文）」→「Ahrefs 2026-02-11」
 *   「Google 官方：一年超过 5 万亿次搜索（已读到原文）」→ 保留，前面有信息
 * 「已读到/已抓到/二手转述」这类是给作者看的核证状态，读者不需要。 */
function cleanLabel(text) {
  return String(text || '')
    .replace(/[《》]/g, '')
    .replace(/[（(][^）)]*(?:已读到|已抓到|二手|未取得|未读到|抓取失败)[^）)]*[）)]/g, '')
    .replace(/[（(]\s*\d{4}[-年]?[^）)]*[）)]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/* 解析 materials/ 里的原始材料：入队时保存的选题简报通常带着检索来源，
 * 但项目里没有 claims.json、脚本也没写 URL 时就完全没人读它。
 * 只取「检索来源」一段里的链接，标明未经核证；不读正文里的其他链接。 */
const MATERIAL_FILES = ['materials/选题.md', 'materials/原文.md'];
export function materialSources(project) {
  const out = [];
  for (const name of MATERIAL_FILES) {
    const md = read(path.join(project, name));
    if (!md) continue;
    let inside = false;
    for (const raw of md.split('\n')) {
      const line = raw.trim();
      // 「检索来源（…）：」是 topicBrief 生成的一整行小标题，不是 Markdown 标题。
      const isHeading = /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*$/.test(line) || /^[^\s-].{0,40}[：:]$/.test(line);
      if (isHeading) {
        inside = /检索来源|参考来源|资料来源|^来源/.test(line);
        continue;
      }
      if (!inside) continue;
      for (const link of linksInLine(line)) {
        // DOI / arXiv 写成编号时没有标题可用，保留编号本身当标签，比 doi.org/v1 可读。
        out.push({ ...link, label: ['doi', 'arxiv'].includes(link.kind) ? link.label : '', from: name });
      }
    }
  }
  return out;
}

/* 合并四个来源。优先级：claims.json > 脚本.md > materials/ > research/。
 * claims.json 有作者登记过的公开标题；脚本是最精炼的口径说明；
 * materials 是入队时的检索来源（未经核证）；research 是调研底稿，噪音最多。 */
export function collectReferences(project) {
  const merged = new Map();
  const put = (item, from, label, note) => {
    const key = urlIdentity(item.url);
    if (!key) return;
    const existing = merged.get(key);
    merged.set(key, {
      url: item.url,
      label: label || existing?.label || hostLabel(item.url),
      note: note || existing?.note || '',
      from,
    });
  };
  for (const item of researchSources(project)) put(item, item.from, item.label, '');
  for (const item of materialSources(project)) put(item, item.from, item.label, '');
  for (const item of scriptSources(project)) put(item, '脚本.md', item.label, '');
  for (const item of referenceSources(project)) put(item, 'claims.json', item.label, item.note);
  return mergeDoiDuplicates([...merged.values()]);
}

/* 同一篇论文常同时出现「doi:10.x/s41591-…」和「publisher.com/articles/s41591-…」。
 * 两条都对，但并排放进简介只是噪音。合并规则：只拿「链接末段」去匹配
 * **已存在的 DOI 后缀**，保留 DOI 链接（稳定可解析），借用出版方页面的可读标题。
 * 两条普通页面末段相同不合并——不同站点的 report 不是同一份东西。
 * 只在收集阶段做，不改 urlIdentity：两处用途不同，不能互相牵连。 */
function mergeDoiDuplicates(list) {
  const doiOf = url => {
    const doi = doiUrl(url);
    return doi ? doi.slice('https://doi.org/'.length).toLowerCase() : null;
  };
  // 只比对 DOI 的最后一段：10.1038/s41591-… 对应 nature.com/articles/s41591-…
  const doiTail = url => {
    const doi = doiOf(url);
    if (!doi) return null;
    const parts = doi.split('/');
    return parts.length > 1 ? parts.at(-1) : null;
  };
  const doiTails = new Set(list.map(item => doiTail(item.url)).filter(Boolean));
  if (!doiTails.size) return list;

  const out = [], seenDoi = new Set();
  for (const item of list) {
    const doi = doiOf(item.url);
    if (doi) {
      if (seenDoi.has(doi)) continue;
      seenDoi.add(doi);
      // 找同一篇的出版方页面，只为借一个可读标题。
      const sibling = list.find(other => {
        if (doiOf(other.url)) return false;
        try {
          const tail = decodeURIComponent(new URL(other.url).pathname).split('/').filter(Boolean).pop() || '';
          return tail.toLowerCase() === doi.split('/').at(-1);
        } catch { return false; }
      });
      out.push({ ...item, label: sibling?.label || item.label });
      continue;
    }
    let tail = '';
    try { tail = decodeURIComponent(new URL(item.url).pathname).split('/').filter(Boolean).pop() || ''; } catch {}
    if (tail && doiTails.has(tail.toLowerCase())) continue;  // 已被 DOI 条目代表
    out.push(item);
  }
  return out;
}

/* 排版与写入各自成一模块，这里只为既有调用方转出写入入口。 */
export { writeReferences };

/* 唯一的写入入口：先合并四个来源，再交给 reference-write 落盘。 */
export function appendReferencesToCopy(project, options = {}) {
  const sources = collectReferences(project);
  return writeReferences(project, sources, options);
}

/* 只要 claims.json 这一种来源（审校模式的项目）。落盘仍是同一个实现。 */
export function appendClaimReferences(project, { sources, heading, max } = {}) {
  const list = Array.isArray(sources) ? sources : referenceSources(project);
  return writeReferences(project, list, { ...(heading ? { heading } : {}), ...(max ? { max } : {}) });
}
