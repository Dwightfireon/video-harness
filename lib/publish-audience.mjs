/* 发布文案的「观众可见」检查。
 *
 * 为什么单独一层：标题、简介、置顶评论、标签、封面会原样出现在平台上；
 * 取材过程、抓取失败、核证状态、文件路径、工具名属于项目内部记录，
 * 观众既看不懂也不该看到。判断放在这里攒成纯函数，生成提示词与机械检查
 * 引用同一套口径，避免各写一份、越改越偏。
 *
 * 只做字面识别，不判断语义、不改写。命中表示「这段像内部记录」。
 *
 * 分三档，避免误伤题材本身：
 *   1. artifacts —— 文件名、目录、工具名。公开文案里没有合理用途，一律算错。
 *   2. process   —— 明确的取材结果叙述（未取得正文、未采用某来源、已被质询）。
 *                  简介与置顶评论会整段公开，算错；短字段只提示。
 *   3. soft      —— 可能只是题材词（提示词、抓取、模型返回）。只提示，不拦。
 *                  视频本身就在讲这些词，把它当错误会挡住正常发布。
 */
import { BILIBILI_LIMITS } from './publish-limits.mjs';

const ARTIFACTS = [
  /\b(?:claims\.json|PROJECT\.json|schedule\.json|timing\.json|subtitle-review\.json)\b/,
  /* 中文句子里「脚本.md」前面常是汉字，\b 在汉字与字母间不成立，
   * 所以只要求前面不是字母、数字或下划线，不额外要求词边界。 */
  /(?<![\w])(?:发布文案|脚本|方案|审查)\.md/,
  /\b(?:scenes\.src\.js|engine\.tpl\.html|scene\.html|opencode\.jsonc?)\b/,
  /(?:^|[\s(（])(?:research|materials|out|dist|projects)\/[^\s，。；、)）]+/,
  /out\/\.vh-[\w.-]+/,
  /\b(?:webfetch|websearch|vh\.mjs)\b/i,
  /\b(?:taskId|attemptId|sessionId|discoveryId)\b/,
];

/* opencode 既是本仓库的执行器名，也可能是影片题材里的产品名。
 * 只有"谁在做这支片子"的写法才算内部记录；点名产品、贴它的官方链接不算。 */
const EXECUTOR_CONTEXT = [
  /(?:用|由|通过|交给|调用|让)\s*(?:opencode|OpenCode)\s*(?:跑|来跑|执行|生成|写|补|做)/,
  // 中文后面不加 \b：汉字与汉字之间不构成词边界。
  /(?:opencode|OpenCode)\s*(?:会话|服务|执行器|runner)/i,
  /\b(?:VH_RUNNER|VH_OPENCODE_BIN)\b/,
];

/* 取材结果的明确叙述。讲主题时不会写"我没取得正文、因此不作为依据"。 */
const PROCESS = [
  /未取得(?:正文|原文)/, /没(?:有)?(?:取得|读到)(?:正文|原文)/, /抓取失败/, /读取失败/,
  /被\s*Cloudflare\s*(?:质询|验证|拦截)/i, /连接重置/,
  /未采用[^\n。；]{0,20}来源/, /(?:未|不)作为任何[^\n。；]{0,20}依据/,
  /未核证/, /已(?:抓|读)到(?:全文|原文)/,
  /待人工审阅/, /不代表(?:已)?(?:核实|核证|事实)/,
];

/* 可能是题材本身的说法：只在提示里提一句，不拦发布。 */
const SOFT = [
  /抓取/, /提示词/, /模型(?:自报|返回|输出)/, /人工审阅/, /核证/,
  /本条(?:为|由)程序(?:补充|生成)/,
];

export const AUDIENCE_FIELDS = Object.freeze({
  main: '标题', alts: '备选标题', desc: '简介', comment: '置顶评论', cover: '封面文案', tags: '标签',
});
/* 会整段公开、且几乎总是照搬内部记录的长字段。 */
const LONG_FIELDS = new Set(['desc', 'comment']);

/* 取最早的命中，而不是列表里第一条命中的规则：
 * 一句话里常同时有「未采用来源」和「没取得正文」，报最靠前的那段更像用户看到的原文。 */
function firstMatch(text, patterns) {
  let best = null;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) best = { index: match.index, text: match[0] };
  }
  return best?.text ?? null;
}

/* 公开字段里出现内部记录的命中项。 */
export function audienceLeaks(copy) {
  const found = [];
  for (const field of Object.keys(AUDIENCE_FIELDS)) {
    const raw = copy?.[field];
    const text = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
    if (!text.trim()) continue;
    const artifact = firstMatch(text, ARTIFACTS);
    const executor = firstMatch(text, EXECUTOR_CONTEXT);
    if (artifact || executor) { found.push({ tier: 'artifact', field, match: artifact || executor }); continue; }
    const process = firstMatch(text, PROCESS);
    if (process) { found.push({ tier: 'process', field, match: process }); continue; }
    const soft = firstMatch(text, SOFT);
    if (soft) found.push({ tier: 'soft', field, match: soft });
  }
  return found;
}

/* 变成检查结果：artifacts 一律错；process 在长字段算错，短字段提示；soft 只提示。
 * 文案要能照着改，所以消息里给出命中片段与正确去处。 */
export function audienceIssues(copy) {
  const errors = [], warnings = [];
  for (const leak of audienceLeaks(copy)) {
    const label = AUDIENCE_FIELDS[leak.field] || leak.field;
    const where = '取材过程、抓取失败、来源采用与弃用、核证状态、待审提醒写到项目文件（如 `## 素材与数字（可核）` 或 claims.json），不进入公开文案。';
    if (leak.tier === 'artifact') {
      errors.push({ code: 'internal-artifact', field: leak.field,
        message: `${label}会公开展示，不应出现项目内部文件名、路径或工具名：「${leak.match}」。` + where });
    } else if (leak.tier === 'process' && LONG_FIELDS.has(leak.field)) {
      errors.push({ code: 'internal-process', field: leak.field,
        message: `${label}会原样公开，不应叙述取材与核证过程：「${leak.match}」。` + where + '改成观众能直接理解的内容。' });
    } else if (leak.tier === 'process') {
      warnings.push({ code: 'internal-process', field: leak.field,
        message: `${label}里出现取材叙述：「${leak.match}」。若这里是制作记录而非内容，请移出公开字段。` });
    } else {
      warnings.push({ code: 'possible-process', field: leak.field,
        message: `${label}里出现「${leak.match}」：如果是在讲题材本身没问题；如果是制作过程描述，请移出公开字段。` });
    }
  }
  return { errors, warnings };
}
