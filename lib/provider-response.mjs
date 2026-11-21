/* OpenAI 兼容的 JSON / SSE 响应。只在完整结束后交付工具调用，不执行半截参数。 */
// Incremental equivalent of /(?:^|\n)data:\s*\[DONE\]\r?\n(?:\r?\n|$)/.
// Keep only matching state, not the growing response or an unbounded partial
// line. Whitespace, CRLF and the marker may all straddle transport chunks.
function doneScanner() {
  let state = 'ignore', index = 0, lineStart = true;
  return chunk => {
    for (let offset = 0; offset < chunk.length; offset++) {
      // Ordinary JSON event payloads cannot contain the anchored marker.
      // Skip their remainder in native code instead of visiting every byte.
      if (state === 'ignore' && !lineStart) {
        const newline = chunk.indexOf('\n', offset);
        if (newline < 0) return false;
        offset = newline; lineStart = true;
        continue;
      }
      const char = chunk[offset];
      if ((state === 'end' || state === 'end-cr') && char === '\n') return true;
      if (lineStart && char === 'd') { state = 'prefix'; index = 1; }
      else if (state === 'prefix') {
        if (char !== 'data:'[index++]) state = 'ignore';
        else if (index === 5) state = 'space';
      } else if (state === 'space') {
        if (char === '[') { state = 'marker'; index = 1; }
        else if (!/\s/.test(char)) state = 'ignore';
      } else if (state === 'marker') {
        if (char !== '[DONE]'[index++]) state = 'ignore';
        else if (index === 6) state = 'newline';
      } else if (state === 'newline') {
        state = char === '\r' ? 'cr' : char === '\n' ? 'end' : 'ignore';
      } else if (state === 'cr') state = char === '\n' ? 'end' : 'ignore';
      else if (state === 'end') state = char === '\r' ? 'end-cr' : 'ignore';
      else state = 'ignore';
      lineStart = char === '\n';
    }
    // The old matcher accepts the first newline if it ends the received text;
    // don't wait for server EOF (some gateways leave completed streams open).
    return state === 'end';
  };
}
export async function readResponseText(response, { signal, onChunk = () => {}, limit = 32 * 1024 * 1024 } = {}) {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const scanDone = /text\/event-stream/i.test(response.headers.get('content-type') || '') ? doneScanner() : null;
  let text = '', bytes = 0, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => { rejectAbort(signal.reason); reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength; onChunk(value.byteLength);
      if (bytes > limit) { await reader.cancel(); throw Object.assign(new Error('响应超过允许大小'), { code: 'VH_RESPONSE_TOO_LARGE' }); }
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      if (scanDone?.(chunk)) {
        await reader.cancel(); break;
      }
    }
    return text + decoder.decode();
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}

/* 仅白名单诊断元数据跨越边界；不保存流、半截工具参数或上游原始异常。 */
export class ResponseParseError extends Error {
  constructor(code, { finishReason = null, toolCount = 0, streamComplete = false } = {}) {
    super(({ output_truncated: '工具调用被输出上限截断', incomplete_stream: '流式响应未完整结束',
      invalid_tool_arguments: '工具参数格式无效', missing_tool_identity: '工具调用缺少身份或名称',
      malformed_sse: '流式事件格式无效' })[code] || '响应格式无效');
    this.name = 'ResponseParseError';
    this.code = code;
    this.finishReason = ['length', 'stop', 'tool_calls'].includes(finishReason) ? finishReason : null;
    this.toolCount = Math.max(0, Math.min(100, toolCount));
    this.streamComplete = !!streamComplete;
  }
}

export function parseChatSSE(text) {
  let content = '', reasoning = '', finish = null, usage, sawChoice = false, done = false;
  const calls = new Map();
  for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data.trim() === '[DONE]') { done = true; break; }
    let part;
    try { part = JSON.parse(data); }
    catch { throw new ResponseParseError('malformed_sse', { finishReason: finish, toolCount: calls.size, streamComplete: done }); }
    if (part.error) throw Object.assign(new Error('流式接口返回错误'), { apiError: part.error });
    if (part.usage) usage = part.usage;
    const choice = part.choices?.find(c => c.index === 0) || part.choices?.[0];
    if (!choice) continue;
    sawChoice = true;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const fragment of delta.tool_calls || []) {
      if (!Number.isInteger(fragment.index) || fragment.index < 0) throw new ResponseParseError('missing_tool_identity', { finishReason: finish, toolCount: calls.size, streamComplete: done });
      const call = calls.get(fragment.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (fragment.id) call.id += fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      calls.set(fragment.index, call);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (!sawChoice || (!done && !finish)) throw new ResponseParseError('incomplete_stream', { finishReason: finish, toolCount: calls.size, streamComplete: done });
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  if (finish === 'length' && toolCalls.length) throw new ResponseParseError('output_truncated', { finishReason: finish, toolCount: toolCalls.length, streamComplete: done });
  for (const call of toolCalls) {
    if (!call.id || !call.function.name) throw new ResponseParseError('missing_tool_identity', { finishReason: finish, toolCount: toolCalls.length, streamComplete: done });
    try { JSON.parse(call.function.arguments); }
    catch { throw new ResponseParseError('invalid_tool_arguments', { finishReason: finish, toolCount: toolCalls.length, streamComplete: done }); }
  }
  return { choices: [{ message: { role: 'assistant', content: content || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

/* 非流式兼容渠道同样不能把不完整的工具调用交给执行器。 */
export function validateChatResponse(data) {
  const choice = data?.choices?.[0], msg = choice?.message;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) ||
    (msg.content != null && typeof msg.content !== 'string') ||
    (msg.tool_calls != null && !Array.isArray(msg.tool_calls))) throw new ResponseParseError('invalid_response');
  const calls = msg.tool_calls || [], meta = { finishReason: choice.finish_reason, toolCount: calls.length, streamComplete: true };
  if (choice.finish_reason === 'length' && calls.length) throw new ResponseParseError('output_truncated', meta);
  for (const call of calls) {
    if (typeof call?.id !== 'string' || !call.id || typeof call?.function?.name !== 'string' || !call.function.name ||
        typeof call.function.arguments !== 'string') throw new ResponseParseError('missing_tool_identity', meta);
    try { JSON.parse(call.function.arguments); }
    catch { throw new ResponseParseError('invalid_tool_arguments', meta); }
  }
  return data;
}
