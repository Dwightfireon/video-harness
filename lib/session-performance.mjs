/* Read-only V2 message projection analysis. No text, reasoning, tool payloads,
 * raw errors, model IDs, child sessions, tokens or credentials leave this module.
 * API timestamps are milliseconds; reported durations are seconds. */
export const RESPONSE_INTERVAL_LABEL = '助手响应区间（含模型/渠道/网络/客户端，不是纯推理或首字延迟）';
export const SESSION_PERFORMANCE_SCOPE = '计数按所选消息（含首尾）；区间取当前会话所有与时间窗相交的记录并裁切，含边界前已开始的任务。仅分析当前会话投影，不读取或相加子会话。工具与助手区间可能并发或嵌套，不能相加；重叠与未覆盖只针对已测区间。未覆盖含用户空闲、调度和缺测，不能归因模型。没有首字延迟、纯推理耗时或 token 速度；不推断首次交付。retry 是当前投影快照，不保证保留全部历史重试。';

export class SessionAuditError extends Error {
  constructor(code) { super(code); this.name = 'SessionAuditError'; this.code = code; }
}
const fail = code => { throw new SessionAuditError(code); };
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const present = value => value !== undefined && value !== null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const seconds = ms => ms / 1000;
const increment = (counts, key) => { Object.defineProperty(counts, key, { value: (Object.hasOwn(counts, key) ? counts[key] : 0) + 1, enumerable: true, writable: true, configurable: true }); };
const FINISHES = new Set(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown']);
const TYPES = new Set(['agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic', 'system', 'skill', 'shell', 'assistant', 'compaction', 'idle']);

/* Categorize only structured metadata, never search an error message/body. An
 * unrecognized type is deliberately not copied into the diagnostic output. */
function errorCategory(error) {
  const type = typeof error?.type === 'string' ? error.type.toLowerCase() : '';
  if (error?.status === 429 || ['rate-limit', 'ratelimiterror', 'rate_limit_error'].includes(type)) return 'rate-limit';
  if ([401, 403].includes(error?.status) || ['authentication', 'authenticationerror', 'unauthorized'].includes(type)) return 'authentication';
  if ([408, 504].includes(error?.status) || ['timeout', 'timeouterror'].includes(type)) return 'timeout';
  if (['abort', 'aborted', 'aborterror', 'cancelled'].includes(type)) return 'cancelled';
  if (['network', 'networkerror', 'connectionerror', 'provider.transport'].includes(type)) return 'network';
  if (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599) return 'server';
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 499) return 'request';
  return 'unknown';
}

function validateTimes(time, keys) {
  if (!object(time)) return;
  for (const key of keys) if (present(time[key]) && !timestamp(time[key])) fail('invalid-timestamp');
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    if (timestamp(time[keys[i]]) && timestamp(time[keys[j]]) && time[keys[j]] < time[keys[i]]) fail('reversed-interval');
  }
}

export function validateSessionMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) fail('empty-or-invalid-messages');
  const ids = new Set(); let previous = -1;
  for (const message of messages) {
    if (!object(message) || typeof message.id !== 'string' || !/^msg_[A-Za-z0-9_-]+$/.test(message.id) || typeof message.type !== 'string') fail('invalid-message');
    if (ids.has(message.id)) fail('duplicate-message');
    ids.add(message.id);
    if (!timestamp(message.time?.created)) fail('missing-message-created');
    if (message.time.created < previous) fail('unordered-messages');
    previous = message.time.created;
    validateTimes(message.time, ['created', 'streamed', 'completed']);
    if (message.type === 'assistant') {
      if (present(message.content) && !Array.isArray(message.content)) fail('invalid-assistant-content');
      for (const part of message.content || []) {
        if (!object(part)) fail('invalid-assistant-content');
        if (part.type === 'tool') validateTimes(part.time, ['created', 'ran', 'completed']);
      }
      if (present(message.retry) && (!object(message.retry) || !Number.isInteger(message.retry.attempt) || message.retry.attempt < 1 || !timestamp(message.retry.at))) fail('invalid-retry');
    }
  }
  return messages;
}

function merge(intervals) {
  const result = [];
  for (const [start, end] of intervals.toSorted((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const length = intervals => intervals.reduce((total, [a, b]) => total + b - a, 0);
function clip(interval, start, end) {
  const a = Math.max(interval[0], start), b = Math.min(interval[1], end);
  return b > a || (a === b && interval[0] === interval[1] && a >= start && a <= end) ? [a, b] : null;
}

function countsFor(messages, aliases) {
  const result = { messages: messages.length, messageTypes: {}, assistantMessages: 0, finishes: {}, finishMissing: 0,
    finishErrors: 0, assistantErrors: {}, retryRecords: 0, retryAttemptMaximum: null, retryErrors: {}, tools: {}, toolErrors: {}, models: {},
    missing: { assistantStreamed: 0, assistantCompleted: 0, assistantContent: 0, model: 0, toolRan: 0, toolCompleted: 0, toolName: 0 } };
  for (const message of messages) {
    increment(result.messageTypes, TYPES.has(message.type) ? message.type : 'other');
    if (message.type !== 'assistant') continue;
    result.assistantMessages++;
    if (!present(message.finish)) result.finishMissing++;
    else increment(result.finishes, FINISHES.has(message.finish) ? message.finish : 'unknown');
    if (message.finish === 'error') result.finishErrors++;
    if (present(message.error)) increment(result.assistantErrors, errorCategory(message.error));
    if (message.retry) {
      result.retryRecords++;
      result.retryAttemptMaximum = Math.max(result.retryAttemptMaximum || 0, message.retry.attempt);
      increment(result.retryErrors, errorCategory(message.retry.error));
    }
    const alias = aliases.get(message.id);
    if (alias) increment(result.models, alias); else result.missing.model++;
    if (!timestamp(message.time.streamed)) result.missing.assistantStreamed++;
    if (!timestamp(message.time.completed)) result.missing.assistantCompleted++;
    if (!Array.isArray(message.content)) result.missing.assistantContent++;
    for (const part of message.content || []) {
      if (part.type !== 'tool') continue;
      // Names are the only tool metadata emitted, never input/state content.
      const name = typeof part.name === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(part.name) ? part.name : '(unknown)';
      if (name === '(unknown)') result.missing.toolName++;
      increment(result.tools, name);
      if (part.state?.status === 'error') increment(result.toolErrors, errorCategory(part.state.error));
      if (!timestamp(part.time?.ran)) result.missing.toolRan++;
      if (!timestamp(part.time?.completed)) result.missing.toolCompleted++;
    }
  }
  return result;
}

function intervalStats(messages, start, end) {
  const assistant = [], tools = [];
  let missingAssistant = 0, missingTools = 0, unknownToolCollections = 0;
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const created = message.time.created;
    // An incomplete message may still overlap the selected window. A message
    // known to have completed before it cannot contribute missing coverage.
    const mayOverlap = created <= end && (!timestamp(message.time.completed) || message.time.completed >= start);
    if (timestamp(message.time.streamed)) {
      const interval = clip([created, message.time.streamed], start, end);
      if (interval) assistant.push(interval);
    } else if (mayOverlap) missingAssistant++;
    if (!Array.isArray(message.content) && mayOverlap) unknownToolCollections++;
    for (const part of message.content || []) {
      if (part.type !== 'tool') continue;
      if (timestamp(part.time?.ran) && timestamp(part.time?.completed)) {
        const interval = clip([part.time.ran, part.time.completed], start, end);
        if (interval) tools.push(interval);
      } else {
        const earliest = timestamp(part.time?.ran) ? part.time.ran : timestamp(part.time?.created) ? part.time.created : created;
        const latest = timestamp(part.time?.completed) ? part.time.completed : message.time.completed;
        if (earliest <= end && (!timestamp(latest) || latest >= start)) missingTools++;
      }
    }
  }
  const a = merge(assistant), t = merge(tools), covered = merge([...a, ...t]);
  const aMs = length(a), tMs = length(t), coveredMs = length(covered);
  const metric = (label, ms, measured, missing) => ({ label, seconds: measured || !missing ? seconds(ms) : null,
    measuredIntervals: measured, missingIntervals: missing, partial: missing > 0 });
  return {
    assistantResponse: metric(RESPONSE_INTERVAL_LABEL, aMs, assistant.length, missingAssistant),
    toolExecution: { ...metric('工具实际执行区间（ran–completed）', tMs, tools.length, missingTools),
      seconds: tools.length || !(missingTools || unknownToolCollections) ? seconds(tMs) : null,
      partial: missingTools > 0 || unknownToolCollections > 0, unknownToolCollections },
    observedCoveredSeconds: seconds(coveredMs), observedOverlapSeconds: seconds(aMs + tMs - coveredMs),
    uncoveredSeconds: seconds(Math.max(0, end - start - coveredMs)),
    coveragePartial: missingAssistant > 0 || missingTools > 0 || unknownToolCollections > 0,
  };
}

/** Pure function: projected V2 Session.Message.Info[], optional inclusive IDs.
 * Counts refer to the selected records. Intervals from ANY record in this
 * session are clipped to the selected wall-clock window (including in-flight
 * work that began before `from`). No child session is fetched or added. */
export function analyzeSessionPerformance(messages, { from, to } = {}) {
  validateSessionMessages(messages);
  const locate = id => {
    const index = messages.findIndex(message => message.id === id);
    if (index < 0) fail('boundary-not-found');
    return index;
  };
  const first = from === undefined ? 0 : locate(from), last = to === undefined ? messages.length - 1 : locate(to);
  if (last < first) fail('reversed-boundaries');
  const start = messages[first].time.created, finalTime = messages[last].time;
  const end = timestamp(finalTime.completed) ? finalTime.completed : finalTime.created;
  if (end < start) fail('reversed-boundaries');
  const modelAliases = new Map(), aliases = new Map();
  for (const message of messages.slice(first, last + 1)) {
    if (message.type !== 'assistant' || typeof message.model?.id !== 'string' || typeof message.model?.providerID !== 'string') continue;
    const key = JSON.stringify([message.model.providerID, message.model.id, message.model.variant || null]);
    if (!modelAliases.has(key)) modelAliases.set(key, 'M' + (modelAliases.size + 1));
    aliases.set(message.id, modelAliases.get(key));
  }
  // User messages partition the clock; steering requests may arrive while a
  // response/tool is in flight. Such intervals are clipped, not double-added.
  const sections = []; let sectionFirst = first;
  for (let i = first + 1; i <= last; i++) {
    if (messages[i].type === 'user') { sections.push([sectionFirst, i - 1, messages[i].time.created]); sectionFirst = i; }
  }
  sections.push([sectionFirst, last, end]);
  const segments = sections.map(([a, b, until], index) => {
    const since = messages[a].time.created;
    return { request: index + 1, start: since, end: until, wallSeconds: seconds(until - since),
      counts: countsFor(messages.slice(a, b + 1), aliases), intervals: intervalStats(messages, since, until) };
  });
  return { ok: true, schemaVersion: 1, boundary: { start, end, endBasis: timestamp(finalTime.completed) ? 'completed' : 'created', wallSeconds: seconds(end - start) },
    counts: countsFor(messages.slice(first, last + 1), aliases), intervals: intervalStats(messages, start, end), segments,
    scope: SESSION_PERFORMANCE_SCOPE };
}

export function sessionPerformanceReport(result) {
  const duration = value => value === null ? '缺测' : value.toFixed(3) + 's';
  const rows = [`OpenCode 会话耗时（只读）`, `边界：${result.boundary.start}–${result.boundary.end} ms；末边界取 ${result.boundary.endBasis}；墙钟 ${duration(result.boundary.wallSeconds)}`];
  const append = (counts, intervals) => {
    rows.push(`助手消息 ${counts.assistantMessages}；finish=error ${counts.finishErrors}；retry 快照 ${counts.retryRecords}，最大 attempt ${counts.retryAttemptMaximum ?? '缺测'}`);
    for (const [name, count] of Object.entries(counts.tools)) rows.push(`工具 ${name}：${count} 次`);
    rows.push(`模型别名计数：${JSON.stringify(counts.models)}；finish 计数：${JSON.stringify(counts.finishes)}；finish 缺测 ${counts.finishMissing}`,
      `错误类别：助手 ${JSON.stringify(counts.assistantErrors)}；retry ${JSON.stringify(counts.retryErrors)}；工具 ${JSON.stringify(counts.toolErrors)}`,
      `缺测计数：${JSON.stringify(counts.missing)}`);
    for (const metric of [intervals.assistantResponse, intervals.toolExecution]) rows.push(`${metric.label}并集：${duration(metric.seconds)}；已测 ${metric.measuredIntervals}，缺测 ${metric.missingIntervals}${metric.partial ? '（部分测量）' : ''}`);
    if (intervals.toolExecution.unknownToolCollections) rows.push(`工具集合缺测：${intervals.toolExecution.unknownToolCollections}`);
    rows.push(`已测覆盖 ${duration(intervals.observedCoveredSeconds)}；已测重叠 ${duration(intervals.observedOverlapSeconds)}；未被已测区间覆盖 ${duration(intervals.uncoveredSeconds)}${intervals.coveragePartial ? '（有缺测）' : ''}`);
  };
  append(result.counts, result.intervals);
  for (const segment of result.segments) {
    rows.push(`请求段 ${segment.request}：${segment.start}–${segment.end} ms；墙钟 ${duration(segment.wallSeconds)}`);
    append(segment.counts, segment.intervals);
  }
  rows.push(result.scope);
  return rows.join('\n');
}
