/* Visual intent is author metadata, not a rendering instruction or waiver.
 * Keep it in the scene chunk so drafts, edits and source fingerprints travel
 * together. No dependence on a renderer, agent or review storage. */
import fs from 'node:fs';
import path from 'node:path';

export const VISUAL_FIELDS = Object.freeze(['focus', 'hierarchy', 'restraint', 'rhythm']);

export function normalizeVisualIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('视觉意图须包含焦点、层级、取舍和节奏');
  if (Object.keys(value).some(key => !VISUAL_FIELDS.includes(key))) throw new Error('视觉意图包含未知字段');
  const result = {};
  for (const key of VISUAL_FIELDS) {
    const text = value[key];
    if (typeof text !== 'string' || !text.trim() || text.length > 160 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) {
      throw new Error(`视觉意图 ${key} 必须为不超过 160 字的非空单行文本`);
    }
    result[key] = text.trim();
  }
  return result;
}

// Only the leading comment block is metadata. Do not parse text within scene
// code, other comments, or a template literal as an author declaration.
export function readVisualIntent(chunk) {
  const leading = String(chunk).trim().match(/^(?:\s*\/\/[^\n]*(?:\n|$))*/)?.[0] || '';
  const tags = [...leading.matchAll(/^[ \t]*\/\/[ \t]*@visual(?:[ \t]+([^\r\n]*))?[ \t]*$/gm)];
  if (!tags.length) return { status: 'missing', intent: null };
  if (tags.length !== 1) return { status: 'invalid', intent: null, error: '一场只能声明一个 @visual' };
  // HTML parses script data even inside JS comments: raw "</script" can end
  // it and "<!-- <script" can alter the parser state. Use JSON escapes.
  if ((tags[0][1] || '').includes('<')) return { status: 'invalid', intent: null, error: '@visual 不能含字面量 <；请使用工具参数或 JSON Unicode 转义' };
  try {
    return { status: 'declared', intent: normalizeVisualIntent(JSON.parse(tags[0][1] || '')) };
  } catch (error) {
    return { status: 'invalid', intent: null, error: `@visual 无效：${error.message}` };
  }
}

export function visualIntentTag(value) {
  return '// @visual ' + JSON.stringify(normalizeVisualIntent(value)).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

// Heuristic source checkers should inspect scene code, not treat an intent
// description as a CSS rule, media reference, number or rendered object.
// Only remove a leading metadata comment; never touch strings or scene code.
export function stripVisualIntent(chunk) {
  const text = String(chunk);
  const leading = text.match(/^(?:\s*\/\/[^\n]*(?:\n|$))*/)?.[0] || '';
  return leading.replace(/^[ \t]*\/\/[ \t]*@visual(?:[ \t]+[^\r\n]*)?[ \t]*$/gm, '') + text.slice(leading.length);
}

export function stripVisualIntents(source) {
  return String(source).split(/(^\/\/---\s*$)/m).map(part => part.startsWith('//---') ? part : stripVisualIntent(part)).join('');
}

export function collectVisualIntents(project) {
  let source;
  try { source = fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', scenes: [], note: '没有 scenes.src.js；视觉意图尚未声明' };
    throw error;
  }
  const chunks = source.split(/^\/\/---\s*$/m).map(chunk => chunk.trim()).filter(Boolean);
  const scenes = chunks.map((chunk, index) => ({ scene: index + 1, ...readVisualIntent(chunk) }));
  return { status: 'unreviewed', scenes,
    note: '声明只记录创作意图；没有检查画面是否做到，也不豁免技术检查。' };
}

export function visualIntentSummary(result) {
  const lines = ['视觉意图（作者声明，未验证实际画面）：'];
  if (!result.scenes.length) lines.push('  ' + (result.note || '没有场景'));
  // The complete list remains in the JSON report. Keep CLI/agent context
  // bounded for long videos instead of pasting hundreds of scene records.
  for (const scene of result.scenes.slice(0, 20)) {
    if (scene.status === 'missing') lines.push(`  S${scene.scene}：未声明；旧项目不受阻断。`);
    else if (scene.status === 'invalid') lines.push(`  S${scene.scene}：${scene.error}；请核对作者注释。`);
    else {
      const i = scene.intent;
      lines.push(`  S${scene.scene} 焦点：${i.focus}；层级：${i.hierarchy}`);
      lines.push(`      取舍：${i.restraint}；节奏：${i.rhythm}`);
    }
  }
  if (result.scenes.length > 20) lines.push(`  其余 ${result.scenes.length - 20} 场见 out/.vh-visual-review.json。`);
  lines.push('  结合静帧和连续预览核对：第一眼能否看到焦点？删去装饰是否更清楚？动作与停顿是否服务讲述？');
  lines.push('  声明不代表已审阅；未降低版式、字幕、对比度等技术门槛。');
  return lines.join('\n');
}
