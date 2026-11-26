/* Question-first discovery. Generation has no tools; an explicit investigation
 * updates one saved question with matched material (not factual verification).
 * Scheduling, persistence, model runtime and production remain separate. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { writeSchedule, sourceURLs, topicDetails } from './schedule.mjs';
import { DISCOVERY_DEFAULTS, topicHistory, feedbackContext, enqueueCandidate, readTopicSchedule, bumpDiscoveryRevision } from './topic-memory.mjs';
import { resolveDiscoveryScope } from './discovery-request.mjs';
import { collectDiscoveryResearch, assessDiscoveryCandidate, discoveryWindow } from './discovery-evidence.mjs';
import { interruptSession } from './opencode-interrupt.mjs';
import { stopRecordedChildren } from './process-lifecycle.mjs';
import { normalizeQuestion, normalizeResearchAssessment, unresearchedAssessment } from './topic-contract.mjs';
import { canEnqueueTopic } from './topic-research-store.mjs';
import { parseConfigJSON, currentSelection } from './provider-settings.mjs';
import { prepareExecution } from './execution-config.mjs';
import { discoveryPrompt, researchPrompt, DISCOVERY_CAPS, DISCOVERY_RECENT_CAPS } from './discovery-prompts.mjs';
export { discoveryPrompt, researchPrompt, DISCOVERY_CAPS, DISCOVERY_RECENT_CAPS } from './discovery-prompts.mjs';

export const DEFAULT_DISCOVERY = Object.freeze({
  ...DISCOVERY_DEFAULTS,
  /* 默认跟随模型设置页（provider-settings.currentSelection）；仅在显式配置时覆盖。 */
  model: null,
  agent: 'vh-builder',
  /* 构思与调查分别受此执行上限保护；调查须有两个不同查询并读取原文。
   * 自动构思加调查共用一份截止时间，不按候选数量倍增预算。 */
  timeoutMs: 480000,
  /* 中途收手的门槛：不要等整轮预算用完。
   * 实测失败那轮 7 次长超时（30/45/60/75/90 秒）吃掉 406 秒，
   * 而成功的两轮最长空窗只有 77 / 108 秒，失败那轮从 2 分半起就没再读到原文。 */
  stallMs: 150000,
  /* 一次都没读到原文时，用到预算的多少比例就判定这轮不可救。 */
  noPageBudgetRatio: 0.6,
  maxFetchFailures: 8,
});

/* 从模型回答里取 JSON 数组。允许被 ```json 包裹；解析失败返回 null。 */
export function parseCandidates(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(data)) return null;
  return data.filter(item => item && typeof item.topic === 'string' && item.topic.trim()).slice(0, 40);
}

const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 10 || Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.75) return false;
  const grams = value => new Set(Array.from({ length: value.length - 1 }, (_, i) => value.slice(i, i + 2)));
  const x = grams(a), y = grams(b), shared = [...x].filter(part => y.has(part)).length;
  return shared / (x.size + y.size - shared) >= 0.8;
}

/* 语义判断由编辑提示词完成；本地只做保守兜底，不因共享 URL 就误删不同问题。 */
export function duplicateOf(item, known) {
  return known.find(previous => similar(normalized(item.topic), normalized(previous.topic)) ||
    (item.coreQuestion && previous.coreQuestion && similar(normalized(item.coreQuestion), normalized(previous.coreQuestion)) &&
      (!item.subject || !previous.subject || similar(normalized(item.subject), normalized(previous.subject)))));
}

function validUpdate(item, previous) {
  return previous && item.updateOf === previous.id && typeof item.newEvidence === 'string' && item.newEvidence.trim().length >= 12 &&
    sourceURLs(item.sources).some(url => !sourceURLs(previous.sources).map(sourceIdentity).includes(sourceIdentity(url))) && normalized(item.topic) !== normalized(previous.topic);
}

function sourceIdentity(value) {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

/* 过滤兼容调用方：已有主题、历史、无来源和批内重复均不返回。 */
export function filterCandidates(candidates, queue, limit = Infinity) {
  const known = [...topicHistory(queue), ...(queue.items || []), ...(queue.runs || [])];
  const out = [];
  for (const item of candidates) {
    const topic = item.topic.trim();
    const previous = duplicateOf(item, known);
    if (duplicateOf(item, out) || previous && !validUpdate(item, previous)) continue;
    const sources = sourceURLs(item.sources);
    if (!sources.length && !normalizeQuestion(item.question)) continue;
    known.push(item);
    out.push({ topic, ...topicDetails(item), why: typeof item.why === 'string' ? item.why.trim() : '', sources });
    if (out.length >= limit) break;
  }
  return out;
}

/* 找出这一轮里可用的回答文本：优先能解析成候选数组的那段，避免把中途旁白当成答案。 */
function answerFrom(events, operation = 'questions') {
  const texts = events.filter(event => event?.type === 'text' && typeof event.part?.text === 'string' && event.part.text.trim())
    .map(event => event.part.text);
  return [...texts].reverse().find(text => operation === 'research' ? parseResearchResult(text) : parseCandidates(text)) || texts.at(-1) || '';
}

export function parseResearchResult(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  const unwrap = data => {
    const item = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
    return item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  };
  try { return unwrap(JSON.parse(body)); } catch {}
  const objStart = body.indexOf('{'), objEnd = body.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    try { return unwrap(JSON.parse(body.slice(objStart, objEnd + 1))); } catch {}
  }
  const arrStart = body.indexOf('['), arrEnd = body.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try { return unwrap(JSON.parse(body.slice(arrStart, arrEnd + 1))); } catch {}
  }
  return null;
}

/* CLI errors can arrive as JSON on stdout even when stderr is empty.
 * Redact before truncating; never show a raw event/configuration document. */
function executorFailure(events, stderr, fallback, env) {
  const event = [...events].reverse().find(item => item?.type === 'error' && typeof item.error?.message === 'string');
  let message = event?.error.message || stderr || fallback;
  for (const [name, value] of Object.entries(env)) {
    if (/(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)$/i.test(name) && typeof value === 'string' && value.length >= 4) message = message.split(value).join('[redacted]');
  }
  return message.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"'<>;,}]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/g, raw => { try { return new URL(raw).origin + '/[redacted-path]'; } catch { return '[redacted-url]'; } })
    .trim().slice(0, 600);
}

function runOpencode({ cwd, prompt, model, agent, home, operation = 'questions', mode = 'focused', timeoutMs = 180000,
  stallMs = DEFAULT_DISCOVERY.stallMs, noPageBudgetRatio = DEFAULT_DISCOVERY.noPageBudgetRatio,
  maxFetchFailures = DEFAULT_DISCOVERY.maxFetchFailures }) {
  return new Promise(resolve => {
    let childEnv = process.env, selectedAgent = agent || 'vh-builder';
    /* 与正式制作任务（runners/index.mjs）共享同一套渠道凭据桥接，避免 --standalone 下丢失 opencode-go 等渠道密钥与端点。 */
    if (!process.env.VH_OPENCODE_BIN) {
      try {
        const prepared = prepareExecution(cwd, {
          env: process.env,
          home: home || process.env.HOME,
          config: { name: 'opencode', ...(model ? { model } : {}) },
          requireCredentials: false,
        });
        childEnv = { ...prepared.childEnv };
      } catch (error) {
        resolve({ ok: false, reason: error.message });
        return;
      }
    }
    const lightSearch = operation === 'questions' && mode === 'recent';
    if (operation === 'questions') {
      // Per-child virtual config, never write project/global authorization.
      // A unique agent prevents narrowing another concurrent session's agent.
      // Offline modes deny all tools; recent mode allows ONLY websearch (capped)
      // and denies webfetch/shell/MCP so ideation stays fast and lightweight.
      let document;
      try { document = childEnv.OPENCODE_CONFIG_CONTENT ? parseConfigJSON(childEnv.OPENCODE_CONFIG_CONTENT) : {}; }
      catch { resolve({ ok: false, reason: '运行时 OpenCode 配置无效，未覆盖已有配置或启动任务' }); return; }
      if (!document || typeof document !== 'object' || Array.isArray(document)) { resolve({ ok: false, reason: '运行时 OpenCode 配置必须是对象' }); return; }
      selectedAgent = (lightSearch ? 'vh-recent-' : 'vh-questions-') + randomUUID();
      document = { ...document, agents: { ...document.agents, [selectedAgent]: lightSearch
        ? { mode: 'primary', description: '一次性轻联网近期动态构思',
          system: `只允许使用 websearch（优先 1–2 次、最多 ${DISCOVERY_RECENT_CAPS.searches} 次）快速了解近期动态并立刻输出所要求的 JSON；禁止调用 webfetch 或其他工具。`,
          permissions: [{ action: 'websearch', resource: '*', effect: 'allow' }, { action: '*', resource: '*', effect: 'deny' }], steps: 6 }
        : { mode: 'primary', description: '一次性无工具的问题构思',
          system: '只根据用户资料提出具体、值得调查的问题，直接输出所要求的 JSON；本任务不使用任何工具。',
          permissions: [{ action: '*', resource: '*', effect: 'deny' }], steps: 2 } } };
      childEnv = { ...childEnv, OPENCODE_CONFIG_CONTENT: JSON.stringify(document) };
    }
    const argv = ['run', '--format', 'json', '--auto', '--agent', selectedAgent];
    // A running shared service cannot see this child's inline agent/provider
    // configuration. A private server must inherit the per-run environment.
    const privateService = Boolean(childEnv.OPENCODE_CONFIG_CONTENT);
    if (privateService) argv.push('--standalone');
    if (model) argv.push('-m', model);
    argv.push(prompt);
    const child = spawn(process.env.VH_OPENCODE_BIN || 'opencode', argv, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const startedAt = Date.now();
    let err = '', stderrDiscarded = false, timer, done = false, settling = false, bytes = 0, sessionId = null, buffer = '', lastPageCount = 0, lastPageAt = startedAt, inspected = 0;
    const events = [];
    const calls = { websearch: 0, webfetch: 0 }, fetchedURLs = new Map(), toolIds = new Set();
    const decoder = new StringDecoder('utf8');
    const research = () => collectDiscoveryResearch(events);
    /* 看门狗与超时定时器都在 finish 里清掉，先声明避免落进 TDZ。 */
    let heartbeat = null;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); clearInterval(heartbeat); resolve(value); };
    /* 只杀本地进程组不够：opencode run 只是后台服务的客户端，
     * 真正的会话循环还跑在服务里，会继续烧钱、继续联网。
     * 实测一次超时后会话又跑了 9 分钟并产出了完整答案，但本地已判失败、结果全丢。
     * 所以中断必须两件事都做：先通知服务中断会话，再收本地进程组。 */
    const stop = () => Promise.all([
      privateService ? Promise.resolve({ confirmed: false, notRequired: true, reason: 'private-server-owned-by-process-group' }) : interruptSession(sessionId, { cwd }),
      child.pid ? stopRecordedChildren([{ pid: child.pid, group: true }]) : Promise.resolve({ stopped: true }),
    ]);
    /* 收尾：能拿到的证据照常带走，不让一次超时把整轮付过的钱清零。 */
    const settle = (reason, code) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      const stopping = stop();
      const data = research(), text = answerFrom(events, operation);
      /* 已经有完整 JSON 且检索记录够，就仍按同一套原文校验保存；
       * 只是晚了，不该连原文证据一起丢。 */
      const complete = operation === 'questions' ? parseCandidates(text) : parseResearchResult(text) && data.searches.length >= 2;
      const value = !['output', 'budget', 'executor'].includes(code) && text && complete
        ? { ok: true, text, research: data, salvaged: true }
        : { ok: false, aborted: code, reason, added: [], research: data,
          searchFailures: data.failures, hints: searchHints(data) };
      /* 等本地进程真的退出再交卷：锁按轮次释放，早交卷会让用户在旧会话
       * 还活着时再点一次，两个会话同时抢网络与配额，下一轮更容易再超时。 */
      void stopping.then(([interrupt, local]) => {
        const cleanup = { localStopped: local.stopped, service: privateService ? 'private' : 'shared', interrupt };
        const warnings = [];
        if (!interrupt.confirmed && !interrupt.notRequired) warnings.push('OpenCode 服务端会话中断未确认（' + interrupt.reason + '），不能仅凭本地进程退出认定会话已停止');
        if (!local.stopped) warnings.push('本地检索进程仍待退出，未确认回收完成');
        finish({ ...value, cleanup, ...(warnings.length ? { cleanupWarnings: warnings } : {}),
          ...(!value.ok && warnings.length ? { reason: value.reason + '；' + warnings.join('；') } : {}) });
      }).catch(() => finish({ ...value, cleanup: { localStopped: false },
        cleanupWarnings: ['进程回收未确认'],
        reason: (value.reason || '检索收尾失败') + '；进程回收未确认' }));
    };
    /* 流式看门狗：不等 8 分钟。失败多、或长时间读不到新原文时提前收手，
     * 给的是「下次怎么调」而不是「超时了」。
     * 门槛按 11-10 三次真实运行校准：成功的两轮最长空窗 77/108 秒，
     * 失败那轮从 2 分半起就没有新原文，空窗一路涨到 321 秒。 */
    const inspect = () => {
      if (done) return;
      if (operation !== 'research') return; // no web-evidence watchdog for question ideation
      const now = Date.now();
      if (now - inspected < 500) return;
      inspected = now;
      const data = research();
      if (data.pages.length > lastPageCount) { lastPageCount = data.pages.length; lastPageAt = now; }
      const elapsed = now - startedAt, fetchFailures = data.failures.filter(item => item.tool === 'webfetch');
      if (fetchFailures.length >= maxFetchFailures) {
        settle(`已经累计 ${fetchFailures.length} 次读不到原文（多半是站点拦截、付费墙或超时），本轮提前收手；` +
          `本次未保存候选，原有内容保留。换个方向或换个来源类型再试。`, 'failures');
        return;
      }
      if (fetchFailures.length >= 2 && now - lastPageAt >= stallMs) {
        settle(`已经 ${Math.round((now - lastPageAt) / 1000)} 秒没读到任何新原文，期间又有 ${fetchFailures.length} 次读取失败；` +
          '继续试同批站点只是重复等待。本轮提前收手：本次未保存候选，原有内容保留。可以换个方向再试。', 'stall');
        return;
      }
      if (data.pages.length === 0 && fetchFailures.length >= 2 && elapsed >= timeoutMs * noPageBudgetRatio) {
        settle(`检索已用 ${Math.round(elapsed / 1000)} 秒却一篇原文都没读到，剩下的预算大概率也是同样结果；` +
          '本轮提前收手：本次未保存候选，原有内容保留。请检查网络或换一个更容易读到原文的方向。', 'no-page');
      }
    };
    const consume = line => {
      const text = line.trim();
      if (!text) return;
      let event;
      try { event = JSON.parse(text); } catch { return; }
      events.push(event);
      /* 会话 id 一出现就记下，超时时才有对象可中断。 */
      if (!sessionId && typeof event.sessionID === 'string') sessionId = event.sessionID;
      if ((operation === 'research' || lightSearch) && event.type === 'tool_use') {
        const part = event.part || {}, state = part.state || {}, tool = part.tool || event.tool;
        const key = part.callID || part.id;
        if (['websearch', 'webfetch'].includes(tool) && ['completed', 'error'].includes(state.status) && (!key || !toolIds.has(key))) {
          if (key) toolIds.add(key);
          calls[tool]++;
          if (lightSearch) {
            const why = tool === 'webfetch' ? '轻联网出题阶段不允许读取原文'
              : calls.websearch > DISCOVERY_RECENT_CAPS.searches ? `近期动态轻搜次数超过上限（最多 ${DISCOVERY_RECENT_CAPS.searches} 次）` : '';
            if (why) {
              settle(`近期动态构思触及轻搜预算：${why}；已请求停止`, 'budget');
              return;
            }
            const data = research();
            const webFailures = data.failures.filter(item => item.tool === 'websearch');
            if (webFailures.length >= 2 && data.searches.length === 0) {
              settle(searchFailureReason(data) || '轻联网连续搜索失败，本轮提前收手；原有内容保留。', 'failures');
              return;
            }
          } else {
            const url = tool === 'webfetch' && typeof state.input?.url === 'string' ? state.input.url.trim() : '';
            const hasUrl = url !== '';
            const urlFetches = hasUrl ? (fetchedURLs.get(url) || 0) + 1 : 0;
            if (hasUrl) fetchedURLs.set(url, urlFetches);
            const duplicateFetch = hasUrl && urlFetches > DISCOVERY_CAPS.sameUrl;
            const data = research();
            const okFetches = data.pages.length;
            const maxTotalFetches = DISCOVERY_CAPS.fetches + 4;
            const maxTotalCalls = 16;
            const why = duplicateFetch ? `重复读取同一原文（同一地址最多允许读取 ${DISCOVERY_CAPS.sameUrl} 次）`
              : tool === 'webfetch' && Number(state.input?.timeout) > DISCOVERY_CAPS.fetchTimeoutSeconds ? '单次原文读取的超时设置超过上限'
                : calls.websearch > DISCOVERY_CAPS.searches ? '搜索次数超过上限'
                  : okFetches > DISCOVERY_CAPS.fetches || calls.webfetch > maxTotalFetches ? '阅读原文次数超过上限'
                    : calls.websearch + okFetches > 12 || calls.websearch + calls.webfetch > maxTotalCalls ? '搜索和阅读总次数超过上限' : '';
            if (why) {
              settle(`调查触及检索/读取硬预算：${why}（搜索 ${calls.websearch} 次、读取 ${calls.webfetch} 次，其中成功 ${okFetches} 篇）；已请求停止`, 'budget');
              return;
            }
          }
        }
      }
      inspect();
    };
    /* 看门狗必须自己走时钟：读取失败后模型常常沉默几十秒，
     * 只靠事件到达才检查的话，最需要收手的时刻反而不会触发。 */
    heartbeat = setInterval(inspect, 1000);
    timer = setTimeout(() => {
      settle(`${operation === 'research' ? '调查问题' : '构思问题'}在 ${Math.round(timeoutMs / 1000)} 秒内没收尾；` +
        `本轮请求中断执行器，本次未保存候选，原有内容保留。可以缩短检索方向的范围再试。`, 'timeout');
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        settle('检索输出超过安全大小，未保存新候选；请缩小检索范围', 'output');
        return;
      }
      if (!done) {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) consume(line);
      }
    });
    child.stderr.on('data', chunk => {
      if (stderrDiscarded) return;
      err += chunk.toString('utf8');
      if (err.length > 65536) { err = '执行器错误输出过长，已省略原文'; stderrDiscarded = true; }
    });
    child.on('error', error => finish({ ok: false, reason: error.message }));
    child.on('close', code => {
      if (done || settling) return;
      buffer += decoder.end();
      if (buffer.trim()) consume(buffer);
      buffer = '';
      if (settling) return;
      if (code !== 0) { settle(executorFailure(events, err, 'opencode 退出 ' + code, childEnv), 'executor'); return; }
      if (events.some(event => event?.type === 'error')) { settle('检索执行器报告错误：' + executorFailure(events, err, '未知错误', childEnv), 'executor'); return; }
      finish({ ok: true, text: answerFrom(events, operation), research: research() });
    });
  });
}

/* 把工具失败翻成用户能照做的原因。全部失败时不再说“没搜到”，
 * 而是指出缺少多查询记录的真实原因（额度、限流、网络、拦截）。 */
/* 给界面的可操作提示：与 reason 分开，方便前端列表展示。
 * 搜索与读原文是两类不同故障：搜索挂了多半是额度/限流，
 * 读原文挂了多半是站点拦截、付费墙或单个地址太慢，处理方法不一样。 */
function searchHints(research) {
  const failures = Array.isArray(research?.failures) ? research.failures : [];
  const web = failures.filter(item => item.tool === 'websearch');
  const pages = failures.filter(item => item.tool === 'webfetch');
  const hints = [];
  const codes = new Set(web.map(item => item.status).filter(Boolean));
  if ([...codes].some(code => ['401', '402', '403'].includes(code))) {
    hints.push('检查本机搜索服务额度或授权（websearch 返回 HTTP ' + [...codes].join('/') + '）');
  }
  if (codes.has('429')) hints.push('稍等几分钟再试，搜索服务当前限流');
  if (pages.length) {
    const blocked = pages.some(item => ['401', '402', '403'].includes(item.status) || /403|Access Denied|verify you are human/i.test(item.error || ''));
    hints.push(blocked
      ? `有 ${pages.length} 篇原文读不到（站点返回 403 或验证页）；优先换官方公告、论文或原始数据这类不需要登录的来源`
      : `有 ${pages.length} 篇原文读取超时；换一个方向，或避开视频站、登录墙与重前端页面`);
  }
  if (web.length && !hints.length) hints.push('检查网络与本机搜索服务配置后重试');
  if (!hints.length) return [];
  hints.push('也可以换个检索方向再试；原有候选与队列不会因此改变');
  return hints;
}

function searchFailureReason(research) {  const failures = Array.isArray(research?.failures) ? research.failures : [];
  const searches = Array.isArray(research?.searches) ? research.searches : [];
  if (searches.length >= 2) return null;
  const web = failures.filter(item => item.tool === 'websearch');
  if (!web.length) return null;
  const codes = [...new Set(web.map(item => item.status).filter(Boolean))];
  const detail = web[0].error ? '（' + web[0].error.slice(0, 120) + '）' : '';
  if (codes.some(code => ['402', '401', '403'].includes(code))) {
    return '搜索服务没有额度或未授权：websearch 返回 HTTP ' + codes.join('/') + detail +
      '。本次调查需要联网搜索，请检查本机搜索服务配置后再试；原问题与已有材料保留。';
  }
  if (codes.some(code => ['429'].includes(code))) {
    return '搜索服务限流：websearch 返回 HTTP 429' + detail + '。稍等几分钟再试；本次未保存候选，原有内容保留。';
  }
  return '联网搜索失败：' + (web[0].error || '未知原因') + '。调查成功需要至少两个不同查询的检索记录；本次未保存，原有内容保留。';
}

function resolveDiscoveryModel(explicit, home) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const selection = currentSelection(home);
  return `${selection.provider}/${selection.model}`;
}

async function discover(root, options) {
  const queue = readTopicSchedule(root);
  const config = { ...DEFAULT_DISCOVERY, ...(queue.discoveryConfig || {}), ...options };
  config.home = options.home || process.env.HOME || undefined;
  try {
    config.model = resolveDiscoveryModel(options.model ?? queue.discoveryConfig?.model, config.home);
  } catch (error) {
    return { ok: false, reason: error.message, added: [] };
  }
  config.operation = options.operation || 'questions';
  config.topicId = options.topicId;
  const automaticAtStart = queue.discoveryConfig?.enabled === true && queue.discoveryConfig?.autoQueue === true;
  config.count = Math.max(1, Math.min(10, Math.floor(Number(config.count) || 3)));
  config.timeoutMs = Math.max(1000, Math.min(600000, Number(config.timeoutMs) || DEFAULT_DISCOVERY.timeoutMs));
  const deadlineAt = Date.now() + config.timeoutMs;
  /* 中途收手的三个门槛也要落在可与预算比较的范围内，
   * 否则一个超大 stallMs 就等于关掉看门狗。 */
  config.stallMs = Math.max(1000, Math.min(config.timeoutMs, Number(config.stallMs) || DEFAULT_DISCOVERY.stallMs));
  config.maxFetchFailures = Math.max(2, Math.min(50, Number(config.maxFetchFailures) || DEFAULT_DISCOVERY.maxFetchFailures));
  config.noPageBudgetRatio = Math.max(0.1, Math.min(0.95, Number(config.noPageBudgetRatio) || DEFAULT_DISCOVERY.noPageBudgetRatio));
  const history = topicHistory(queue).sort((a, b) => a.at - b.at);
  let scope;
  try { scope = resolveDiscoveryScope({ ...config, mode: options.mode || (config.followupId ? 'focused' : config.mode) }, history); }
  catch (error) { return { ok: false, reason: error.message, added: [] }; }
  const { base, ...settings } = scope;
  Object.assign(config, settings);
  if (config.operation === 'research') return investigateTopic(root, base, config);
  let drainedFallback = null;
  if (!base && options.origin === 'automatic' && automaticAtStart && config.autoQueue === true && options.preferExistingCandidates === true) {
    const drained = await drainExistingCandidates(root, config, deadlineAt);
    if (drained) {
      if (drained.added.length > 0 || drained.hardSearchFailure || (deadlineAt - Date.now()) < 1000) {
        return drained;
      }
      // 所有旧候选本轮均未能入队（例如站点 403/读不到原文/材料不足），不直接停机，顺延生成新选题补位。
      drainedFallback = drained;
    }
  }
  const prompt = discoveryPrompt({ query: config.query, count: config.count, mode: config.mode,
    history: history.filter(item => item.id !== base?.id), preferences: feedbackContext(queue),
    followup: base ? { action: config.followup, id: base.id, topic: base.topic, subject: base.subject, coreQuestion: base.coreQuestion,
      outline: base.outline, question: base.question, researchAssessment: base.researchAssessment } : null });
  const questionTimeoutMs = config.mode === 'recent' && !base ? Math.min(config.timeoutMs, 240000) : config.timeoutMs;
  const result = await runOpencode({ cwd: root, prompt, operation: 'questions', mode: base ? 'focused' : config.mode, model: config.model, agent: config.agent, home: config.home, timeoutMs: questionTimeoutMs,
    stallMs: config.stallMs, noPageBudgetRatio: config.noPageBudgetRatio, maxFetchFailures: config.maxFetchFailures });
  if (!result.ok) return { ok: false, reason: result.reason, added: [], hints: result.hints || [],
    searchFailures: result.searchFailures || [], ...(result.aborted ? { aborted: result.aborted } : {}),
    ...(result.cleanup ? { cleanup: result.cleanup } : {}) };
  const candidates = parseCandidates(result.text);
  if (!candidates) {
    if (config.mode === 'recent' && !base && result.research?.failures?.length && !result.research.searches.length) {
      return { ok: false, reason: searchFailureReason(result.research) || '近期动态搜索失败，未生成候选', added: [],
        hints: searchHints(result.research), searchFailures: result.research.failures };
    }
    return { ok: false, reason: '模型回答里没有可解析的 JSON 数组，未入队', added: [], raw: result.text.slice(0, 400) };
  }
  if (config.mode === 'recent' && !base && candidates.length === 0) {
    if (result.research?.failures?.length && !result.research.searches.length) {
      return { ok: false, reason: searchFailureReason(result.research) || '近期动态搜索失败，未生成候选', added: [],
        hints: searchHints(result.research), searchFailures: result.research.failures };
    }
    if (!result.research?.searches?.length) {
      return { ok: false, reason: '轻联网未能取得有效搜索结果（可能搜索服务不可用或未触发检索），请检查搜索服务配置或换更具体的关键词再试', added: [],
        hints: searchHints(result.research), searchFailures: result.research?.failures || [] };
    }
  }
  const batchId = randomUUID(), at = Date.now(), rejected = [];
  const material = candidates.flatMap(candidate => {
    const question = normalizeQuestion(candidate.question);
    if (!question || ![candidate.subject, candidate.coreQuestion, candidate.why].every(value => typeof value === 'string' && value.trim())) {
      rejected.push({ topic: candidate.topic.slice(0, 500), reason: '缺少具体问题、受众收益或2–3步调查方向' }); return [];
    }
    // Generation never promotes model-asserted sources/status into research.
    return [{ ...candidate, question, sources: [], research: undefined, researchAssessment: unresearchedAssessment() }];
  });
  // 搜索期间可能有反馈、手动入队或配置修改；始终在最新文件上合并。
  const fresh = readTopicSchedule(root);
  fresh.discoveryTopics = topicHistory(fresh);
  const known = [...fresh.discoveryTopics, ...fresh.items, ...fresh.runs].filter(item => !base ||
    !(item.id === base.id || item.discoveryId === base.id || `legacy-${item.id}` === base.id ||
      base.id.startsWith('legacy-') && !item.id && item.topic === base.topic || base.queueId && item.id === base.queueId));
  const picked = [];
  const added = [];
  for (const candidate of material) {
    if (picked.length >= config.count) break;
    const sources = sourceURLs(candidate.sources);
    const record = { ...topicDetails(candidate), topic: candidate.topic.trim().slice(0, 500), sources,
      id: randomUUID(), batchId, at, query: String(config.query).slice(0, 1000), mode: config.mode,
      status: base ? 'suggestion' : 'candidate', ...(base ? { parentId: base.id, followup: config.followup } : {}) };
    delete record.updateOf;
    delete record.newEvidence;
    const previous = duplicateOf(record, known);
    const sameParentTitle = base && normalized(record.topic) === normalized(base.topic);
    if (sameParentTitle || duplicateOf(record, picked) || previous && !validUpdate(candidate, previous)) {
      record.status = 'duplicate'; record.duplicateOf = sameParentTitle ? base.id : previous?.id || null;
    } else {
      if (previous) { record.updateOf = previous.id; record.newEvidence = candidate.newEvidence.trim().slice(0, 2000); }
      picked.push(record);
      known.push(record);
    }
    fresh.discoveryTopics.push(record);
  }
  if (base && picked.length) {
    const savedIds = new Set(picked.map(item => item.id));
    for (const record of fresh.discoveryTopics) {
      if (record.status === 'suggestion' && record.parentId === base.id && record.followup === config.followup && !savedIds.has(record.id)) {
        record.status = 'archived'; record.archiveReason = 'new-suggestion';
      }
    }
  }
  fresh.discovery = [...(fresh.discovery || []), {
    at, batchId, operation: 'questions', query: config.query, mode: config.mode, ...(base ? { parentId: base.id, followup: config.followup } : {}), candidates: candidates.length,
    suggested: picked.length, added: 0, skipped: candidates.length - picked.length, materialRejected: rejected.length,
  }].slice(-20);
  bumpDiscoveryRevision(fresh);
  writeSchedule(root, fresh);
  // Explicit automatic queueing pays for a separate investigation, never an
  // evidence-free shortcut. Keep the lock across both phases and re-read after
  // every await so feedback/configuration changes are not overwritten.
  const researchFailures = [];
  const researchHints = [];
  let hasHardSearchFailure = false;
  if (!base && options.origin === 'automatic' && automaticAtStart && config.autoQueue === true) {
    for (const record of picked) {
      let latest = readTopicSchedule(root);
      let current = topicHistory(latest).find(item => item.id === record.id);
      if (latest.discoveryConfig?.enabled !== true || latest.discoveryConfig?.autoQueue !== true) break;
      if (!current || current.status !== 'candidate' || current.feedback || current.placement === 'history') continue;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs < 1000) {
        researchFailures.push({ topicId: current.id, topic: current.topic, reason: '本轮自动调查总时限已用尽，剩余候选未继续调查' });
        break;
      }
      const investigated = await investigateTopic(root, current, { ...config, timeoutMs: remainingMs, operation: 'research', topicId: current.id });
      if (!investigated.ok) {
        const entry = { topicId: current.id, topic: current.topic, reason: investigated.reason || '自动调查失败',
          ...(investigated.hints?.length ? { hints: investigated.hints } : {}) };
        researchFailures.push(entry);
        if (Array.isArray(investigated.hints)) researchHints.push(...investigated.hints);
        const hardAuthOrQuota = Array.isArray(investigated.searchFailures)
          && investigated.searchFailures.some(item => item.tool === 'websearch' && ['401', '402', '403'].includes(String(item.status)));
        const hardSearchFailure = hardAuthOrQuota || (Array.isArray(investigated.searchFailures)
          && investigated.searchFailures.some(item => item.tool === 'websearch' && String(item.status) === '429'));
        if (hardAuthOrQuota) hasHardSearchFailure = true;
        const latestAfterFail = readTopicSchedule(root);
        latestAfterFail.discoveryTopics = topicHistory(latestAfterFail);
        const batchAfterFail = latestAfterFail.discovery?.find(item => item.batchId === batchId);
        if (batchAfterFail) {
          batchAfterFail.researchFailures = researchFailures.slice(0, 5).map(({ topicId, topic, reason }) => ({ topicId, topic, reason }));
        }
        if (!hardSearchFailure) {
          const failedRec = latestAfterFail.discoveryTopics.find(rec => rec.id === current.id);
          if (failedRec) {
            const webfetchFailures = Array.isArray(investigated.searchFailures)
              ? investigated.searchFailures.filter(f => f?.tool === 'webfetch').length
              : 0;
            const exhausted = investigated.aborted === 'failures' || investigated.aborted === 'no-page'
              || webfetchFailures >= Math.min(config.maxFetchFailures || DEFAULT_DISCOVERY.maxFetchFailures, 6);
            failedRec.autoResearchAttempts = exhausted
              ? MAX_AUTO_RESEARCH_ATTEMPTS
              : (Number(failedRec.autoResearchAttempts) || 0) + 1;
            failedRec.autoResearchLastAttemptAt = Date.now();
          }
        }
        writeSchedule(root, latestAfterFail);
        if (hardSearchFailure) break;
        continue; // no automatic paid retry
      }
      latest = readTopicSchedule(root);
      current = latest.discoveryTopics?.find(item => item.id === record.id);
      if (latest.discoveryConfig?.enabled !== true || latest.discoveryConfig?.autoQueue !== true) break;
      if (current?.status !== 'candidate' || current.feedback || current.placement === 'history' || !canEnqueueTopic(root, current)) {
        if (current?.status === 'candidate' && !canEnqueueTopic(root, current)) {
          const st = current.researchAssessment?.status;
          const label = st === 'insufficient' ? '材料不足' : st === 'reframe' ? '建议调整问题' : '原文依据未达入队条件';
          researchFailures.push({ topicId: current.id, topic: current.topic, status: st || 'unverified', reason: label });
        }
        continue;
      }
      const entry = enqueueCandidate(latest, current, { root });
      if (entry) added.push(entry);
      const batch = latest.discovery?.find(item => item.batchId === batchId);
      if (batch) batch.added = added.length;
      bumpDiscoveryRevision(latest);
      writeSchedule(root, latest);
    }
  }
  // 部分检索/读取失败时留下警告，便于判断这一批材料为什么偏少。
  const warnings = (result.research.failures || []).slice(0, 5).map(item =>
    (item.tool === 'websearch' ? '检索' : '读取') + '失败：' + (item.target || '') + ' · ' + item.error);
  for (const item of researchFailures.slice(0, 5)) warnings.push('自动调查未入队：' + item.topic + ' · ' + item.reason);
  warnings.push(...(result.cleanupWarnings || []));
  /* 超时后才产出的答案照常保存，但必须如实说明它来晚了，别让人以为一切正常。 */
  if (result.salvaged) warnings.unshift('本轮构思超出预算才收尾，已请求停止执行器；完整问题已保存，尚未调查');
  const finalRecords = readTopicSchedule(root).discoveryTopics || [];
  const mergedFailures = [...(drainedFallback?.researchFailures || []), ...researchFailures];
  const uniqueHints = [...new Set([...(drainedFallback?.hints || []), ...researchHints])];
  const mergedWarnings = [...(drainedFallback?.warnings || []), ...warnings];
  return { ok: true, added, results: picked.map(item => finalRecords.find(record => record.id === item.id) || item), candidates: candidates.length, skipped: candidates.length - picked.length,
    materialRejected: rejected.length, searchCount: result.research?.searches?.length || 0, ...(result.salvaged ? { salvaged: true } : {}),
    ...(hasHardSearchFailure ? { hardSearchFailure: true } : {}),
    ...(mergedFailures.length ? { researchFailures: mergedFailures } : {}),
    ...(uniqueHints.length ? { hints: uniqueHints } : {}),
    ...(mergedWarnings.length ? { warnings: mergedWarnings } : {}) };
}

const MAX_AUTO_RESEARCH_ATTEMPTS = 2;

/* 自动巡航优先消化已有未入队的旧候选（先入先出），避免反复生成新题导致旧候选积压。
 * - 已具备有效调查结果的候选直接入队；
 * - 未调查的旧候选按先入先出依次联网调查并入队（单题连续失败达上限后自动跳过，防止卡死）；
 * - 只有当所有可处理的旧候选都已清空时，才返回 null 交给上游生成新选题。 */
async function drainExistingCandidates(root, config, deadlineAt) {
  const initial = readTopicSchedule(root);
  const eligible = topicHistory(initial)
    .filter(item => {
      if (item.status !== 'candidate' || item.placement === 'history' || item.feedback || item.queueId) return false;
      if (canEnqueueTopic(root, item)) return true;
      const status = item.researchAssessment?.status;
      if (status && status !== 'unresearched') return false;
      return (Number(item.autoResearchAttempts) || 0) < MAX_AUTO_RESEARCH_ATTEMPTS;
    })
    .map(item => ({ item, ready: canEnqueueTopic(root, item) }))
    .sort((a, b) => Number(b.ready) - Number(a.ready)
      || (Number(a.item.autoResearchAttempts) || 0) - (Number(b.item.autoResearchAttempts) || 0)
      || (Number(a.item.at) || 0) - (Number(b.item.at) || 0));
  if (!eligible.length) return null;

  const added = [];
  const reused = [];
  const researchFailures = [];
  const researchHints = [];
  const maxResearchAttempts = Math.max(config.count + 1, 3);
  let researchedCount = 0;
  let encounteredHardSearchFailure = false;

  for (const { item: candidate } of eligible) {
    if (added.length >= config.count) break;
    let latest = readTopicSchedule(root);
    let current = topicHistory(latest).find(entry => entry.id === candidate.id);
    if (latest.discoveryConfig?.enabled !== true || latest.discoveryConfig?.autoQueue !== true) break;
    if (!current || current.status !== 'candidate' || current.feedback || current.placement === 'history' || current.queueId) continue;

    if (canEnqueueTopic(root, current)) {
      latest.discoveryTopics = topicHistory(latest);
      current = latest.discoveryTopics.find(entry => entry.id === candidate.id);
      if (!current) continue;
      const entry = enqueueCandidate(latest, current, { root });
      if (entry) { added.push(entry); reused.push(current); }
      bumpDiscoveryRevision(latest);
      writeSchedule(root, latest);
      continue;
    }

    if (researchedCount >= maxResearchAttempts) break;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 1000) {
      researchFailures.push({ topicId: current.id, topic: current.topic, reason: '本轮自动调查总时限已用尽，剩余旧候选留待下轮继续' });
      break;
    }
    researchedCount += 1;
    const investigated = await investigateTopic(root, current, { ...config, timeoutMs: remainingMs, operation: 'research', topicId: current.id });
    if (!investigated.ok) {
      const entry = { topicId: current.id, topic: current.topic, reason: investigated.reason || '自动调查失败',
        ...(investigated.hints?.length ? { hints: investigated.hints } : {}) };
      researchFailures.push(entry);
      if (Array.isArray(investigated.hints)) researchHints.push(...investigated.hints);
      const hardAuthOrQuota = Array.isArray(investigated.searchFailures)
        && investigated.searchFailures.some(f => f.tool === 'websearch' && ['401', '402', '403'].includes(String(f.status)));
      const hardSearchFailure = hardAuthOrQuota || (Array.isArray(investigated.searchFailures)
        && investigated.searchFailures.some(f => f.tool === 'websearch' && String(f.status) === '429'));
      if (hardAuthOrQuota) encounteredHardSearchFailure = true;
      if (!hardSearchFailure) {
        const latestAfterFail = readTopicSchedule(root);
        latestAfterFail.discoveryTopics = topicHistory(latestAfterFail);
        const failedRec = latestAfterFail.discoveryTopics.find(rec => rec.id === current.id);
        if (failedRec) {
          const webfetchFailures = Array.isArray(investigated.searchFailures)
            ? investigated.searchFailures.filter(f => f?.tool === 'webfetch').length
            : 0;
          const exhausted = investigated.aborted === 'failures' || investigated.aborted === 'no-page'
            || webfetchFailures >= Math.min(config.maxFetchFailures || DEFAULT_DISCOVERY.maxFetchFailures, 6);
          failedRec.autoResearchAttempts = exhausted
            ? MAX_AUTO_RESEARCH_ATTEMPTS
            : (Number(failedRec.autoResearchAttempts) || 0) + 1;
          failedRec.autoResearchLastAttemptAt = Date.now();
          writeSchedule(root, latestAfterFail);
        }
      }
      if (hardSearchFailure) break;
      continue;
    }

    latest = readTopicSchedule(root);
    latest.discoveryTopics = topicHistory(latest);
    current = latest.discoveryTopics.find(entry => entry.id === candidate.id);
    if (latest.discoveryConfig?.enabled !== true || latest.discoveryConfig?.autoQueue !== true) break;
    if (current?.status !== 'candidate' || current.feedback || current.placement === 'history' || !canEnqueueTopic(root, current)) {
      if (current?.status === 'candidate' && !canEnqueueTopic(root, current)) {
        const st = current.researchAssessment?.status;
        const label = st === 'insufficient' ? '材料不足' : st === 'reframe' ? '建议调整问题' : '原文依据未达入队条件';
        researchFailures.push({ topicId: current.id, topic: current.topic, status: st || 'unverified', reason: label });
      }
      continue;
    }
    const entry = enqueueCandidate(latest, current, { root });
    if (entry) { added.push(entry); reused.push(current); }
    bumpDiscoveryRevision(latest);
    writeSchedule(root, latest);
  }

  const warnings = researchFailures.slice(0, 5).map(item => '旧候选自动调查未入队：' + item.topic + ' · ' + item.reason);
  const uniqueHints = [...new Set(researchHints)];
  return {
    ok: true,
    reusedExisting: true,
    added,
    results: reused,
    candidates: 0,
    skipped: 0,
    materialRejected: 0,
    searchCount: 0,
    ...(encounteredHardSearchFailure ? { hardSearchFailure: true } : {}),
    ...(researchFailures.length ? { researchFailures } : {}),
    ...(uniqueHints.length ? { hints: uniqueHints } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

const BLOCKED_HOSTS_TTL_MS = 24 * 60 * 60 * 1000;
const BLOCKED_HOSTS_FILE = 'out/.vh-blocked-hosts.json';

function readBlockedHosts(root) {
  if (!root) return [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, BLOCKED_HOSTS_FILE), 'utf8'));
    const now = Date.now();
    return Object.entries(data || {})
      .filter(([, ts]) => typeof ts === 'number' && now - ts < BLOCKED_HOSTS_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([host]) => host);
  } catch {
    return [];
  }
}

function recordBlockedHosts(root, failures) {
  if (!root || !Array.isArray(failures) || !failures.length) return;
  const blocked = [];
  for (const item of failures) {
    if (item?.tool !== 'webfetch') continue;
    const isBlocked = ['401', '402', '403'].includes(String(item.status || ''))
      || /403|Access Denied|verify you are human|cloudflare|captcha/i.test(String(item.error || ''));
    if (!isBlocked || !item.target) continue;
    try {
      const host = new URL(item.target).hostname.toLowerCase();
      if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.test') || host.endsWith('.invalid')) continue;
      blocked.push(host);
    } catch {}
  }
  if (!blocked.length) return;
  const file = path.join(root, BLOCKED_HOSTS_FILE);
  const now = Date.now();
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  for (const [h, ts] of Object.entries(map)) {
    if (typeof ts !== 'number' || now - ts >= BLOCKED_HOSTS_TTL_MS) delete map[h];
  }
  for (const host of blocked) map[host] = now;
  const trimmed = Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 40));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

async function investigateTopic(root, target, config) {
  const avoidHosts = readBlockedHosts(root);
  const prompt = researchPrompt({ target, query: config.query, avoidHosts });
  const result = await runOpencode({ cwd: root, prompt, operation: 'research', model: config.model, agent: config.agent, home: config.home,
    timeoutMs: config.timeoutMs, stallMs: config.stallMs, noPageBudgetRatio: config.noPageBudgetRatio, maxFetchFailures: config.maxFetchFailures });
  recordBlockedHosts(root, result.research?.failures);
  const failure = reason => ({ ok: false, operation: 'research', topicId: target.id, reason, added: [],
    hints: result.hints || searchHints(result.research), searchFailures: result.research?.failures || [],
    ...(result.aborted ? { aborted: result.aborted } : {}), ...(result.cleanup ? { cleanup: result.cleanup } : {}) });
  if (!result.ok) return failure(result.reason);
  const candidate = parseResearchResult(result.text);
  if (!candidate) {
    const empty = !String(result.text || '').trim();
    return { ...failure(empty ? '调查未输出最终 JSON 结果（可能提前达到步数上限），原问题和已有材料保留' : '调查回答没有可解析的结果，原问题和已有材料保留'), raw: String(result.text || '').slice(0, 300) };
  }
  // Operational failures are not semantic evidence of a bad question.
  if (result.research.failures?.length && result.research.searches.length < 2) return failure(searchFailureReason(result.research) || '调查工具执行失败，已有材料保留');
  let assessment = normalizeResearchAssessment(candidate.researchAssessment);
  const at = Date.now(), batchId = randomUUID(), window = discoveryWindow(target.query || '', at);
  const validationContext = { why: candidate.why || target.why,
    outline: candidate.outline || target.outline || target.question?.investigate?.join('；') };
  const checked = result.research.searches.length >= 2
    ? assessDiscoveryCandidate({ ...candidate, ...validationContext }, {
      sources: sourceURLs(candidate.sources), research: result.research, now: at, window })
    : { ok: false, reason: '未取得至少两个不同查询的检索完成记录' };
  if (!assessment) {
    if (!checked.ok) return failure(checked.reason + '，原问题和已有材料保留');
    assessment = { version: 1, status: 'leads', finding: '找到可匹配工具返回原文的材料线索，不代表事实核证', gaps: [], suggestedQuestion: '' };
  }
  if (assessment.status === 'unresearched') return failure('调查未返回有效的调查判断，已有材料保留');
  if (assessment.status === 'leads' && !checked.ok) return failure(checked.reason + '，不能标记为已有线索；原有材料保留');
  // Tool errors without any readable material must not become a fabricated
  // semantic conclusion, even if the model labels them "insufficient".
  if (!checked.ok && result.research.failures?.length && !result.research.pages.length) return failure('调查未能读取原文，不能判断原题是否成立；已有材料保留');
  if (!assessment.finding) return failure('调查判断缺少说明，原问题和已有材料保留');
  const fresh = readTopicSchedule(root);
  fresh.discoveryTopics = topicHistory(fresh);
  const current = fresh.discoveryTopics.find(item => item.id === target.id);
  if (!current) return failure('原问题已不存在，未保存调查');
  if (current.coreQuestion !== target.coreQuestion || JSON.stringify(current.question) !== JSON.stringify(target.question)) return failure('原问题在调查期间已改变，未将材料绑定到不同问题');
  const recordPath = `out/topic-research/${batchId}.json`;
  fs.mkdirSync(path.dirname(path.join(root, recordPath)), { recursive: true });
  fs.writeFileSync(path.join(root, recordPath), JSON.stringify({ version: 1, operation: 'research', topicId: target.id,
    questionSnapshot: { topic: target.topic, coreQuestion: target.coreQuestion, question: target.question },
    batchId, at, query: target.query, window, searches: result.research.searches, pages: result.research.pages,
    validationContext,
    failures: result.research.failures || [], researchAssessment: assessment }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  current.researchAssessment = assessment;
  if (checked.ok) {
    current.sources = checked.sources;
    current.research = { ...checked.research, recordPath };
  } // insufficient/reframe with no valid new evidence keeps prior material
  fresh.discovery = [...(fresh.discovery || []), { at, batchId, operation: 'research', topicId: target.id,
    query: target.query, status: assessment.status, recordPath, added: 0 }].slice(-20);
  bumpDiscoveryRevision(fresh);
  writeSchedule(root, fresh);
  return { ok: true, operation: 'research', topicId: target.id, added: [], results: [],
    updated: { ...current, canEnqueue: canEnqueueTopic(root, current) }, recordPath,
    ...(result.salvaged ? { salvaged: true } : {}), warnings: result.cleanupWarnings || [] };
}

/* 手动工作进程和调度器共用锁。崩溃后只回收已退出进程的锁，不杀别的任务。 */
export async function discoverTopics(root, options = {}) {
  const file = path.join(root, 'out/.vh-topic-search.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  let locked = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      locked = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: '选题搜索锁无法读取，请确认没有搜索任务后检查锁文件', added: [] }; }
      try { process.kill(previous.pid, 0); return { ok: false, busy: true, reason: '已有选题检索在运行，请稍后再试', added: [] }; }
      catch (probe) { if (probe.code !== 'ESRCH') return { ok: false, reason: '无法确认选题搜索进程状态', added: [] }; }
      // 读取后再核对身份，避免删除已经换主的锁。
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === previous.token) fs.unlinkSync(file); } catch {}
    }
  }
  if (!locked) return { ok: false, busy: true, reason: '已有选题检索正在启动', added: [] };
  try {
    const queue = readTopicSchedule(root);
    queue.discoveryLastAttemptAt = Date.now();
    writeSchedule(root, queue);
    return await discover(root, options);
  } finally {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {}
  }
}
