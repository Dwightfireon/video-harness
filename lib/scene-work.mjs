import fs from 'node:fs';
import path from 'node:path';
import { parseScript, parseChunks } from './state.mjs';
import { sceneDraftStatus, previousSceneVisualIntent } from './scene-drafts.mjs';
import { claimsDocumentState } from './claims.mjs';
import { authorDocumentState, sceneAuthoringState } from './author-readiness.mjs';
import { workflowPolicy } from './workflow-policy.mjs';
import { SDF_MODE, projectVisualMode, sdfAuthoringNote } from './scene-sdf.mjs';

/* 当前能力随请求尾注发送，旧检查点的 system 不改写，用户要求与工具历史不变。 */
export const SCENE_CAPABILITIES = `【当前分场工具说明】
以下是工具能力和现场状态，不是用户新要求；若用户补充要求先讨论、检查或不写入，须服从用户范围，不因本说明写入。
write_scene({scene: 场号, layout: "本场真实版式名（如流程图、双栏对照）", content: "root => { ...; return { render(t){} }; }"}) 只保存一场完整草稿；也可在 content 头部声明 // @layout 版式名。自动制作缺声明拒绝保存，不用场号冒充版式名。assemble_scenes({}) 在所有场次齐备后组装 scenes.src.js。不要一次生成整片代码。草稿由执行器计入真实进度。
visual_focus / visual_hierarchy / visual_restraint / visual_rhythm 是可选视觉意图；若填写则四项完整。不是必填审核表，不代替审片。按内容决定层级，允许留白与静止，不凑版式或动效数。
最小引擎接口：mk(tag, cls, html) 返回元素；abs(el,x,y,w,h) 返回定位后的元素；type(el,'h1'|'body'|'note') 设置字号；bg(root) 建背景；enter(el,t,at,{dy,blur,dur}) 入场。用 window.W/window.H 算坐标。line(text) 返回 {el,set(p)}，不是元素；frame(root,{eyebrow,page,source}) 返回 {eyebrow,hair,page,source} 元素。未知高级接口先不用，不能为了不必要的特效无限查模板。
布局约束：先用 VH_UI.safeArea() 确定正文区域，再安排标题、主体、来源；不要为每段文字独立猜 y 和盒高。harness 的标准 build 会在场景执行前提供 VH_LAYOUT.flow(root,{x,y,w,bottom,gap,id}) 与 VH_LAYOUT.grid(root,{x,y,w,bottom,gap,columns,id})：用 .add(元素,{id,minHeight}) 放内容，CSS 按实际换行与字号自动联动高度和间距，不需要手写相邻坐标。只用适合本场内容的布局，不用通用卡片代替机制演示。内容超出安全区必须调整布局或分步展示，不能靠裁字、删原文、无限缩字号蒙混过关。自定义组件可用 data-vh-component 命名；背景/纯装饰可用 data-vh-role="decoration"；只有叙事确需叠放才在对应元素上声明同名 data-vh-overlap，不能对整场加豁免。机器抽样不是审美验收。
动作只演示旁白中的变化，结束后留阅读时间。优先 const at = VH_FILM.sceneCue(root,'本场唯一句')，返回场内秒；不要手抄实测秒数。旧接口 VH_FILM.cue(SUBS,'唯一句') 返回全局秒，须减场起点；缺句/歧义不能吞错退回0秒。所有 render(t) 须支持直达、倒播与重新采样，不累加上一帧状态。不为刷分加 drift 或无关特效。高级 API 只在当前模板确认支持且内容需要时使用。
以下仅为语法骨架，不是当前内容的成片：root => { bg(root); const el = mk('div','','替换为本场具体对象'); type(el,'h1'); abs(el,window.W*.08,window.H*.3,window.W*.84,window.H*.3); root.appendChild(el); return {render(t){enter(el,t,0,{dy:20,dur:.6});}}; }`;

export function pendingSceneWork(project, mode) {
  if (!['article', 'topic'].includes(mode)) return null;
  try {
    if (!fs.existsSync(path.join(project, '方案.md'))) return null;
    if (!authorDocumentState(project, '方案.md').ok || !authorDocumentState(project, '脚本.md').ok) return null;
    if (workflowPolicy(project).claimsRequired && !claimsDocumentState(project).ok) return null;
    const scenes = parseScript(fs.readFileSync(path.join(project, '脚本.md'), 'utf8'));
    if (!scenes.length || scenes.some((s, i) => s.n !== i + 1)) return null;
    const drafts = sceneDraftStatus(project);
    if (drafts?.stale || drafts && drafts.count !== scenes.length) return null;
    if (!drafts && !sceneAuthoringState(project).needed && parseChunks(path.join(project, 'scenes.src.js')).length === scenes.length) return null;
    const scene = drafts ? drafts.missing[0] : 1;
    if (!scene) return null;
    const current = scenes[scene - 1];
    const text = current.lines.map(l => `${l.n}. ${l.t}`).join('\n');
    const previous = previousSceneVisualIntent(project, scene);
    return { scene, key: scene + ':' + current.title + ':' + text, note: SCENE_CAPABILITIES +
      (projectVisualMode(project) === SDF_MODE ? '\n' + sdfAuthoringNote : '') +
      (previous ? `\n【上一场已保存的视觉意图】${JSON.stringify(previous)}\n核对主体连续性与全片强弱，允许相同版式或有意对比；不自动沿用内容。` : '') +
      `\n【下一场 S${scene} · ${current.title}】\n` + (text.length <= 8000 ? text : text.slice(0, 8000) + '\n［本场原文节选；需要余文时按范围读脚本.md］') +
      '\n本场尚未保存；按原文制作具体对象，不复制语法骨架当成成品。写完整一场后，再继续下一场。' };
  } catch { return null; }
}
