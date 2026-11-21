/* 持久化任务结果：进程启动不代表制作成功，进程退出后仍须保留失败原因。 */
import fs from 'node:fs';
import { API_ERROR_LABELS } from './api-error-diagnostics.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, checkpointPath, taskDir, readCheckpoint } from './checkpoint.mjs';
import { automationPolicy, productionRepairRecovery, stoppedFailureStage } from './automation.mjs';
import { diagnosticLabel, certificateFailureReason } from './network-diagnostics.mjs';
import { deliverableState, projectDeliveryState, taskDeliveryState } from './deliverable.mjs';
import { processExists, reconcileCancellation, inspectRunProcesses } from './process-lifecycle.mjs';
import { readProductionLock, ownsProductionLock } from './production-lock.mjs';
import { artifactStatus, hashFile } from './artifact-status.mjs';
import { createTaskContract } from './task-contract.mjs';
import { observeTaskCompletion } from './task-completion.mjs';
import { isPureContinuation } from './change-contract.mjs';

const HOME = process.env.HOME || '';

const file = project => path.join(project, 'out', '.vh-task.json');
const active = new Set(['starting', 'running']);
function productionStatus(project, { reconcile = true, productionLease } = {}) {
  // Missing projects are still a valid read-only idle status (legacy callers).
  if (!fs.existsSync(project)) return { busy: false, reason: 'unlocked' };
  let lock;
  try { lock = readProductionLock(project, { recover: reconcile }); }
  catch { lock = { busy: true, reason: 'invalid-lock' }; }
  if (!lock.busy) return { ...lock, busy: false };
  // 上传租约也是同进程其它 HTTP 操作的写屏障，不能因 owner PID 相同而豁免。
  if (lock.owner?.active && lock.owner.command === 'publish-upload' && !ownsProductionLock(productionLease, project)) return { ...lock, busy: true };
  // Metadata failures/transactions fail closed. Normal lock transactions are
  // synchronous, so our own acquire/register critical section cannot overlap
  // this same-process read. Do not guess ownership of an unreadable lock.
  const known = ['owner-alive', 'participant-alive', 'child-alive', 'stale'];
  const busy = !known.includes(lock.reason) || !!lock.children?.length ||
    !!lock.participants?.some(item => item.pid !== process.pid) ||
    !!(lock.owner?.active && lock.owner.pid !== process.pid);
  return { ...lock, busy };
}
export function readTask(project) {
  try { return JSON.parse(fs.readFileSync(file(project), 'utf8')); } catch { return null; }
}
export function updateTask(project, id, patch, attemptId) {
  const current = readTask(project);
  if (!current || current.id !== id || (attemptId && current.attemptId !== attemptId)) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  // Legacy ask may report cancelled/failed in its signal/exit handler before
  // its detached tools have stopped. Only lifecycle reconciliation can finish
  // a persisted cancellation; late agent results must not clear this barrier.
  if (current.cancellation && patch.cancellation === undefined) {
    next.status = 'cancelling'; next.finishedAt = null; next.error = null;
  }
  atomicJSON(file(project), next);
  return next;
}
export function beginTask(project, message, mode, id = randomUUID()) {
  const processes = reconcileCancellation(project);
  if (processes.busy || processes.cancellation || productionStatus(project).busy) throw new Error('当前项目仍有执行进程或正在取消，未重复派发');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  const previous = readTask(project);
  if (previous) {
    const dir = taskDir(project, previous.id);
    atomicJSON(path.join(dir, 'task.json'), previous);
    for (const name of ['.vh-chat.log', '.vh-steer.json']) {
      try { fs.copyFileSync(path.join(project, 'out', name), path.join(dir, name)); } catch {}
    }
    // 旧任务排队指令不流入明确的新任务；原文件已保留在任务历史。
    try { fs.writeFileSync(path.join(project, 'out/.vh-steer.json'), '[]'); } catch {}
  } else if (fs.existsSync(path.join(project, 'out/.vh-chat.log'))) {
    const dir = taskDir(project, 'legacy-' + randomUUID());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(project, 'out/.vh-chat.log'), path.join(dir, '.vh-chat.log'));
  }
  const contract = createTaskContract(project, { mode, message });
  const task = { schemaVersion: 1, id, attemptId: randomUUID(), attemptNumber: 1, status: 'starting', message, mode, contract, pid: null,
    startedAt: Date.now(), updatedAt: Date.now(), error: null };
  atomicJSON(file(project), task);
  return task;
}
export function validateRepairExtension(project, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(key => !['additionalRepairs', 'taskId', 'attemptId'].includes(key)) ||
    ![1, 2].includes(input.additionalRepairs) || typeof input.taskId !== 'string' || !input.taskId ||
    typeof input.attemptId !== 'string' || !input.attemptId) {
    throw Object.assign(new Error('追加修复必须提供当前 taskId、attemptId 和 1 或 2 的 additionalRepairs'), { statusCode: 400 });
  }
  const task = readTask(project);
  // Validation is read-only, including cancellation/stale markers. Do not use
  // taskStatus here: its normal lifecycle reconciliation may write on a GET.
  const processes = inspectRunProcesses(project);
  if (!task || input.taskId !== task.id || input.attemptId !== task.attemptId || processes.busy ||
    processes.cancellation || task.cancellation || task.status !== 'paused' || productionStatus(project).busy || !retryInput(project)) {
    throw Object.assign(new Error('任务身份已过期或任务不是可恢复的预算暂停，未追加修复'), { statusCode: 409 });
  }
  let checkpoint;
  try { checkpoint = readCheckpoint(project, task.id); }
  catch (error) { error.statusCode = 409; throw error; }
  const recovery = repairRecoveryForTask(task, checkpoint);
  if (!recovery?.canExtend || recovery.limit + input.additionalRepairs > 5) {
    throw Object.assign(new Error('仅可为已耗尽预算的内容故障追加修复，且总上限不得超过 5 轮'), { statusCode: 409 });
  }
  return { automation: automationPolicy(project, { enabled: true, maxRepairs: recovery.limit + input.additionalRepairs }),
    extension: { id: randomUUID(), taskId: task.id, attemptId: task.attemptId, at: Date.now(),
      additionalRepairs: input.additionalRepairs, fromLimit: recovery.limit, toLimit: recovery.limit + input.additionalRepairs } };
}

function repairRecoveryForTask(task, checkpoint) {
  if (!checkpoint || checkpoint.status !== 'paused' || checkpoint.mode !== task.mode ||
    checkpoint.attemptId && checkpoint.attemptId !== task.attemptId ||
    checkpoint.pending?.some(item => item.status !== 'done') || checkpoint.uncertainCommands?.length) return null;
  return productionRepairRecovery(checkpoint.pipelineState?.productionRepairs, task.automation || checkpoint.automation);
}

/* Read-only: does the current state already satisfy the stage that failed? */
function stageArtifactsSatisfied(project, stage) {
  try {
    if (stage === 'build') {
      const stamp = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-state.json'), 'utf8')).genStamp;
      return !!stamp && stamp.scriptHash === hashFile(path.join(project, '脚本.md')) &&
        stamp.scenesHash === hashFile(path.join(project, 'scenes.src.js'));
    }
    if (stage === 'measure') {
      const timing = JSON.parse(fs.readFileSync(path.join(project, 'timing.json'), 'utf8'));
      return Number.isFinite(timing?.dur) && timing.dur > 0;
    }
    const status = artifactStatus(project);
    if (stage === 'render') return !status.stale.render;
    return !status.stale.render && !status.stale.voice && !status.stale.requirements && !status.stale.duration;
  } catch { return false; }
}

export function resumeTask(project, instruction = '', repairExtension) {
  const authorized = repairExtension ? validateRepairExtension(project, repairExtension) : null;
  const status = taskStatus(project);
  if (status.running || status.orphanRunning) throw new Error('当前项目仍有执行进程，未重复派发');
  if (!status.canResume) throw new Error('没有可继续的未完成任务');
  let current = readTask(project);
  if (!current) {
    const input = retryInput(project);
    current = beginTask(project, input.message, input.mode);
  }
  const resumeInstructions = [...(current.resumeInstructions || [])];
  const text = String(instruction || '').trim();
  // 运行中未送达的补充指令已持久保存；用户停止后直接继续时不要把同一段再追加一遍。
  const alreadyQueued = text && resumeInstructions.some(note => note?.source === 'chat-running-submit' && String(note.content || '').trim() === text);
  if (text && !alreadyQueued) resumeInstructions.push({ id: randomUUID(), content: text, at: Date.now() });
  const next = { ...current, attemptId: randomUUID(), attemptNumber: (current.attemptNumber || 1) + 1,
    status: 'starting', pid: null, error: null, pausedReason: null, finishedAt: null, updatedAt: Date.now(), attemptStartedAt: Date.now(),
    resume: true, resumeInstructions, resumeKind: status.resumeKind,
    ...(!isPureContinuation(instruction) ? { contract: createTaskContract(project, { mode: current.mode, message: instruction, previous: current.contract }) } : {}),
    ...(authorized ? { automation: authorized.automation,
      repairExtensions: [...(current.repairExtensions || []), authorized.extension] } : {}) };
  atomicJSON(file(project), next);
  return next;
}
export function taskError(detail = '', kind) {
  const text = String(detail?.detail || detail || '');
  let failures = Array.isArray(detail?.failures) ? detail.failures : [];
  if (!failures.length) {
    failures = [...text.matchAll(/(opendesign|commandcode)：(请求超时|额度不足|认证或渠道权限不可用|请求限流|网络连接失败|服务故障|返回格式异常)/g)].map(m => ({ provider: m[1], reason: m[2],
      kind: ({ '请求超时': 'timeout', '额度不足': 'quota', '认证或渠道权限不可用': 'auth', '请求限流': 'rate', '网络连接失败': 'network', '服务故障': 'server', '返回格式异常': 'response' })[m[2]] }));
  }
  if (failures.length) {
    const names = { opendesign: 'OpenDesign', commandcode: 'CommandCode' };
    const distinct = [...new Set(failures.map(f => f.kind))];
    return { kind: distinct.length > 1 ? 'channels' : distinct[0], failures,
      message: failures.map(f => (names[f.provider] || f.provider) + '：' + (certificateFailureReason(f.diagnostics?.networkCodes) || f.reason) +
        (Object.hasOwn(API_ERROR_LABELS, f.diagnostics?.apiCode || '') ? '（' + API_ERROR_LABELS[f.diagnostics.apiCode] + '）' : '') +
        (f.timeoutPhase ? '（' + ({ headers: '等待响应头', idle: '接收停滞', total: '总时限' })[f.timeoutPhase] + '，' + Math.round(f.timeoutMs / 1000) + '秒）' : '') +
        (f.diagnostics ? ' [' + diagnosticLabel(f.diagnostics) + ']' : '') +
        (f.attempts > 1 ? '（同渠道重试一次后仍失败）' : '')).join('；') + '。任务已暂停，原有进度已保留，可继续原任务。' };
  }
  kind ||= /额度不足|余额不足|insufficient_quota|quota_exhausted/i.test(text) ? 'quota'
    : /认证|权限|HTTP (401|403)/.test(text) ? 'auth'
    : /超时|timeout/i.test(text) ? 'timeout'
    : /网络|连接|network/i.test(text) ? 'network' : 'execution';
  const messages = {
    quota: '模型渠道额度不足，任务已停止。请先配置有余额的渠道，再手动重试。',
    auth: '模型渠道认证或权限不可用，任务已停止。请检查本机渠道配置后重试。',
    timeout: '模型请求超时，任务已停止。原始输入已保留，可手动重试。',
    network: '模型网络连接失败，任务已停止。原始输入已保留，可手动重试。',
    credentials: '没有已配置的模型渠道，任务尚未启动。请先在本机配置凭证。',
    startup: '制作进程未能正常启动。原始输入已保留，请检查启动日志后重试。',
    interrupted: '制作进程已退出，但没有留下完整结果。请查看已生成文件后再重试。',
    execution: '任务未完成。原始输入与执行日志已保留，请查看日志后重试。',
  };
  return { kind, message: messages[kind] || messages.execution };
}
export function finishTask(project, id, result, attemptId) {
  return updateTask(project, id, { status: result.status || 'failed', finishedAt: Date.now(),
    executionStatus: result.executionStatus || result.status || 'failed',
    completion: result.deliverable ? { stale: !!result.deliverable.stale, reason: result.deliverable.reason || null, kind: result.deliverable.kind || 'video' } : null,
    error: result.error ? (result.status === 'incomplete'
      ? { kind: result.kind || 'requirements', message: String(result.error) }
      : taskError({ detail: result.error, failures: result.providerFailures || [] }, result.kind))
      : result.ok || result.status === 'cancelled' || result.status === 'paused' ? null : taskError(),
    warnings: result.warns || [],
    ...(result.paused ? { pausedReason: result.paused } : {}),
    /* Clearing matters as much as setting: a stale "成片还没生成" left over from
     * an earlier attempt kept being shown after the video was actually done. */
    deliverableStale: result.deliverable?.stale ? result.deliverable.reason : null }, attemptId);
}
export function processAlive(pid) {
  return processExists(pid);
}
export function readTaskLog(project) {
  let fd;
  try {
    fd = fs.openSync(path.join(project, 'out', '.vh-chat.log'), 'r');
    const size = fs.fstatSync(fd).size, bytes = Math.min(size, 64000), buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
    return { text: buffer.toString('utf8'), size, mtime: fs.fstatSync(fd).mtimeMs };
  } catch { return { text: '', size: 0, mtime: 0 }; }
  finally { if (fd != null) fs.closeSync(fd); }
}
export function retryInput(project) {
  const task = readTask(project);
  if (task?.message) return { message: task.message, mode: task.mode || 'edit' };
  // 兼容修复前已经失败的“给选题/文章”任务，不要求用户重新粘贴材料。
  for (const [name, mode] of [['选题.md', 'topic'], ['原文.md', 'article']]) {
    try {
      const message = fs.readFileSync(path.join(project, 'materials', name), 'utf8').trim();
      if (message) return { message, mode };
    } catch {}
  }
  return null;
}
/* 正在跑的重型子进程（渲染/配音/构建）不会频繁写主日志；
 * 读工具日志的修改时间，避免把正常长任务误报成“90 秒无动作”。 */
export function activeTool(project) {
  let latest = 0, name = '';
  const dir = path.join(project, 'out/.vh-tool-logs');
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const stat = fs.statSync(path.join(dir, entry.name));
      if (stat.mtimeMs > latest) { latest = stat.mtimeMs; name = entry.name.replace(/^\d+-/, '').replace(/\.log$/, ''); }
    }
  } catch {}
  return latest ? { name, at: latest, recent: Date.now() - latest < 90000 } : null;
}
export function toolActive(project) { return !!activeTool(project)?.recent; }

export function taskStatus(project, { includeDeliverable = true, includeArtifactChecks = includeDeliverable, reconcile = true, productionLease } = {}) {
  const processes = reconcile ? reconcileCancellation(project) : inspectRunProcesses(project);
  const productionLock = productionStatus(project, { reconcile, productionLease }), productionBusy = productionLock.busy;
  const task = reconcile ? readTask(project) : processes.task, log = readTaskLog(project);
  const run = processes.run;
  const alive = processes.alive;
  const orphanRunning = processes.orphanRunning;
  const cancelling = !!processes.cancellation || task?.status === 'cancelling';
  const starting = task?.status === 'starting' && !task.pid && Date.now() - (task.attemptStartedAt || task.startedAt) < 15000;
  const paused = task?.status === 'paused';
  let status = task?.status || 'idle', error = task?.error || null;
  if (cancelling) { status = 'cancelling'; error = null; }
  else if (alive || starting) status = task?.status === 'starting' ? 'starting' : 'running';
  else if (paused) { status = 'paused'; error = null; }
  else if (active.has(status)) { status = 'interrupted'; error = taskError('', 'interrupted'); }
  else if (!task && log.text) {
    const failure = [...log.text.matchAll(/^模型调用失败：(.+)$/gm)].at(-1);
    if (failure) { status = 'failed'; error = taskError(failure[1]); }
    else if (/已取消|结束（退出 (130|143)）/.test(log.text)) status = 'cancelled';
    else if (/结束（退出 [1-9]/.test(log.text)) { status = 'failed'; error = taskError(); }
    else if (/✓ 结束|══ 完成/.test(log.text)) status = 'completed';
    else { status = 'interrupted'; error = taskError('', 'interrupted'); }
  }
  // 旧任务把两渠道故障归成一个「额度不足」。仅改读出展示，保留原记录不回写。
  if (status === 'failed' && !error?.failures && !['startup', 'credentials'].includes(error?.kind)) {
    const attemptLog = log.text.split(/^══ (?:用户|继续原任务|任务已提交).*$/m).at(-1);
    const latestFailure = [...attemptLog.matchAll(/^模型调用失败：(.+)$/gm)].at(-1);
    if (latestFailure) {
      const parsed = taskError(latestFailure[1]);
      if (parsed.failures?.length) error = parsed;
    }
  }
  const actions = log.text.split('\n').filter(line => line.startsWith('· '));
  const taskRunning = status === 'starting' || status === 'running' || status === 'cancelling';
  const running = taskRunning || productionBusy;
  if (productionBusy && !taskRunning && !orphanRunning) status = 'running';
  /* 已完成的任务也要能继续：用户看完成片想加个片尾广告是常见需求。
   * 旧逻辑把 completed 排除在外，页面直接不显示"继续"，输入框等于没用。
   * 但要注意：completed 不能走"恢复检查点"（会被判定原任务已结束），
   * 它走的是"在同一项目上开一个新任务"。所以 canResume 保持 false，
   * 用 canContinueAfterDone 单独表达"可以接着改"。 */
  /* 任务被取消但产物已经齐了：这是「结果达成、流程没走完」的常见情形
   * （用户在中途点了停止，或调度器把僵尸项回收了）。
   * 这时让界面劝人「继续原任务」是错的——继续只会重跑一遍已经做完的事。
   * 用 delivered 单独表达：产物齐了，不需要继续。 */
  const deliverable = (() => {
    if (!includeDeliverable) return null;
    if (!['completed', 'failed', 'paused', 'cancelled', 'interrupted', 'incomplete'].includes(status)) return null;
    const live = task?.execution?.runner === 'opencode' ? observeTaskCompletion(project, task)
      : ['edit-copy', 'edit-script', 'edit-visual'].includes(task?.mode) ? taskDeliveryState(project, task.mode)
      : ['article', 'topic'].includes(task?.mode) ? projectDeliveryState(project) : deliverableState(project);
    return { stale: !!live.stale, reason: live.reason || null, kind: live.kind };
  })();
  const delivered = ['cancelled', 'failed', 'interrupted', 'incomplete'].includes(status) &&
    deliverable && !deliverable.stale && deliverable.kind !== 'response';
  const canResume = !running && !orphanRunning &&
    ['failed', 'cancelled', 'incomplete', 'interrupted', 'paused'].includes(status) &&
    !delivered && !!retryInput(project);
  const canContinueAfterDone = !running && !orphanRunning && status === 'completed';
  const hasCheckpoint = !!task && fs.existsSync(checkpointPath(project, task.id));
  const pausedReason = status === 'paused'
    ? (task?.pausedReason || '任务在单次执行步数上限处暂停，检查点已保存；继续会从当前进度接着做。') : null;
  let session = null;
  if (task?.execution?.runner === 'opencode') {
    try { session = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-runner.json'), 'utf8')); } catch {}
    if (session?.taskId !== task.id || typeof session?.sessionId !== 'string') session = null;
  }
  const resumeNotice = pausedReason || (session ? '接续原 OpenCode 会话，并发送尚未确认接收的补充要求；先核对已有文件与不确定副作用，不保证工具精确重放恢复。' : hasCheckpoint ? '继续原任务，恢复对话与已记录工具结果；未确认完成的工具先核对，不自动重放。'
      : '旧任务没有检查点：保留原目标，先核对现有文件再继续，不保证精确恢复。');
  const resumeKind = session ? 'session' : hasCheckpoint ? 'checkpoint' : status === 'paused' ? 'paused' : 'files';
  // One observation per status call, including a failed read. Do not retain it
  // across requests: edits/corruption must be observed by the next poll/resume.
  let checkpoint = null;
  if (status === 'paused' && hasCheckpoint) {
    try { checkpoint = readCheckpoint(project, task.id); } catch {}
  }
  let repairRecovery = null;
  if (status === 'paused' && !running && !orphanRunning && !cancelling && canResume && hasCheckpoint) {
    try { repairRecovery = repairRecoveryForTask(task, checkpoint); } catch {}
  }
  /* The recorded pause describes the moment it happened. If the actual
   * artifacts have since been produced (for example the user completed the
   * stage from the CLI), keep the history but do not present it as the current
   * blocker or imply that "continue" will run another model repair round. */
  let staleStopNotice = null;
  if (includeArtifactChecks && status === 'paused' && !repairRecovery && hasCheckpoint) {
    try {
      const stoppedStage = checkpoint?.pipelineState?.productionRepairs?.stop ? stoppedFailureStage(checkpoint.pipelineState.productionRepairs) : null;
      if (stoppedStage && stageArtifactsSatisfied(project, stoppedStage)) {
        staleStopNotice = '上一条暂停记录已不成立：' + stoppedStage + ' 的实际产物已就绪；已用修复次数仍保留，继续不会自动增加预算。';
      }
    } catch {}
  }
  /* 本次实际用的渠道与模型（来自 agent 写下的 state）。
   * 界面上要能看见"这次跑的是哪个渠道" —— 否则切了渠道却看不出来，
   * 容易误以为切换没生效。
   *
   * ⚠ 失败信息里的渠道是**那次执行**用的，不一定是当前设置里的。
   * 两者必须分开报：用户切了渠道却看到旧渠道名，就会以为切换没生效。 */
  let used = null, usedProvider = null, selectedNow = null, pipeline = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(project, 'out', '.vh-state.json'), 'utf8'));
    if (st.pipeline?.taskId === task?.id && (!st.pipeline.attemptId || st.pipeline.attemptId === task?.attemptId)) pipeline = st.pipeline;
    if (st?.agent?.provider) {
      usedProvider = st.agent.provider;
      used = usedProvider + (st.agent.model ? ' / ' + st.agent.model : '');
    }
  } catch {}
  if (task?.execution?.runner === 'opencode') {
    usedProvider = task.execution.provider || null;
    used = [usedProvider, task.execution.model].filter(Boolean).join(' / ') || null;
  }
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(HOME, '.config', 'video-harness', 'providers.json'), 'utf8'));
    selectedNow = typeof settings.preferredProvider === 'string' ? settings.preferredProvider : null;
  } catch {}
  return { taskId: task?.id || null, status, running, taskRunning, productionBusy, productionLock,
    /* 运行期警告（中途断线后恢复、收尾非零但交付完整）：只读转出，不改状态判定。 */
    warnings: Array.isArray(task?.warnings) ? task.warnings.filter(item => typeof item === 'string' && item.trim()) : [],
    since: task?.attemptStartedAt || task?.startedAt || run?.startedAt || Date.parse(productionLock.owner?.started || '') || 0,
    attemptId: task?.attemptId || null, attemptNumber: task?.attemptNumber || 0,
    automationSummary: task?.automation ? { enabled: task.automation.enabled === true,
      repairUsed: Number.isInteger(task.automationProgress?.used) ? Math.max(0, task.automationProgress.used) : 0,
      repairLimit: Number.isInteger(task.automation.maxRepairs) ? task.automation.maxRepairs : 2,
      repairPhase: ['repairing', 'stopped'].includes(task.automationProgress?.phase) ? task.automationProgress.phase : 'idle' } : null,
    orphanRunning, cancelling, ...(repairRecovery ? { repairRecovery } : {}),
    ...(staleStopNotice ? { staleStopNotice } : {}),
    label: productionBusy && !taskRunning ? '命令行正在制作：' + (productionLock.owner?.command || '生产锁待确认')
      : task?.message?.slice(0, 30) || run?.label || '', mode: task?.mode || run?.mode || null,
    provider: used, execution: task?.execution || null, executionStatus: task?.executionStatus || null,
    completionKind: deliverable?.kind || task?.completion?.kind || null,
    stage: pipeline?.stage || null, stageSince: pipeline?.since || null,
    usedProvider, selectedProvider: selectedNow,
    /* 选中的渠道与上次执行用的不是同一个时，明确提示：
       "你切了渠道，但还没重新开始执行，所以看到的是上次的渠道"。 */
    channelMismatch: !!(usedProvider && selectedNow && usedProvider !== selectedNow && !running),
    error: cancelling ? { kind: 'cancelling', message: '正在取消；尚未确认所有进程退出，暂不重复派发。' }
      : orphanRunning ? { kind: 'orphan', message: '上一次工具的子进程仍在执行，暂不重复派发；可以等待或取消。' }
        : productionBusy && !taskRunning ? { kind: 'production', message: '项目仍有命令行制作进程或生产锁尚未确认，暂不派发任务、删除、清缓存或改幅。请在原终端等待或取消。' } : error,
    canRetry: canResume, canResume, canContinueAfterDone, delivered, resumeKind,
    resumeNotice, pausedReason: staleStopNotice || pausedReason, ...(staleStopNotice ? { staleStopNotice } : {}),
    deliverableStale: deliverable && deliverable.stale ? deliverable.reason : null,
    steps: actions.length, last: actions.at(-1)?.slice(2, 110) || '',
    tail: log.text.slice(-6000), mtime: log.mtime, bytes: log.size,
    /* 渲染/配音阶段主日志不会每帧更新，但工具日志与子进程仍活着。
     * 只按主日志静默 90 秒就报"卡住"会误伤长渲染（真实误报：ffmpeg 正在编码第 6 段）。 */
    stalled: taskRunning && !toolActive(project) && Date.now() - (log.mtime || task?.startedAt || Date.now()) > 90000,
    activeTool: running ? activeTool(project) : null };
}
