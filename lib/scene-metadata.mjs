/* The scene authoring tool and build checker share the same metadata contract.
 * Do not invent a layout from a scene number or silence an absent declaration. */
import { readVisualIntent, normalizeVisualIntent, visualIntentTag } from './scene-visual.mjs';

export function withSceneMetadata(content, { layout, visual, required = false } = {}) {
  if (typeof content !== 'string') throw new Error('场景 content 必须是文本');
  if (layout !== undefined && (typeof layout !== 'string' || !layout.trim() || layout.length > 80 || /[\r\n@]/.test(layout))) {
    throw new Error('layout 必须是单行真实版式名，最多 80 字符，不能嵌入其他标签');
  }
  const body = content.trim();
  const leading = body.match(/^(?:\s*\/\/[^\n]*(?:\n|$))*/)?.[0] || '';
  const declared = [...leading.matchAll(/^[ \t]*\/\/[ \t]*@layout[ \t]+([^\r\n@]+)/gm)].map(m => m[1].trim().replace(/[·\s]+$/, ''));
  if (declared.length > 1) throw new Error('一场只能声明一个 @layout；请核对真实版式后重新保存');
  if (declared[0] && layout && declared[0] !== layout.trim()) throw new Error('layout 参数与场景头部 @layout 不一致；未覆盖作者声明');
  if (!declared[0] && !layout && required) throw new Error('缺少本场版式声明：用 write_scene({scene,layout:"流程图/双栏对照等真实版式名",content:"root => {...}"})，或在 content 头部写 // @layout 版式名；不要等到整片 build 才补');
  const existing = readVisualIntent(body);
  if (existing.status === 'invalid') throw new Error(existing.error);
  const supplied = visual === undefined ? null : normalizeVisualIntent(visual);
  if (supplied && existing.intent && JSON.stringify(supplied) !== JSON.stringify(existing.intent)) {
    throw new Error('视觉意图参数与场景头部 @visual 不一致；未覆盖作者声明');
  }
  const prefix = [];
  if (!declared[0] && layout) prefix.push('// @layout ' + layout.trim());
  if (supplied && !existing.intent) prefix.push(visualIntentTag(supplied));
  return prefix.length ? prefix.join('\n') + '\n' + body : body;
}
