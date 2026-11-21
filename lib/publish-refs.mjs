/* claims.json → 可公开引用的来源清单。只负责"从证据表里挑出该给读者看的地址"。
 *
 * 边界：不判断证据是否支持断言，也不核证 URL 可达性；没有登记就不生成，绝不补编。
 * 排版与写入分别由 reference-format / reference-write 负责，本文件不写盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { urlIdentity, isMachineUrl } from './url-identity.mjs';
import { missingReferences, referenceBlock } from './reference-format.mjs';

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const text = value => typeof value === 'string' ? value.trim() : '';
const webURL = value => { try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; } };

/* 只接受外部事实类证据：作者建议/作者计算/用户提供不是"参考资料"。 */
const EXTERNAL = new Set(['external']);

/* 从 claims.json 取出可用于公开引用的来源。按公开 URL 去重，保留首次出现的标题与摘要。
 * 证据可另带 publicUrl / publicLabel：核证用 url 与读者用 publicUrl 是两回事，
 * 前者可能是 API 或存档地址，后者必须是给人看的页面。 */
export function referenceSources(project) {
  let document;
  try { document = JSON.parse(read(path.join(project, 'claims.json')) || '{}'); } catch { return []; }
  const claims = Array.isArray(document) ? document : document?.claims;
  if (!Array.isArray(claims)) return [];

  const seen = new Map();
  const machine = [];
  for (const raw of claims) {
    if (!raw || typeof raw !== 'object') continue;
    const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter(e => e && typeof e === 'object') : [];
    const kind = text(raw.kind) || text(evidence[0]?.type);
    const sourceType = text(raw.sourceType) || (/作者建议|作者归纳|recommendation/.test(kind) ? 'recommendation'
      : /作者计算|推导|假设算例|calculation/.test(kind) ? 'calculation'
        : /用户提供|user-provided/.test(kind) ? 'user-provided'
          : /本机实测|本地实测|本机测量|现场观测|measurement/i.test(kind) ? 'measurement' : 'external');
    if (!EXTERNAL.has(sourceType)) continue;

    for (const e of evidence) {
      const evidenceUrl = text(e.url) || text(raw.url);
      const publicUrl = text(e.publicUrl) || evidenceUrl;
      if (!webURL(publicUrl)) continue;
      // 来源明确未取得的，不放进公开参考清单（避免给出打不开或不相干的链接）
      const unavailable = e.available === false || Number(e.httpStatus) >= 400 ||
        /本次.{0,12}(?:403|未取得原文|未读到原文)|未直接(?:核到|读到)原文/u.test(text(e.quote) + ' ' + text(e.type));
      if (unavailable) continue;
      // 没给 publicUrl、又指向机器接口的，仍列出来，但要让人知道点开不是文章
      if (!text(e.publicUrl) && looksMachine(publicUrl)) machine.push(publicUrl);
      if (seen.has(publicUrl)) continue;
      seen.set(publicUrl, {
        url: publicUrl,
        label: text(e.publicLabel) || text(e.label) || text(e.title) || composedLabel(e, raw, publicUrl),
        note: text(e.note) || shorten(text(e.quote)),
        claimId: text(raw.id),
      });
    }
  }
  const list = [...seen.values()];
  Object.defineProperty(list, 'machineUrls', { value: [...new Set(machine)], enumerable: false });
  return list;
}

/* 标签不能几条一模一样；优先用作者给的 publicLabel，其次用来源类型 + 可区分标识，最后退回域名。
 * 同一域名下的多份文件（如四家公司的 SEC 申报）必须能被读者分开。 */
function composedLabel(e, raw, url) {
  const type = text(e.type);
  const host = hostOf(url);
  const tail = pathTail(url);
  if (type) return tail ? `${type}（${host}/${tail}）` : `${type}（${host}）`;
  return tail ? `${host}/${tail}` : host;
}

/* 取路径里最有辨识度的一段：优先去掉扩展名后的最后一段文件名；
 * 文件名过短（如 a.json / b.json）时带上父级，避免几家公司显示成同一个标签。 */
function pathTail(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    const last = parts.at(-1).replace(/\.(json|xml|csv|htm|html|pdf)$/i, '');
    const prev = parts.at(-2);
    const join = v => v.length > 24 ? v.slice(0, 24) + '…' : v;
    if (last.length > 2) return join(last);
    if (last && prev) return join(prev + '/' + last);
    return prev && prev.length > 2 ? join(prev) : '';
  } catch { return ''; }
}


const looksMachine = isMachineUrl;
export { isMachineUrl };


function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/* 摘要取证据原文的第一句，压到一行；不重写、不概括，避免替作者下结论。 */
function shorten(value, max = 70) {
  const s = text(value).replace(/\s+/g, ' ');
  if (!s) return '';
  const cut = s.search(/[。．.；;]/);
  const head = cut > 8 ? s.slice(0, cut) : s;
  return head.length > max ? head.slice(0, max).trimEnd() + '…' : head;
}

/* 排版与"哪些还没进简介"都由 reference-format 提供；这里转出，保持既有调用方不变。 */
export { referenceBlock, missingReferences };

/* 本模块只读不写：落盘统一在 reference-write，来源编排在 reference-sources。 */
