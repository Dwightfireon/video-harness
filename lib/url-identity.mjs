/* 链接归一、去重身份与"是否机器接口"。纯函数：不读盘、不联网、不认识项目。
 *
 * 为什么单独一层：简介里"是否已有这条链接"、"要不要排版这条链接"、
 * 以及 claims 证据里"这个地址读者能不能看"，必须用同一套判断。
 * 之前两个模块各写一份，doi:/doi.org/尾斜杠写法一混就重复添加。
 */
const DOI = /(?<![\w./-])10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+/;

/* `doi:10.x/y`、裸 `10.x/y`、`https://doi.org/10.x/y` → 可点开链接。
 * 先剥掉 doi: / doi.org 前缀，否则 DOI 前面紧邻的「/」会让边界检查失效。
 * 前后要求带边界，避免把 90.3%、版本号或更长数字串误认成 DOI。 */
export function doiUrl(text) {
  const body = String(text || '').trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  const match = DOI.exec(body);
  if (!match) return null;
  const id = match[0].replace(/[.,;:)\]]+$/u, '').replace(/\)+$/, '');
  return id.length > 8 ? 'https://doi.org/' + id : null;
}

/* 裸域名 → https URL；已经是 http(s) 的原样返回。
 * 末尾的句读符号（中英文）都剥掉——来源清单里它们几乎总是句子标点，不是 URL 的一部分。 */
export function normalizeUrl(text) {
  const value = String(text || '').trim().replace(/[，。；、）》)\]]+$/u, '').replace(/[.,;:]+$/, '');
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  // 至少一个点、顶级域 2 位以上，避免把 "e.g" 或版本号当域名。
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(value)) return null;
  return 'https://' + value;
}

/* arXiv 编号 → 摘要页。允许带版本号（v3）。 */
export function arxivUrl(id) {
  const match = /^arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?$/i.exec(String(id || '').trim());
  return match ? 'https://arxiv.org/abs/' + match[1] : null;
}

/* 一行文本里出现的 DOI 编号（已去掉 doi: / doi.org 包装与尾部标点）。
 * 语法只在这里出现一次：调用方只拿编号，不各自写正则。
 * 排除 URL 路径里的「/10.1234/foo」——那不是学术编号。 */
export function doiTokens(text) {
  const body = String(text || '').replace(/https?:\/\/(?:dx\.)?doi\.org\//gi, 'doi:');
  const out = [];
  for (const match of body.matchAll(/(?<![\w./-])10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+/g)) {
    const before = body.slice(0, match.index);
    if (/https?:\/\/\S*$/i.test(before)) continue;
    const id = match[0].replace(/[.,;:)\]]+$/u, '');
    if (id.length > 8) out.push(id);
  }
  return out;
}

/* 去重身份：忽略协议、www、末尾斜杠、DOI 包装与 arXiv 版本号。
 * 让 `doi:10.x/y`、`https://doi.org/10.x/y/`、`10.x/y` 算同一条。 */
export function urlIdentity(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const doi = doiUrl(text);
  if (doi) return doi.toLowerCase();
  const arxiv = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(text);
  if (arxiv) return 'arxiv:' + arxiv[1];
  try {
    const url = new URL(normalizeUrl(text) || text);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    return host + pathname + (url.search || '');
  } catch { return text.toLowerCase().replace(/\/+$/, ''); }
}

/* 点开不是文章的地址（API / 数据文件）。只用于提示，不据此丢弃来源。 */
export const isMachineUrl = url => /\/api\/|\.json(\?|$)|\.xml(\?|$)|\.csv(\?|$)/i.test(String(url || ''));
