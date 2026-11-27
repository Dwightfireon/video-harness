/* 统一内容定位纯函数契约：零 I/O、零跨模块依赖。
 *
 * 职责边界：
 *   - 只负责「前沿情报（intel） / 科学科普（science） / 观点思辨（opinion）」三档枚举、纯文本/元数据推断、
 *     以及写稿与审校提示词的纯数据拼装。
 *   - 不读写磁盘（PROJECT.json / schedule.json / materials），不依赖发现层、队列层或服务层。
 */

export const CONTENT_PROFILES = Object.freeze(['auto', 'intel', 'science', 'opinion']);
export const RESOLVED_PROFILES = Object.freeze(['intel', 'science', 'opinion']);

export const CONTENT_PROFILE_LABELS = Object.freeze({
  auto: '自动判断',
  intel: '前沿情报（重时效与准确）',
  science: '科学科普（重机制与通透）',
  opinion: '观点思辨（重立场与逻辑）',
});

const STALE_INTEL_MS = 24 * 60 * 60 * 1000;

/* 前沿情报信号：近期事件、新发布、财报/政策变动、突发争议等 */
const INTEL_CUES = /(?:刚刚(?:发布|宣布|开源|上线|推出|曝光|回应)|最新(?:发布|进展|动态|政策|财报|消息|版本|突破|回应|争议|数据|通报)|本周|本月|近日|昨日|昨天|今日|今天|突发|正式发布|新发布|官宣|辟谣|反转|202[5-9]\s*年\s*(?:1[0-2]|0?[1-9])\s*月|\b(?:breaking|just\s+(?:released|launched|announced)|latest\s+(?:release|update|policy))\b)/i;

/* 观点思辨与方法论信号：主观评价、价值取舍、审美文化批评、个人/职场方法论、哲学思辨 */
const OPINION_CUES = /(?:怎么看|如何看待|值不值得|为什么我(?:不再|建议|放弃|选择|反对|坚持)|被高估|被低估|伪需求|审美|文化批评|影评|书评|漫谈|随笔|行业观察|个人体会|工作方法论|创作方法论|人生取舍|职场取舍|商业思考|意义感|价值判断|价值取舍|伦理困境|自由意志|存在主义|功利主义|义务论|相容论|认识论|形而上学|哲学|康德|尼采|维特根斯坦|罗尔斯)/i;

/* 硬核实证/自然科学机制信号：避免带“为什么”的科学实验题误落入纯主观观点 */
const HARD_EMPIRICAL_CUES = /(?:实验测量|对照组|置信区间|冷冻电镜|反应机理|定理证明|基因编辑|构象变化|随机对照|双盲|样本量|\b(?:CRISPR|cryo-EM|RCT|p-value)\b)/i;

/* 快速迭代的 AI/技术信号：仅用于决定是否在 science 档提示早期大模型年代限定 */
const TECH_ERA_CUES = /(?:\b(?:LLM|GPT|AI|ML|arXiv|benchmark|RLHF|transformer|diffusion|RAG|agent|Llama|Claude|Gemini|ChatGPT|OpenAI|Anthropic|DeepMind)\b|机器学习|深度学习|大模型|大语言|人工智能|智能体)/i;

export function validContentProfile(value) {
  return CONTENT_PROFILES.includes(value);
}

export function validResolvedProfile(value) {
  return RESOLVED_PROFILES.includes(value);
}

export function normalizeContentProfile(value, fallback = 'auto') {
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return validContentProfile(clean) ? clean : fallback;
}

/**
 * 从简报、素材或 方案.md 中提取调查核查时间与显式定位标记（纯字符串解析，兼容 Markdown 列表/加粗）。
 */
export function extractBriefMetadata(text = '') {
  const s = String(text || '');
  const profileMatch = s.match(/^(?:[-*>]\s*)?(?:\*\*|__)?内容定位(?:\*\*|__)?\s*[：:]\s*`?(intel|science|opinion)`?(?:\b|[\s（(])/im);
  const dateMatch = s.match(/^材料核查日期\s*[：:]\s*(\d{4}-\d{2}-\d{2})(?:\s*（checkedAt=(\d+)）)?/m);
  let checkedAt = 0;
  if (dateMatch?.[2]) checkedAt = Number(dateMatch[2]) || 0;
  else if (dateMatch?.[1]) {
    const parsed = Date.parse(dateMatch[1] + 'T00:00:00Z');
    if (Number.isFinite(parsed)) checkedAt = parsed;
  }
  return {
    explicitProfile: profileMatch ? profileMatch[1].toLowerCase() : null,
    checkedDate: dateMatch?.[1] || null,
    checkedAt,
  };
}

/**
 * 判断输入是否已由上游调查模型或显式参数锁定了定位。
 */
export function hasExplicitUpstreamProfile({ explicit = '', text = '' } = {}) {
  const exp = typeof explicit === 'string' ? explicit.trim().toLowerCase() : '';
  if (validResolvedProfile(exp)) return true;
  const s = String(text || '');
  if (extractBriefMetadata(s).explicitProfile) return true;
  return /^材料类型\s*[：:]\s*(?:新闻进展|观点与思辨|深度材料)/m.test(s);
}

/**
 * 纯函数：结合显式指定、材料类型、发现模式、学科标签与文本语义，解析最终生效的三档定位。
 * @returns {'intel' | 'science' | 'opinion'}
 */
export function resolveContentProfile({
  explicit = '',
  kind = '',
  discoveryMode = '',
  discipline = '',
  text = '',
} = {}) {
  const exp = typeof explicit === 'string' ? explicit.trim().toLowerCase() : '';
  if (validResolvedProfile(exp)) return exp;

  if (kind === 'news' || discoveryMode === 'recent') return 'intel';
  if (kind === 'opinion' || discipline === 'opinion' || discipline === 'philosophy') return 'opinion';

  const body = String(text || '');
  const meta = extractBriefMetadata(body);
  if (meta.explicitProfile) return meta.explicitProfile;
  if (/^材料类型\s*[：:]\s*新闻进展/m.test(body)) return 'intel';
  if (/^材料类型\s*[：:]\s*观点与思辨/m.test(body)) return 'opinion';

  if (INTEL_CUES.test(body) && kind !== 'evergreen') return 'intel';
  if (OPINION_CUES.test(body) && !HARD_EMPIRICAL_CUES.test(body)) return 'opinion';

  return 'science';
}

/**
 * 纯函数：生成写稿阶段的定位专属口径段落。
 */
export function contentProfileGuidance(profile, { checkedAt = 0, now = Date.now(), text = '' } = {}) {
  if (profile === 'intel') {
    const freshChecked = checkedAt > 0 && (now - checkedAt) <= STALE_INTEL_MS;
    const recheckRule = freshChecked
      ? '材料在近 24 小时内刚核查过：优先精读已保存的原文记录（若简报提供 recordPath，可直接读取核对原始数字、条款与上下文），仅在关键细节缺失时补搜。'
      : `材料${checkedAt > 0 ? '上次核查距今已超过 24 小时' : '尚未记录近期核查时间'}：动笔定方案前，请先用 1–2 次轻量联网检索确认该动态截至今日有无最新进展、官方回应、数据修正或事件反转，避免把旧状态或已被辟谣的消息当当下事实播出。`;
    return [
      '【内容定位：intel · 前沿情报（越新越准优先）】',
      recheckRule,
      '口播须自然交代时间锚点（如「就在这周」「截至目前的公开实测」），把事件来龙去脉与核心变化讲准；严格区分「官方发布会/宣传口径」与「独立第三方实测结果」，未证实传闻不得写成定论。',
    ].join('\n');
  }

  if (profile === 'opinion') {
    return [
      '【内容定位：opinion · 观点思辨与方法论（立场鲜明、逻辑自洽优先）】',
      '允许采用鲜明的第一人称视角或明确的价值取舍，不必把观点片写成面面俱到的学术综述或论文报告。',
      '严守两条底线：①「客观事实前提」与「主观判断」分离——凡引用的具体事件、数据、规则或他人原话必须真实准确，不得编造或曲解；主观推论用自然口语（如「在我看来」「这背后的真正取舍其实是…」）坦诚表达，不把个人判断伪装成普适客观定律；② 拒绝空喊口号与竖稻草人靶子——每个核心观点都要落到具体生活/行业情境或真实案例上，公允呈现反方最有力的顾虑再给出你的理由。',
    ].join('\n');
  }

  const techEraNote = TECH_ERA_CUES.test(String(text || '')) || !text
    ? '讲述 AI/技术演进或引用过往论文实验时，严禁把 2023–2024 年早期模型（如 GPT-4、GPT-3.5、Claude 2 等）的测试表现直接当成当下现状来念；若资料源自早期论文，口播中必须显式带出实验年代或阶段限定（如「在 2023 年那批早期测试里」），并对照后续进展说明如今是否依然成立。'
    : '经典研究与长期机制不强求近期年份，但若学界后续已有重要修正或边界限定，须用一句大白话交代清楚。';
  return [
    '【内容定位：science · 科学知识与深度机制（通透与因果优先）】',
    '不设热点时效焦虑，重点搭好概念台阶、讲透「为什么会这样」的中间作用过程（若简报提供 recordPath 原文记录，写稿时可直接读取核对实验条件与数字）。区分观察相关性、机制假说与干预效果，说明结论成立的前提条件与适用边界。',
    techEraNote,
  ].join('\n');
}

/**
 * 纯函数：面向写稿入口（composeTask）自适应生成定位指令。
 * - 若上游调查模型或显式参数已锁定定位，直接输出对应单档指令，并要求写入 方案.md；
 * - 若是用户直接粘贴的裸文章/一句话想法（auto），指导写稿模型读完全文后做语义级三选一并在 方案.md 落一行标记，零额外请求打通下游审校。
 */
export function authoringProfilePrompt({ explicit = '', checkedAt = 0, now = Date.now(), text = '' } = {}) {
  const locked = hasExplicitUpstreamProfile({ explicit, text });
  if (locked) {
    const profile = resolveContentProfile({ explicit, text });
    return [
      contentProfileGuidance(profile, { checkedAt, now, text }),
      `写 方案.md 时请在开头写一行「内容定位：${profile}」，供后续独立文稿审校自动对齐标尺。`,
    ].join('\n');
  }

  const hint = resolveContentProfile({ text });
  return [
    `【内容定位：全自动语义识别（初步倾向：${hint}，以你通读全文/调研后的实质判断为准）】`,
    '读完材料后，先按内容本质在 方案.md 顶部单独写一行「内容定位：intel」（或 science / opinion），再严格按所选档位写稿（下游审校会自动读取这一行切换标尺）：',
    '- 若属 intel（前沿情报/近期事件/新发布/政策财报变动）：动笔前先用 1–2 次轻搜确认截至今日有无最新进展、官方回应或反转；口播自然带出时间锚点，严格区分「官方宣传口径」与「第三方实测」。',
    '- 若属 science（科学知识/技术底层机理/长期规律）：不设热点时效焦虑，搭好概念台阶、讲透中间作用机制与实验/统计边界（涉及 AI/大模型演进时，2023–2024 早期模型实验须标明年代）。',
    '- 若属 opinion（主观观点/商业文化评论/职场与个人方法论）：允许鲜明第一人称立场与价值取舍，不必写成学术综述；但「客观事实前提」必须准确，每个核心观点须落到具体情境或案例并公允回应反方顾虑，严禁空喊口号与打稻草人。',
  ].join('\n');
}

/**
 * 纯函数：生成独立文稿审校（script-review）按档位差异化的标尺与维度说明。
 */
export function reviewProfileRules(profile, { checkedAt = 0, date = '' } = {}) {
  const year = String(date || '').slice(0, 4) || '当前';
  if (profile === 'opinion') {
    return {
      scaleNote: '【本片审校标尺：opinion · 观点思辨与方法论】允许鲜明主观立场与第一人称视角，严禁用实证论文或随机对照实验模板苛求观点片！请将审校重心放在：① 所引用的客观事实、数据或他人原话前提是否失真；② 论证是否逻辑自洽，有无偷换概念、滑坡谬误或竖稻草人靶子硬批；③ 是否整场空喊抽象口号/鸡汤而缺乏具体情境或真实案例支撑。',
      causalityRule: '2. causality（论证链条与逻辑自洽吗）：每场开头是否自然承接上一场的追问；核心论点到结论之间是否有具体案例、现实取舍或推理支撑，还是只靠情绪口号硬推；有无偷换概念、以偏概全或竖稻草人靶子攻击反方。',
      accuracyRule: '3. accuracy（客观事实前提与引述准确吗）：主观价值判断无需强求中立，但凡脚本中引用的具体事件、统计数字、历史事实或他人观点必须与资料一致、不得捏造或断章取义；严禁把个人主观推论伪装成已被科学实验证实的客观定律（若出现此类硬伤标为 severity="high"）。',
    };
  }

  if (profile === 'intel') {
    const checkedLabel = checkedAt > 0 ? `（本地材料核查日期：${new Date(checkedAt).toISOString().slice(0, 10)}）` : '';
    return {
      scaleNote: `【本片审校标尺：intel · 前沿情报】重时效与准确性：核查口播是否交代了清晰的时间锚点与事件先后；是否把厂商单方宣传稿、未证实传闻直接念成了既定事实；数字与条款是否严格贴合下方资料。${checkedLabel}`,
      causalityRule: '2. causality（前因后果清楚吗）：每场开头是否自然接住了上一场留下的疑问，还是突然跳去报「某年某项研究」或逐条念规格表让人摸不着头脑；场与场之间是否因果跳步；有没有把相关直接说成因果；有没有把多篇报道或参数先逐个念一遍、后半段又按指标重念一遍造成重复串烧。',
      accuracyRule: `3. accuracy（事实、口径与时效性准确吗）：对照下方方案与调研资料，事件日期、数字、比较基准与结论强度是否一致；关键动态是否交代了时间锚点（严禁把旧进展或传闻当成今日刚证实的定论来念，也严禁把官方宣传口径冒充独立第三方实测）；当前已是 ${year} 年，若涉及 AI/大模型，严禁把 2023–2024 年早期模型（如 GPT-4、GPT-3.5、Claude 2、Llama 2）的旧实验直接当成当下现状来念，违者标为 severity="high" 并给出改法。`,
    };
  }

  return {
    scaleNote: '【本片审校标尺：science · 科学知识与深度机制】重概念台阶与因果机制：核查为什么会这样的中间过程是否讲透，实验条件与适用边界是否清楚；经典科学原理与奠基研究不因发表年份较早而扣分（仅快速迭代的 AI/大模型旧实验须标明年代）。',
    causalityRule: '2. causality（前因后果清楚吗）：每场开头是否自然接住了上一场留下的疑问，还是突然跳去报「某年某项研究」或逐条念规格表让人摸不着头脑；场与场之间是否因果跳步；有没有把相关直接说成因果；有没有把多篇研究或模型先逐个念一遍、后半段又按指标重念一遍造成重复串烧。',
    accuracyRule: `3. accuracy（事实、口径与时效性准确吗）：对照下方方案与调研资料，数字、分母、比较基准、时间范围与结论强度是否一致；有没有把预印本、单平台或受控实验夸大成通用定论；经典科学原理不苛求近期年份，但当前已是 ${year} 年，若涉及 AI/大模型，严禁把 2023–2024 年早期模型（如 GPT-4、GPT-3.5、Claude 2、Llama 2）的旧实验直接当成当下现状来念，未标明实验年代且未交代后续进展的须标为 severity="high" 并给出补齐年代限定的改法。`,
  };
}
