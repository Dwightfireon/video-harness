/* 把参考链接写进 `## 简介` 末尾的唯一实现。
 *
 * 只做三件事：定位简介小节、按字数上限挑条目、追加。不认识来源从哪来，
 * 由调用方把已收集好的 sources 传进来——这样 claims / 脚本 / materials /
 * research 可以走同一段写入逻辑，不会各写一次、标题还不一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { urlIdentity } from './url-identity.mjs';
import { REFERENCES_HEADING, referenceText, mergeIntoDescription, presentInDescription, existingHeadingLine } from './reference-format.mjs';

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
export { REFERENCES_HEADING, referenceText, mergeIntoDescription };

/* 写入。只做加法：不改任何已有文字，只往简介末尾补一段；重复调用不重复加。 */
export function writeReferences(project, sources, { heading = REFERENCES_HEADING, max = 20, limit = 2000 } = {}) {
  const file = path.join(project, '发布文案.md');
  const md = read(file);
  const available = Array.isArray(sources) ? sources.length : 0;
  if (!md.trim()) return { ok: false, reason: 'missing-copy', added: 0, available };
  if (!available) return { ok: true, added: 0, reason: 'no-sources', available: 0 };

  const lines = md.split('\n');
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const h = /^##\s*(.+?)\s*$/.exec(lines[i]);
    if (!h) continue;
    if (start < 0 && h[1].includes('简介')) { start = i; continue; }
    if (start >= 0) { end = i; break; }
  }
  if (start < 0) return { ok: false, reason: 'no-desc-section', added: 0, available };

  const desc = lines.slice(start + 1, end).join('\n').trim();
  const present = presentInDescription(desc);
  const missing = sources.filter(item => !present.has(urlIdentity(item.url)));
  if (!missing.length) return { ok: true, added: 0, reason: 'already-present', available };

  /* 已经有参考段落时接着往里加，不再另起一个同名标题——
   * 否则"先补 claims、再补脚本"就会在简介里写出两段参考资料。 */
  const descLines = desc ? desc.split('\n') : [];
  const headingAt = existingHeadingLine(desc, heading);
  let merged;
  if (headingAt >= 0) {
    const before = descLines.slice(0, headingAt).join('\n').replace(/\s+$/, '');
    const existingBlock = descLines.slice(headingAt).join('\n').replace(/\s+$/, '');
    const used = Math.max(0, existingBlock.split(/\n{2,}/).length - 1);
    const additions = missing.map(item => `· ${item.label ? item.label + '\n' : ''}${item.url}`);
    const cap = max ?? 20;
    const roomByCount = Math.max(0, cap - used);
    let count = Math.min(additions.length, roomByCount);
    while (count > 0 && before.length + 2 + existingBlock.length + 2 + additions.slice(0, count).join('\n\n').length > limit) count--;
    merged = count
      ? { text: `${before}\n\n${existingBlock}\n\n${additions.slice(0, count).join('\n\n')}`, added: count,
        dropped: missing.length - count, cap: Math.max(cap, used + count),
        capDropped: Math.max(0, missing.length - count - Math.max(0, additions.length - roomByCount)),
        roomDropped: Math.max(0, Math.min(additions.length, roomByCount) - count) }
      : { text: desc, added: 0, dropped: missing.length, cap, capDropped: Math.max(0, additions.length - roomByCount),
        roomDropped: Math.max(0, Math.min(additions.length, roomByCount)) };
  } else {
    merged = mergeIntoDescription(desc, missing, { limit, heading, max });
  }
  if (!merged.added) return { ok: true, added: 0, reason: 'no-room', dropped: merged.dropped,
    capDropped: merged.capDropped, roomDropped: merged.roomDropped, available };

  const next = [...lines.slice(0, start + 1), '', merged.text, '', ...lines.slice(end)];
  fs.writeFileSync(file, next.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return { ok: true, added: merged.added, dropped: merged.dropped, available,
    capDropped: merged.capDropped ?? 0, roomDropped: merged.roomDropped ?? 0,
    urls: missing.slice(0, merged.added).map(i => i.url) };
}
