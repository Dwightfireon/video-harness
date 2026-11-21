/* 简介里的参考资料排版与"哪些还没进简介"。纯函数：不读盘、不联网、不认识项目。
 *
 * 单独一层的原因：写入（reference-write）与发布页预览（publish-api）
 * 都要用同一套排版和 2000 字上限，不能各写一份。
 */
import { urlIdentity, isMachineUrl } from './url-identity.mjs';

const urlPattern = /https?:\/\/[^\s，。；、」）]+/g;
export const REFERENCES_HEADING = '参考资料';

/* 简介里的参考段落。默认按条数截断，让「列了哪些」可预期；
 * 再由 mergeIntoDescription 按总长裁剪。 */
export function referenceText(sources, { heading = REFERENCES_HEADING, max = 20 } = {}) {
  const list = (sources || []).slice(0, max);
  if (!list.length) return '';
  const lines = list.map(item => `· ${item.label ? item.label + '\n' : ''}${item.url}`);
  return `${heading}\n\n${lines.join('\n\n')}`;
}

/* 把参考段落拼到已有简介后面，保持在字数上限内。返回 { text, added, dropped }。
 * 超限时整条丢弃，绝不截断单条链接。 */
export function mergeIntoDescription(desc, sources, { limit = 2000, heading, max } = {}) {
  const base = String(desc || '').trim();
  if (!sources?.length) return { text: base, added: 0, dropped: 0, capDropped: 0, roomDropped: 0 };
  const cap = max ?? 20;
  let count = Math.min(sources.length, cap);
  let block = referenceText(sources, { heading, max: count });
  while (count > 0 && base.length + 2 + block.length > limit) {
    count--;
    block = referenceText(sources, { heading, max: count });
  }
  if (!count) return { text: base, added: 0, dropped: sources.length, cap: Math.min(sources.length, cap), capDropped: Math.min(sources.length, cap), roomDropped: Math.max(0, sources.length - cap) };
  // 两种「没放进去」要分开说：条数上限是有意设计，字数上限才需要人删短简介。
  const capDropped = Math.max(0, sources.length - cap);
  return { text: `${base}\n\n${block}`, added: count, dropped: sources.length - count,
    cap, capDropped, roomDropped: Math.max(0, sources.length - count - capDropped) };
}

/* 简介里已经出现过的链接（用统一身份比较，doi:/doi.org/尾斜杠视为同一条）。 */
export function presentInDescription(desc) {
  return new Set((String(desc || '').match(urlPattern) || []).map(urlIdentity));
}

/* 哪些来源还没出现在简介里。用于预览与"还有几条没进简介"的提示。 */
export function missingReferences(desc, sources) {
  const present = presentInDescription(desc);
  return (sources || []).filter(item => !present.has(urlIdentity(item.url)));
}

/* 可粘贴的纯文本块：与写入用的是同一套排版，标题一致。 */
export function referenceBlock(sources, { heading = REFERENCES_HEADING, max = 20 } = {}) {
  return referenceText(sources, { heading, max });
}

/* 点开不是文章的地址，提示调用方在输出里标注。 */
export function machineUrls(sources) {
  return (sources || []).map(item => item.url).filter(isMachineUrl);
}

/* 简介里已有参考段落的起始行（没有则 -1）。写入与预览共用，避免两处判断不同。 */
export function existingHeadingLine(desc, heading = REFERENCES_HEADING) {
  const lines = String(desc || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() === heading) return i;
  return -1;
}
