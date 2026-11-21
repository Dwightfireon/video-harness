/* Formatting compatibility for the skill's strict **主体** parser.
 * Never infer a subject, split multiple subjects, or edit narration. */
import { readEditFile, patchText } from './author-edits.mjs';

const scene = /^ {0,3}##[ \t]*S\d+(?=\b|[·：:])/;
const placeholder = /^(?:[<＜〈《\[{【].*[>＞〉》\]}】]|(?:待定|待填|待补充|TODO|TBD|XXX|名字|名称|主体名|主体名称|示例|例如|填写主体|请填写).*)$/i;

function unbold(value) {
  // Only simple paired strong markers. Ambiguous escaped/code/nested markup is
  // left for author feedback, not guessed into a different subject name.
  if (/[`\\]/.test(value)) return value;
  return value.replace(/(?<!\*)\*\*([^\s*](?:[^*\r\n]*[^\s*])?)\*\*(?!\*)/g, '$1')
    .replace(/(?<![\w_])__([^\s_](?:[^_\r\n]*[^\s_])?)__(?![\w_])/g, '$1');
}

function subjectField(body) {
  const field = /^(?:主体|\*\*主体\*\*|__主体__)([ \t]*[：:][ \t]*)(.*)$/.exec(body);
  if (field) return { separator: field[1], value: field[2] };
  const boldColon = /^(\*\*|__)主体([ \t]*[：:])\1([ \t]*)(.*)$/.exec(body);
  if (boldColon) return { separator: boldColon[2] + boldColon[3], value: boldColon[4] };
  return null;
}

function normalizedHeader(text) {
  if (typeof text !== 'string') throw new TypeError('Script metadata must be text.');
  const lines = text.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
  const fields = [];
  let offset = 0, fence = null, end = text.length;
  for (const raw of lines) {
    const line = raw.replace(/\r?\n$/, '');
    // Up to three leading spaces and blockquote prefixes, but not indented code.
    const prefix = /^(\ufeff? {0,3}(?:> {0,3})*)(.*)$/.exec(line);
    const body = prefix?.[2] || '';
    if (fence) {
      const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(body);
      if (close && close[2][0] === fence.char && close[2].length >= fence.length) fence = null;
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
      if (open && (open[1][0] !== '`' || !open[2].includes('`'))) fence = { char: open[1][0], length: open[1].length };
      else if (scene.test(line.replace(/^\ufeff/, ''))) { end = offset; break; }
      else if (prefix) {
        // Recognize only an explicit metadata key, not prose mentioning 主体.
        const field = subjectField(body);
        if (field) fields.push({ offset, raw, prefix: prefix[1], ...field });
      }
    }
    offset += raw.length;
  }
  // Duplicate keys are ambiguous; leave them for author/checker feedback.
  if (fields.length !== 1) return { text, end };
  const field = fields[0], value = unbold(field.value);
  if (!value.trim() || placeholder.test(value.trim())) return { text, end };
  const ending = field.raw.endsWith('\r\n') ? '\r\n' : field.raw.endsWith('\n') ? '\n' : '';
  const replacement = field.prefix + '**主体**' + field.separator + value + ending;
  return { text: text.slice(0, field.offset) + replacement + text.slice(field.offset + field.raw.length),
    end, nextEnd: end + replacement.length - field.raw.length,
    subject: value.split(/[（(|｜]/)[0].trim().replace(/[，,。、·].*$/, '') };
}

/** Pure string helper for authoring tools. Names and their order remain exact. */
export function normalizeScriptMetadataText(text) {
  return normalizedHeader(text).text;
}

/** Generator and measured timeline accept only `1. text`, not `1、` / `1)`.
 * Reject unsupported author syntax before it can silently lose narration. */
export function scriptNumberingIssue(text) {
  let inScene = false, fence = null;
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue; }
    if (fence) continue;
    if (/^##\s*S\d+\b/.test(line)) { inScene = true; continue; }
    if (/^##\s+/.test(line)) { inScene = false; continue; }
    if (inScene && /^\s*\d+[、)]\s*\S/.test(line)) return '旁白编号须统一为「1. 正文」（半角点号后有空格）；生成器不识别「1、」或「1)」，请保留原句并只修正编号，不能省略这句旁白';
  }
  return null;
}

/** Same subject/opening contract as the skill, checked before draft submission
 * so a known content problem does not consume a later build repair round. */
export function scriptSubjectIssue(text, { opening: requireOpening = true } = {}) {
  const header = normalizedHeader(text);
  if (!header.subject) return '脚本头部须明确写 主体：<讲解对象>；不能用占位符、代码示例或重复字段代替';
  if (!requireOpening) return null;
  const opening = header.text.slice(header.nextEnd).split('\n')
    .filter(line => /^\s*\d+\.\s+/.test(line)).slice(0, 2);
  if (!opening.some(line => line.includes(header.subject))) return `主体字段声明「${header.subject}」，但前两句没有完整点名。保留全部比较对象，在开场明确引入这个名称组合，措辞须与字段一致；不要为了过检查删掉对象`;
  return null;
}

/** CAS + original-byte backup; invalid UTF-8 and symlinks fail closed even on no-op. */
export function normalizeScriptMetadata(project) {
  let first;
  try { first = readEditFile(project, '脚本.md', { max_lines: 1000 }); }
  catch (error) {
    if (error.code === 'ENOENT') return { changed: false, backup_path: null, missing: true };
    throw error;
  }
  let text = first.content;
  for (let start = 1000; start < first.total_lines; start += 1000) {
    const page = readEditFile(project, '脚本.md', { start_line: start, max_lines: 1000 });
    if (page.base_hash !== first.base_hash) throw Object.assign(new Error('Script changed while reading metadata; no write performed.'), { code: 'STALE_BASE_HASH' });
    text += page.content;
  }
  const normalized = normalizedHeader(text);
  if (normalized.text === text) return { changed: false, backup_path: null };
  // Exact header context prevents a matching field in a scene/example being edited.
  return patchText(project, '脚本.md', { base_hash: first.base_hash,
    find: text.slice(0, normalized.end), replace: normalized.text.slice(0, normalized.nextEnd) });
}
