/* 只缩减发给模型的投影；完整消息、工具参数和结果仍留在检查点。
 *
 * 设计要点：
 * - 早期逐轮生成"回执"会随轮数线性膨胀（真实事故：134 条回执本身占了 176 KB）。
 *   这里改成：只保留最近 N 个工具轮次完整内容，更早的统一折叠成一份有上限的工作台账。
 * - 用户消息（原始要求与全部补充）按原顺序保留，不摘要、不删除。
 * - 签名/加密推理、最新轮次、最近工具参数与结果不改；不制造孤立工具消息。
 */
import { toolOutcome } from './tool-result.mjs';

export const CONTEXT_TARGET_BYTES = 192 * 1024;
export const KEEP_RECENT_TURNS = 8;
/* 保留区的硬上限（超过才折叠一次）。
 * 这是"省钱"与"安全"的平衡点，按 1085 轮真实历史实测选定：
 *   台账 4000 字 + 保留区 48KB → 缓存生效 $0.87、缓存没生效 $4.54
 *   （修复前：缓存生效 $3.90、没生效 $4.19）
 * 即：缓存生效时省 78%；缓存没生效时最多贵 8%，不会失控。
 * 保留区再放大（96KB→$5.4、192KB→$7.6、384KB→$11.9）收益递减、
 * 风险陡增，不值得赌"缓存一定生效"——账单还没核实过。 */
export const CONTEXT_HARD_LIMIT_BYTES = 48 * 1024;
/* 台账上限（字符数）。台账的用途是"别重做已经做过的事"，
 * 写入清单 + 失败清单 + 最近判断就够；24000 字符在中文下约 72KB，
 * 每轮都要重发，是仅次于原始要求的大头。 */
export const LEDGER_MAX_CHARS = 4000;
const RECENT_TOOL_MAX_CHARS = 4000;

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const plainReasoning = new Set(['reasoning', 'reasoning_content']);
const opaque = value => value && typeof value === 'object' &&
  (value.type === 'reasoning.encrypted' || value.signature || value.encrypted || value.encrypted_content ||
    value.type === 'redacted_thinking' || value.type === 'reasoning.summary' && value.encrypted);

const short = (value, limit) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? oneLine.slice(0, limit) + '…' : oneLine;
};

function callSignature(call) {
  let args = {};
  try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
  const name = call.function?.name || 'unknown';
  const key = args.path || args.url || args.command ||
    (args.content != null ? '[正文 ' + String(args.content).length + ' 字符]' : '');
  return { name, key: short(key, 110) };
}

function resultOutcome(content) {
  return short(toolOutcome(content).summary, 240);
}

/* 把一段较早的历史折叠成台账行：同签名调用合并计数，避免逐轮累积。 */
function foldRounds(messages, start, end) {
  const rounds = new Map();
  const results = new Map(messages.slice(start, end).filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]));
  let assistantText = [];
  for (let i = start; i < end; i++) {
    const message = messages[i];
    if (message.role === 'assistant') {
      if (message.content) assistantText.push(short(message.content, 160));
      for (const call of message.tool_calls || []) {
        const sig = callSignature(call);
        const key = sig.name + ':' + sig.key;
        if (!rounds.has(key)) rounds.set(key, { name: sig.name, key: sig.key, count: 0, outcome: '', id: call.id });
        rounds.get(key).count++;
        rounds.get(key).id = call.id;
        rounds.get(key).lastIndex = i;
        const content = results.get(call.id);
        if (content != null) {
          rounds.get(key).outcome = resultOutcome(content);
          rounds.get(key).failed = !toolOutcome(content).ok;
        }
      }
    }
  }
  return { rounds, assistantText };
}

function renderLedger({ rounds, assistantText, foldedTurns }) {
  const lines = ['【历史工作台账（自动压缩，不是新指令；详情省略不等于没做，完整记录在本机检查点）】',
    `较早的 ${foldedTurns} 轮已折叠进本台账；其后的轮次逐条完整保留。`,
    '重复调用已合并计数。不要因为这里没写全就重做，先只读核对现有文件。'];
  // 优先保住写入/失败与最近现场，读取不能挤掉后期产出。逐行预算，不从最早前缀硬截。
  const entries = [...rounds.values()].sort((a, b) =>
    Number(b.name === 'write_file') - Number(a.name === 'write_file') ||
    Number(!!b.failed) - Number(!!a.failed) || b.lastIndex - a.lastIndex);
  const judgments = assistantText.slice(-6).map(text => '- ' + text);
  const suffix = judgments.length ? '\n\n当时的判断（节选；不是已验证的完成状态）：\n' + judgments.join('\n') : '';
  const budget = LEDGER_MAX_CHARS - suffix.length - 100;
  if (entries.length) lines.push('', '较早动作摘要（写入与失败优先，其余由近到远）：');
  let used = lines.join('\n').length, omitted = 0;
  for (const entry of entries) {
    const line = '- ' + entry.name + '(' + entry.key + ')' + (entry.count > 1 ? ' ×' + entry.count : '') +
      (entry.outcome ? ' → ' + entry.outcome : '');
    if (used + line.length + 1 > budget) { omitted++; continue; }
    lines.push(line); used += line.length + 1;
  }
  if (assistantText.length) {
    lines.push(suffix);
  }
  let ledger = lines.join('\n');
  if (omitted) ledger += `\n…［省略 ${omitted} 项较低优先级历史；完整记录在本机检查点］`;
  return ledger;
}

export function prepareRequestContext(messages, {
  targetBytes = CONTEXT_TARGET_BYTES, keepRecentTurns = KEEP_RECENT_TURNS, tailNote = '',
  stableAnchor = 0, hardLimitBytes = CONTEXT_HARD_LIMIT_BYTES, omitLatestPlainReasoning = false,
} = {}) {
  if (!Number.isFinite(targetBytes) || targetBytes <= 0) throw new Error('请求上下文目标无效');
  if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 1) throw new Error('保留轮次必须为正整数');
  if (!Number.isFinite(hardLimitBytes) || hardLimitBytes <= 0) throw new Error('保留区上限无效');
  if (!Number.isInteger(stableAnchor) || stableAnchor < 0) throw new Error('稳定锚点必须是非负整数');
  const beforeBytes = bytes(messages);
  let removedReasoning = 0;
  const assistantIndices = messages.flatMap((m, i) => m.role === 'assistant' ? [i] : []);
  const latestAssistant = assistantIndices.at(-1) ?? -1;

  // 历史纯文本推理无需反复发送；最新轮次与签名/加密块保留。
  const projected = messages.map((message, index) => {
    if (message.role !== 'assistant' || index === latestAssistant &&
      !(omitLatestPlainReasoning && !message.tool_calls?.length)) return message;
    const next = { ...message };
    if (next.content === null && !(next.tool_calls || []).length) {
      // Streaming gateways may emit an empty assistant delta before a later
      // user notice. It is not a valid request turn; drop it from the projection
      // rather than asking upstream to validate an empty message.
      next.content = '';
    }
    for (const key of plainReasoning) {
      if (typeof next[key] === 'string' || next[key] === null) {
        if (key in next) { delete next[key]; removedReasoning++; }
      }
    }
    if (Array.isArray(next.reasoning_details)) {
      const retained = next.reasoning_details.filter(item => opaque(item) ||
        !['reasoning.text', 'reasoning.summary'].includes(item?.type));
      removedReasoning += next.reasoning_details.length - retained.length;
      if (retained.length) next.reasoning_details = retained; else delete next.reasoning_details;
    }
    return next;
  });

  const totalTurns = projected.filter(m => m.role === 'assistant' && m.tool_calls?.length).length;
  const keepFromTurn = Math.max(0, totalTurns - keepRecentTurns);
  // 找到"需要保留的第一轮"在数组中的位置；其后原样保留。
  let seenTurns = 0, cutIndex = projected.length;
  for (let i = 0; i < projected.length; i++) {
    if (projected[i].role === 'assistant' && projected[i].tool_calls?.length) {
      if (seenTurns >= keepFromTurn) { cutIndex = i; break; }
      seenTurns++;
    }
  }
  // 不能切在工具结果中间：确保 cutIndex 落在 assistant 或 user 边界。
  while (cutIndex > 0 && projected[cutIndex]?.role === 'tool') cutIndex--;

  /* 折叠边界 = 稳定锚点，**只增不减**。
   *
   * 前缀缓存命中的是"从第 0 个 token 起的连续相同段"。要让命中率高，
   * 相邻两轮的投影必须满足"后者 = 前者 + 末尾追加"，而不是"窗口整体右移"。
   *
   * 所以这里不按"最近 N 轮"切（那是滑动窗口，每轮整体右移一位，
   * 窗口内每条消息的位置都变 → 公共前缀只到窗口起点，实测仅 5%），
   * 而是按**字节预算 + 稳定锚点**切：
   *   - 保留区（锚点之后）超出预算时，锚点**一次性右移到位**，
   *     把超出部分折叠进台账；
   *   - 未超预算时锚点不动，新轮次**追加**在保留区末尾。
   *
   * 代价是：右移的那一轮前缀会断一次。换来的是其余所有轮次都命中，
   * 比"每轮都断"划算得多。
   */
  const FOLD_TARGET_BYTES = targetBytes;
  let anchorIndex = stableAnchor;
  let anchorTurns = 0;
  {
    /* 保留区 = [anchorIndex, 末尾)：**只增不减**。
     *
     * 前缀缓存命中的是"从第 0 个 token 起的连续相同段"。要让命中率高，
     * 相邻两轮的请求必须满足"后者 = 前者 + 末尾追加"。
     *
     * 本文件把请求分成三段：
     *   ① system（逐字节稳定）
     *   ② 原始要求 user（逐字节稳定）
     *   ③ 台账（只依赖已折叠历史；锚点不变时逐字节稳定）
     *   ④ 保留区：锚点之后的全部轮次（**只增不减**）
     *   ⑤ 末尾：现场（每轮变，但只在末尾）
     *
     * ①②③ 恒定命中缓存；④ 每轮只追加、不滑动 → 前缀完整命中；
     * ⑤ 断了也只影响它自己。
     *
     * ⚠ 保留区大小是**省钱与安全的平衡点**，必须按实测选，不能拍脑袋：
     *   - 缓存生效时：保留区几乎全按缓存价（$0.006/M），越大越省；
     *   - 缓存没生效时：保留区全按输入价（$0.3/M），越大越贵。
     * 上限越小，最坏情况越接近"原来的裁剪行为"，越不会因缓存失效而失控。
     */
    const size = new Array(projected.length + 1).fill(0);
    for (let i = projected.length - 1; i >= 0; i--) size[i] = size[i + 1] + bytes([projected[i]]);

    // 轮次位置：用于"至少保留 N 轮"的保底。
    const turnPositions = [];
    for (let i = 0; i < projected.length; i++) {
      if (projected[i].role === 'assistant' && projected[i].tool_calls?.length) turnPositions.push(i);
    }
    // 保底：无论预算多紧，最近 keepRecentTurns 轮必须原样保留。
    // 否则单条超大工具结果（write_file 参数可达几百 KB）会把保留区整个吃掉，
    // 模型看不见任何近期工具结果 —— 那是功能损坏，不是省钱。
    const keepFromIdx = turnPositions.length > keepRecentTurns
      ? turnPositions[turnPositions.length - keepRecentTurns] : 0;

    // 硬上限：保留区不得超过 hardLimitBytes（默认见 CONTEXT_HARD_LIMIT_BYTES）。
    // 超了才把锚点一次性右移到位（那一次断前缀，之后继续只增不减）。
    const keptBytes = size[Math.min(anchorIndex, projected.length)];
    if (keptBytes > hardLimitBytes) {
      /* 一次性退到**上限的一半**处，而不是刚好装下上限。
       * 若每次只挪一点，锚点每轮都在动 → 台账每轮都变 → 缓存全废。
       * 退到一半处，下一次折叠要再积累半个上限才发生，
       * 中间所有轮次都是逐字节稳定的前缀。 */
      const SOFT = Math.floor(hardLimitBytes / 2);
      let c = Math.min(anchorIndex, projected.length);
      for (let i = c; i <= projected.length; i++) {
        if (i < projected.length && projected[i].role === 'tool') continue;   // 会留下孤立 tool
        if (size[i] <= SOFT) { c = i; break; }
      }
      /* 签名/加密推理不能被折叠掉：渠道要求把加密块原样回传，
         丢了会导致请求被拒（invalid_messages）。切点不能越过它。 */
      const signed = projected.findIndex(m => m.role === 'assistant' &&
        (m.reasoning_details || []).some(item => opaque(item)));
      if (signed >= 0 && signed < c) {
        let k = signed;
        while (k > 0 && projected[k - 1].role === 'tool') k--;
        c = k;
      }
      // 保底：不能折叠掉最近 keepRecentTurns 轮。
      if (c > keepFromIdx) c = keepFromIdx;
      if (c > anchorIndex) anchorIndex = c;
    }
    anchorTurns = projected.slice(anchorIndex).filter(m => m.role === 'assistant' && m.tool_calls?.length).length;
  }

  const oldPart = projected.slice(0, anchorIndex);
  const recentPart = projected.slice(anchorIndex);
  const systemMessage = projected.find(m => m.role === 'system');
  const oldUsers = oldPart.filter(m => m.role === 'user');
  // 原始要求与补充要求必须保留；第一条用户消息由调用方单独保留在会话开头。
  const foldedTurns = oldPart.filter(m => m.role === 'assistant' && m.tool_calls?.length).length;

  let requestMessages = projected;
  let ledgerChars = 0, folded = false;
  let ledgerTail = '';
  if (foldedTurns > 0 && oldPart.length) {
    const { rounds, assistantText } = foldRounds(messages, 0, anchorIndex);
    /* 台账只依赖**已折叠的那段历史**（oldPart），不含任何每轮变化的计数。
     * 这样台账在锚点不变时逐字节稳定 → 可以放在中间而不破坏前缀缓存。 */
    const ledger = renderLedger({ rounds, assistantText, foldedTurns });
    ledgerChars = ledger.length;
    ledgerTail = ledger;
    const built = [];
    // system 保持逐字节不变：台账一旦并进 system，前缀缓存从第 0 个 token 就全部失效，
    // 后面整段上下文每轮都按 $0.3/M 全价计费，而不是 $0.006/M。
    if (systemMessage) built.push({ role: 'system', content: systemMessage.content });
    else built.push({ role: 'system', content: '你是 vh（视频 harness）里的制作 agent。' });
    // 折叠区内的多条用户要求合并成一条，避免连续 user 消息被严格接口拒绝。
    const userText = oldUsers.map(u => u.content).filter(Boolean).join('\n\n');
    if (userText) built.push({ role: 'user', content: userText });
    /* 台账放在**原始要求之后、保留区之前**：
     * 它在中间位置，但因只依赖已折叠历史而逐字节稳定，
     * 所以它后面的保留区照样命中缓存。
     * （放在末尾也可以，但末尾还要放每轮变的"现场"，两者会叠在一起。） */
    built.push({ role: 'user', content: ledger });
    // recentPart 以 assistant 边界开始，不会重复 system / 用户消息。
    requestMessages = [...built, ...recentPart];
    folded = true;
  }

  /* "现场"（本轮执行记录）放在**消息列表最末尾**的一条 user 消息里。
   *
   * 前缀缓存按"从第 0 个 token 开始的连续相同段"命中。
   * system、原始要求、台账都逐字节稳定 → 它们后面的内容照样命中缓存；
   * 现场每轮都变（写了哪些文件、跑了哪些命令），所以放最末尾，
   * 只有它自己（几 KB）按全价计费。
   *
   * ⚠ 必须挂在**末尾**，不能挂中间某条 user 消息：
   * 挂中间会让"从该位置到结尾"的整段每轮失效，缓存等于没有；
   * 更糟的是，长任务里最后一条 user 可能就是原始要求那条，
   * 挂上去等于每轮改写用户原文。
   *
   * 末尾追加 user 消息是本 harness 已在用的形式（用户插话就是 user 消息，
   * 且出现在 tool 结果之后），协议与各渠道都验证过。
   */
  const tailParts = [];
  if (tailNote) tailParts.push(tailNote);
  if (tailParts.length) {
    const last = requestMessages[requestMessages.length - 1];
    // 末尾若是带 tool_calls 的 assistant，它的工具结果还没出现，
    // 这时插 user 会打断配对；退回到挂最后一条 user 消息。
    const pendingCalls = last && last.role === 'assistant' && (last.tool_calls || []).length;
    if (!pendingCalls) {
      requestMessages = [...requestMessages, { role: 'user', content: tailParts.join('\n\n') }];
    } else {
      const at = requestMessages.findLastIndex(m => m.role === 'user');
      if (at >= 0) {
        requestMessages = requestMessages.map((message, index) =>
          index === at ? { ...message, content: message.content + '\n\n' + tailParts.join('\n\n') } : message);
      } else {
        requestMessages = requestMessages.map((message, index) =>
          index === 0 ? { ...message, content: message.content + '\n\n' + tailParts.join('\n\n') } : message);
      }
    }
  }

  // 近期工具结果过长时截断（保留头尾与状态），避免单个结果撑爆请求。
  const compacted = new Set();
  requestMessages = requestMessages.map((message, index) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    // 最近一次工具批次不截：保证重读能够取回中间片段，不再一面截断一面说“就在上面”。
    if (index > requestMessages.findLastIndex(m => m.role === 'assistant' && m.tool_calls?.length) ||
        message.content.length <= RECENT_TOOL_MAX_CHARS) return message;
    const content = message.content.slice(0, Math.floor(RECENT_TOOL_MAX_CHARS / 4)) + '\n…［中间省略…］…\n' +
      message.content.slice(-Math.floor(RECENT_TOOL_MAX_CHARS * 3 / 4));
    compacted.add(index);
    return { ...message, content };
  });

  // Empty assistant messages carry no content or tool call and are not a valid
  // dialogue turn on strict gateways. Remove them from the SEND projection only;
  // the checkpoint still preserves every recorded message.
  requestMessages = requestMessages.filter((message, index) =>
    !(message.role === 'assistant' && !message.tool_calls?.length &&
      (message.content == null || message.content === '') && index > 0 && index < requestMessages.length - 1));
  const afterBytes = bytes(requestMessages);
  return {
    // 有任何改动（去推理、折叠、节选、末尾追加现场）都必须返回投影。
    // 漏掉"末尾追加"这一项会让未折叠的短对话把现场丢掉。
    messages: removedReasoning || folded || compacted.size || tailParts.length ? requestMessages : messages,
    beforeBytes, afterBytes, removedReasoning,
    compactedResults: compacted.size, compactedGroups: foldedTurns,
    folded: folded, ledgerChars, targetBytes, overTarget: afterBytes > targetBytes,
    tailAppended: tailParts.length > 0,
    // 下一轮把锚点传回来：折叠区只增不减，公共前缀才能一直延伸到上一轮末尾。
    stableAnchor: anchorIndex,
  };
}
