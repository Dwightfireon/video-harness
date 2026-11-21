/* 任务提示词：把「这一轮要做什么」写成模型读得懂的段落。
 *
 * 为什么独立成文件：本地 agent 循环（lib/agent.mjs）和 opencode 派发
 * （lib/runners/opencode.mjs）都要用同一套口径。放在 vh.mjs 里会让两个
 * runner 都去 import 一个 3000 行的 CLI 入口，耦合反过来。
 */
import { PUBLISH_TASK } from './publish.mjs';
import { SDF_MODE, projectVisualMode, sdfAuthoringNote } from './scene-sdf.mjs';

const EXPLANATION = '主体首现说它做了什么或经历什么；用必要例子讲清条件、变化与结果，不只列数字。假设/简化算例明说设定条件，不当实测；统计数字说清对象、单位、范围与比较基准，比例交代分母。方案中影响结论的关键限定要进入旁白；区分观察结果、机制假说与干预效果，不跨来源硬拼证据，证据不足收窄结论。默认不限时长，已有显式上限保留；不为凑分钟数删必要解释，也不设例子或动作配额。\n';
const VISUAL = '画面优先同一对象的状态变化，保留位置/编号/颜色参照；曲线近旁直接标注名称、单位与必要条件，示意不当实测，旁白不反复读标题。用已有 SVG、transform/opacity 与 VH_FILM.sceneCue，不增加重型 FX/3D、默认素材搜索或降低画质。\n';

export const TASK_PROMPTS = {
  'edit-copy': '【任务：只生成或修复发布文案，不重做视频】\n' + PUBLISH_TASK + '\n',
  article: '【任务：把一篇现成文章/稿子做成讲解视频】\n' +
    '先读 materials/ 或消息中的原文，沿原文主题、判断与论述顺序写方案，保留必要解释与出处。\n' +
    '再写完整编号旁白；不要为字幕字数删掉推导，不继承旧题材造型。\n' + EXPLANATION + VISUAL +
    '按当前工作流与阶段工具推进；不自行增加多版试稿、审核表或诊断循环。发布文案仅按交付目标补齐。\n' +
    '首个完整可用版本立即给路径，说明实测与未验证范围；生成截图不等于看过，机器检查不等于试听或事实核证。\n',
  topic: '【任务：给一个选题，自己调研成文再出片】\n' +
    '围绕观众的问题定向调研，保存资料并收敛范围；查不到就说明缺口，不编造来源。\n' +
    '先建立可靠、连贯的解释，再写方案与完整旁白，最后制作必要画面。关键事实保留出处与口径。\n' + EXPLANATION + VISUAL +
    '阶段由执行器推进，只补失效步骤；不为形式评分、两版试稿或审核手续扣住首个可交付版本。\n',
  edit: '【任务：修改现有片子】\n' +
    '只落实用户要求；改讲述就修旁白及必要对应画面，只改画面不动原稿，只改文案不重做视频。\n' +
    '执行器按真实输入判定最少失效阶段并安全增量；不默认整片重渲、重测、清缓存或重新审核。\n',
  'edit-visual': '【任务：只改画面】\n只修改 scenes.src.js 与 engine.tpl.html，不动 脚本.md / 方案.md。改完 build 并给出静帧路径。\n',
  'edit-script': '【任务：只改讲述】\n只修改 脚本.md（必要时同步 scenes.src.js 里对应的字幕与画面），不动 方案.md。\n',
};

export const TASK_MODES = Object.freeze(Object.keys(TASK_PROMPTS));

/* 派发给 runner 的完整指令：固定规则 + 本轮具体要求 + 用户原话。
 * 用户原话单独一段，不并进规则里——模型需要分清「规矩」和「这次要什么」。
 * 最后一行保持 `用户的指令是：\n<原话>` 的既有约定，不额外加空行：
 * 调用方按这个分隔取值核对真实输入。 */
export function composeTask({ project, repo, mode, message, policyNote = '' }) {
  const base = TASK_PROMPTS[mode] || TASK_PROMPTS.edit;
  return [
    `你在视频项目 \`${project}\` 里干活；仓库根目录是 \`${repo}\`（vh.mjs 在这一层）。`,
    '制作命令统一用 `node vh.mjs <命令> --dir ' + project + '`。',
    policyNote,
    base,
    mode !== 'edit-copy' && projectVisualMode(project) === SDF_MODE ? sdfAuthoringNote : '',
    '用户的指令是：\n' + message,
  ].filter(Boolean).join('\n\n');
}
