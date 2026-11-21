/* 固定渠道：已确认的可恢复故障最多重试一次，不切换渠道、不重放工具。 */
import { readResponseText, parseChatSSE, validateChatResponse, ResponseParseError } from './provider-response.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareRequestContext } from './request-context.mjs';
import { apiErrorCode, API_ERROR_LABELS } from './api-error-diagnostics.mjs';
import { networkCodes, canRetryRequest, diagnosticLabel, tlsDiagnostics, certificateFailureReason } from './network-diagnostics.mjs';
export const REQUEST_TIMEOUTS = Object.freeze({ totalMs: 600000, headerMs: 120000, idleMs: 90000 });
export const AGENT_MODEL = 'deepseek/deepseek-v4.1-flash';
export const REQUEST_MODELS = Object.freeze({
  opendesign: 'deepseek-v4.1-flash', // OpenDesign 的同模型别名
  commandcode: AGENT_MODEL,
});

export const DEFAULT_MAX_OUTPUT_TOKENS = 6000;
/* 显式预算，不按模型猜测推理参数，也不在截断后自动涨额。 */
export function configureMaxOutputTokens(value = DEFAULT_MAX_OUTPUT_TOKENS) {
  if (!Number.isInteger(value) || value < 256 || value > 65536) {
    throw new RangeError('maxOutputTokens 必须是 256..65536 范围内的整数');
  }
  return value;
}

function providerOutputTokens(prov) {
  // 优先级：单次请求 > 渠道显式设置 > 渠道能力默认值 > 6000；仅 undefined 表示未设置。
  return configureMaxOutputTokens(prov.maxOutputTokens === undefined ? prov.capabilities?.maxOutputTokens : prov.maxOutputTokens);
}

/* 请求体里的模型名必须像模型名：只允许字母数字、点、横线、斜线、冒号。
   用户在设置页自选模型时用这个校验，避免把任意文本塞进请求体。 */
export function validModelName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 120 &&
    /^[A-Za-z0-9._:/-]+$/.test(name);
}

const REASONS = {
  quota: '额度不足', auth: '认证或渠道权限不可用', rate: '请求限流',
  timeout: '请求超时', network: '网络连接失败', server: '服务故障',
  response: '返回格式异常', truncated: '模型输出截断，工具未执行', request: '请求参数、上下文或内容限制',
};
export class ProviderRequestError extends Error {
  constructor(kind, { status, retryAfterMs, timeoutPhase, timeoutMs, diagnostics } = {}) {
    // 不把响应正文/原始网络异常写入日志，它们可能回显凭证或用户内容。
    const certificateReason = certificateFailureReason(diagnostics?.networkCodes);
    super((certificateReason || REASONS[kind] || REASONS.response) + (status ? '（HTTP ' + status + '）' : ''));
    this.name = 'ProviderRequestError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.timeoutPhase = timeoutPhase;
    this.timeoutMs = timeoutMs;
    this.diagnostics = diagnostics;
    this.retryable = kind !== 'request' && !certificateReason;
  }
}

function httpError(status, raw, retryAfter, now) {
  const body = raw.slice(0, 16000).toLowerCase();
  let kind = 'request';
  if (apiErrorCode({ message: body }) !== 'unknown_api_error' || /invalid_request_error|invalid_parameters?/.test(body)) kind = 'request';
  else if (status === 402 || /insufficient_quota|quota[_ -](?:exceeded|exhausted|depleted)|out_of_credits|insufficient[_ -](?:balance|credits?|funds)|余额不足|额度不足|余额已用完|额度已用完|credit balance|billing_hard_limit/.test(body)) kind = 'quota';
  else if (/invalid_api_key|authentication_error|permission_denied|unauthorized|access_denied/.test(body)) kind = 'auth';
  else if (status === 429) kind = 'rate';
  else if ([401, 403, 404].includes(status) || /model_not_found|unsupported_model/.test(body)) kind = 'auth';
  else if ([408, 504].includes(status)) kind = 'timeout';
  else if (status >= 500) kind = 'server';
  let retryAfterMs;
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (!Number.isFinite(retryAfterMs)) retryAfterMs = undefined;
  }
  return new ProviderRequestError(kind, { status,
    ...(kind === 'request' ? { diagnostics: { apiCode: apiErrorCode({ message: raw }) } } : {}),
    retryAfterMs: retryAfterMs == null ? undefined : Math.max(0, retryAfterMs) });
}

function apiResponseError(error, raw, httpStatus) {
  const apiStatus = Number(error?.status);
  const classified = httpError(apiStatus || 400, raw, null, Date.now());
  // 兼容网关 HTTP 200 内的 error，不能伪装成实际收到 HTTP 400/500。
  const failure = new ProviderRequestError(classified.kind, { status: httpStatus });
  failure.message += '（接口返回 error）';
  failure.fromAPI = true;
  failure.diagnostics = { apiCode: apiErrorCode(error) };
  if (Number.isInteger(apiStatus) && apiStatus >= 100 && apiStatus <= 599) failure.apiStatus = apiStatus;
  return failure;
}

export async function requestChat(prov, messages, tools, { signal, timeoutMs = REQUEST_TIMEOUTS.totalMs,
  headerTimeoutMs = REQUEST_TIMEOUTS.headerMs, idleTimeoutMs = REQUEST_TIMEOUTS.idleMs, fetchImpl = fetch,
  onProgress = () => {}, toolChoice, maxOutputTokens } = {}) {
  signal?.throwIfAborted();
  const outputTokens = maxOutputTokens === undefined ? providerOutputTokens(prov) : configureMaxOutputTokens(maxOutputTokens);
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) throw new Error('请求超时必须为正数');
  for (const ms of [headerTimeoutMs, idleTimeoutMs]) if (!(ms > 0) || !Number.isFinite(ms)) throw new Error('阶段超时必须为正数');
  const timeout = new AbortController(); let timeoutPhase = null, timeoutBudget = null;
  const expire = (phase, budget) => { timeoutPhase = phase; timeoutBudget = budget; timeout.abort(); };
  const timer = setTimeout(() => expire('total', timeoutMs), timeoutMs);
  const headerTimer = setTimeout(() => expire('headers', headerTimeoutMs), headerTimeoutMs);
  let idleTimer;
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => expire('idle', idleTimeoutMs), idleTimeoutMs); };
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const startedAt = Date.now(); let lastProgressAt = startedAt, receivedBytes = 0, phase = 'awaiting-headers', status;
  try {
    if (toolChoice && !tools?.some(t => t.function?.name === toolChoice)) throw new ProviderRequestError('request');
    const body = { model: prov.model, messages, temperature: .3, max_tokens: outputTokens, stream: true,
      ...(tools?.length ? { tools, tool_choice: toolChoice ? { type: 'function', function: { name: toolChoice } } : 'auto',
        ...(toolChoice ? { parallel_tool_calls: false } : {}) } : {}) };
    const res = await fetchImpl(prov.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: combined,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + prov.key, ...(prov.headers || {}) },
      body: JSON.stringify(body),
    });
    status = res.status; phase = 'receiving-body';
    clearTimeout(headerTimer); resetIdle();
    onProgress({ phase: 'headers', elapsedMs: Date.now() - startedAt });
    const raw = await readResponseText(res, { signal: combined, onChunk: count => {
      receivedBytes += count;
      resetIdle();
      if (Date.now() - lastProgressAt >= 15000) { onProgress({ phase: 'receiving', elapsedMs: Date.now() - startedAt }); lastProgressAt = Date.now(); }
    } });
    if (!res.ok) throw httpError(res.status, raw, res.headers.get('retry-after'), Date.now());
    phase = 'parsing-response';
    let data;
    try { data = /text\/event-stream/i.test(res.headers.get('content-type') || '') ? parseChatSSE(raw) : JSON.parse(raw); }
    catch (error) {
      if (error.apiError) throw apiResponseError(error.apiError, JSON.stringify(error.apiError), status);
      if (error instanceof ResponseParseError) {
        throw new ProviderRequestError(error.code === 'output_truncated' ? 'truncated' : 'response', {
          diagnostics: { parseCode: error.code, finishReason: error.finishReason,
            toolCount: error.toolCount, streamComplete: error.streamComplete } });
      }
      throw new ProviderRequestError('response', { diagnostics: { parseCode: 'invalid_json' } });
    }
    // 部分兼容网关用 HTTP 200 返回 error。
    if (data?.error) throw apiResponseError(data.error, raw, status);
    try { return validateChatResponse(data); }
    catch (error) {
      if (error instanceof ResponseParseError) throw new ProviderRequestError(error.code === 'output_truncated' ? 'truncated' : 'response', {
        diagnostics: { source: 'protocol', phase, elapsedMs: Date.now() - startedAt, receivedBytes,
          ...(status ? { status } : {}), networkCodes: [], parseCode: error.code,
          finishReason: error.finishReason, toolCount: error.toolCount, streamComplete: error.streamComplete } });
      throw error;
    }
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    const codes = networkCodes(e);
    const tls = tlsDiagnostics(e, prov.base, [prov.key, ...Object.values(prov.headers || {})]);
    const diagnostics = { source: timeout.signal.aborted ? 'local-timeout' : e instanceof ProviderRequestError ?
      (e.fromAPI ? 'api-error' : e.status ? 'http' : 'protocol') : codes.length ? 'transport' : 'unclassified',
      phase, elapsedMs: Date.now() - startedAt, receivedBytes, ...(status ? { status } : {}),
       ...(e.apiStatus ? { apiStatus: e.apiStatus } : {}), networkCodes: codes, ...(tls ? { tls } : {}) };
    if (timeout.signal.aborted) throw new ProviderRequestError('timeout', { timeoutPhase, timeoutMs: timeoutBudget, diagnostics });
    if (e instanceof ProviderRequestError) { e.diagnostics = { ...diagnostics, ...e.diagnostics }; throw e; }
    if (e?.code === 'VH_RESPONSE_TOO_LARGE') throw new ProviderRequestError('response', { diagnostics: { ...diagnostics, source: 'local-response-limit' } });
    if (diagnostics.networkCodes.some(code => ['ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE'].includes(code))) {
      throw new ProviderRequestError('request', { diagnostics: { ...diagnostics, source: 'local-config' } });
    }
    throw new ProviderRequestError('network', { diagnostics });
  } finally { clearTimeout(timer); clearTimeout(headerTimer); clearTimeout(idleTimer); }
}

export class ProviderPoolError extends Error {
  constructor(failures) {
    super('当前模型渠道请求失败（未自动切换）：' + failures.map(f => f.provider + '：' + f.reason).join('；'));
    this.name = 'ProviderPoolError';
    this.failures = failures;
  }
}

export function createProviderPool({ candidates, preferred, request = requestChat,
  log = () => {}, onSuccess = () => {}, timeoutMs = REQUEST_TIMEOUTS.totalMs,
  headerTimeoutMs, idleTimeoutMs, retryDelayMs = 1000, onTiming = () => {} }) {
  const timing = event => { try { onTiming(event); } catch {} }; // diagnostics never retry a successful request
  if (!candidates.length) throw new Error('没有可用模型渠道：请在本机配置所选渠道凭证；不会自动改用其他渠道');
  if (new Set(candidates.map(c => c.name)).size !== candidates.length) throw new Error('模型渠道名称不能重复');
  // 即使调用方传入多个凭证，也只访问选定的一个渠道。
  const routes = candidates.map(c => {
    // 渠道的固定别名优先；只有用户在设置页显式选过模型（modelExplicit）才覆盖它。
    // 固定别名是这套 harness 的既有约定，不能被调用方传入的旧模型名带偏。
    const fixed = REQUEST_MODELS[c.name];
    const model = c.modelExplicit ? c.model : (fixed || c.model);
    if (!validModelName(model)) throw new Error('不支持的模型渠道或模型名无效');
    return { ...c, model, maxOutputTokens: providerOutputTokens(c) };
  });
  const selected = preferred || 'opendesign';
  const prov = routes.find(c => c.name === selected);
  if (!prov) throw new Error('所选渠道 ' + selected + ' 没有凭证；不会自动切换');
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error('重试间隔必须为非负数');
  const current = () => prov;
  /* 折叠锚点跨轮保存：折叠区只增不减，公共前缀才能一直延伸到上一轮末尾（省缓存命中）。 */
  let stableAnchor = 0;
  let compactContext = false;
  /* usage 记账：网关确实回 usage（含 cached_tokens），累计起来供成本报告用。 */
  const totals = { requests: 0, prompt: 0, cached: 0, uncached: 0, completion: 0, reasoning: 0 };
  return {
    current,
    get stableAnchor() { return stableAnchor; },
    get usage() { return { ...totals }; },
    async chat(messages, tools, signal, tailNote = '', { toolChoice, maxOutputTokens, stageContext = false, omitLatestPlainReasoning = false } = {}) {
      signal?.throwIfAborted();
      const outputTokens = configureMaxOutputTokens(maxOutputTokens === undefined ? prov.maxOutputTokens : maxOutputTokens);
      let context = prepareRequestContext(messages, { tailNote, stableAnchor, omitLatestPlainReasoning,
        /* Authoring work is not a "run one command" turn: the model must hold
         * several consecutive excerpts of the same file to locate an anchor.
         * Keeping only 2 turns folds each excerpt away right before the next
         * read, so a long scene can never be assembled and the model loops
         * forever. Content safety still comes from write/scope guards, not from
         * starving the working set. */
        ...(compactContext ? { keepRecentTurns: 2, hardLimitBytes: 16 * 1024 }
          : stageContext ? { keepRecentTurns: 8, hardLimitBytes: 48 * 1024 } : {}) });
      if (Number.isInteger(context.stableAnchor)) stableAnchor = context.stableAnchor;
      log('请求上下文：' + context.beforeBytes + 'B → ' + context.afterBytes + 'B；移除历史推理字段 ' +
        context.removedReasoning + '，节选旧工具结果 ' + context.compactedResults + '，历史轮次回执 ' + context.compactedGroups + '（完整检查点保留）');
      if (context.overTarget) log('上下文仍超过软目标，保留原始要求与最新轮次继续发送；不会因此在本地中断。');
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        let data;
        try {
          log('模型请求：' + prov.name + '（流式接收，保留当前任务上下文' + (attempt ? '；故障重试 1/1' : '') + '）');
          const started = performance.now(); let ok = false;
          try {
            data = await request(prov, context.messages, tools, { signal, timeoutMs, headerTimeoutMs, idleTimeoutMs, toolChoice, maxOutputTokens: outputTokens,
              onProgress: info => log('… ' + prov.name + (info.phase === 'headers' ? ' 已收到响应头' : ' 正在持续生成') + '（' + Math.round(info.elapsedMs / 1000) + 's）') });
            signal?.throwIfAborted();
            ok = true;
          } finally { timing({ stage: '模型请求', elapsedMs: performance.now() - started, ok }); }
        } catch (e) {
          if (signal?.aborted) throw signal.reason;
          const safe = e instanceof ProviderRequestError ? e : new ProviderRequestError('network');
          const waitMs = Math.max(retryDelayMs, safe.retryAfterMs || 0);
          const evidence = diagnosticLabel(safe.diagnostics);
          if (attempt === 0 && toolChoice && safe.kind === 'request' && safe.diagnostics?.apiCode === 'unsupported_tool_choice') {
            log(`⚠ ${prov.name}：接口明确不支持定向工具调用；同渠道改用自动工具选择一次，保留本场任务说明，不重放工具`);
            toolChoice = undefined;
            continue;
          }
          if (attempt === 0 && safe.kind === 'request' && safe.diagnostics?.apiCode === 'context_length_exceeded') {
            const smaller = prepareRequestContext(messages, { tailNote, stableAnchor,
              keepRecentTurns: stageContext ? 4 : 2, hardLimitBytes: stageContext ? 24 * 1024 : 16 * 1024, omitLatestPlainReasoning });
            if (smaller.afterBytes < context.afterBytes) {
              log(`⚠ ${prov.name}：已确认模型上下文超限；保留原文、用户补充及工具配对，压缩历史 ${context.afterBytes}B → ${smaller.afterBytes}B，同渠道纠偏 1/1，不重放工具`);
              context = smaller; stableAnchor = Math.max(stableAnchor, smaller.stableAnchor); compactContext = true;
              continue;
            }
          }
          if (canRetryRequest(prov.name, safe) && attempt === 0 && waitMs <= 30000) {
            log('⚠ ' + prov.name + '：' + safe.message + (evidence ? ' [' + evidence + ']' : '') + '；' + waitMs / 1000 + '秒后在同一渠道重试 1/1，不重放已完成工具');
            const started = performance.now(); let ok = false;
            try { await delay(waitMs, undefined, { signal }); ok = true; }
            catch (error) { if (signal?.aborted) throw signal.reason; throw error; }
            finally { timing({ stage: '模型重试等待', elapsedMs: performance.now() - started, ok }); }
            continue;
          }
          const failure = { provider: prov.name, kind: safe.kind, reason: safe.message, attempts: attempt + 1,
            ...(safe.diagnostics ? { diagnostics: safe.diagnostics } : {}),
            ...(safe.status ? { status: safe.status } : {}),
            ...(safe.timeoutPhase ? { timeoutPhase: safe.timeoutPhase, timeoutMs: safe.timeoutMs } : {}) };
          log('⚠ ' + prov.name + '：' + safe.message + (safe.diagnostics?.apiCode ? '；' + API_ERROR_LABELS[safe.diagnostics.apiCode] : '') + (evidence ? ' [' + evidence + ']' : '') +
            (attempt ? '；已重试一次仍失败' : '') + '；任务暂停，未自动切换');
          throw new ProviderPoolError([failure]);
        }
        // 成功后才记住渠道；不额外发送 ping，不把 API key 存进项目状态。
        await onSuccess(prov);
        // 记账：网关确实回 usage（含 cached_tokens），落盘后能自报花费与缓存命中率。
        const usage = data?.usage;
        if (usage) {
          const prompt = Number(usage.prompt_tokens) || 0;
          const cached = Number(usage.prompt_tokens_details?.cached_tokens) || 0;
          const completion = Number(usage.completion_tokens) || 0;
          const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
          totals.requests += 1;
          totals.prompt += prompt;
          totals.cached += cached;
          totals.uncached += Math.max(0, prompt - cached);
          totals.completion += completion;
          totals.reasoning += reasoning;
        }
        return data;
      }
    },
  };
}
