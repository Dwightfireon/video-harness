import { stageLabel } from './project-progress.mjs';
import { repairRecovery, resumeWithRecovery, taskIdentity } from './repair-recovery.mjs';

const QUALITY = { 'not-checked': '尚未质检', checking: '正在质检', passed: '机器检查通过',
  failed: '机器检查未通过', stale: '回执已过期，产物有变化', unverified: '旧回执，尚未实时复核' };
const STATUS = { idle: '尚未提交任务', starting: '正在启动', running: '正在制作', completed: '制作任务已完成',
  failed: '任务失败', incomplete: '任务未完成', interrupted: '任务中断', paused: '任务暂停', cancelled: '任务已取消' };
const text = value => value == null ? '' : String(value);
const dateLabel = value => {
  if (!value) return '无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString('zh-CN', { hour12: false });
};
function recoveryTask(view) {
  const task = view?.task || {};
  if (task.repairRecovery || task.automationSummary || !view?.automation?.activePolicy) return task;
  // 旧服务的生产视图没有新字段时也不能把已耗尽预算包装成普通继续。
  return { ...task, automationSummary: { enabled: view.automation.activePolicy.enabled,
    repairUsed: view.repair?.used, repairLimit: view.repair?.limit, repairPhase: view.repair?.phase } };
}

/* 纯展示模型：不把任务结束、文件存在或历史回执当成质量验收。 */
export function productionView(view, { snapshot = null, stale = false, pending = '', cancelPending = false, resumePending = false } = {}) {
  const task = view?.task || {}, auto = view?.automation, quality = view?.quality || {}, repair = view?.repair || {};
  const cliBusy = [task, snapshot].some(value => value?.productionBusy && !value.taskRunning && !value.orphanRunning);
  const running = !!(task.running || task.orphanRunning || snapshot?.running || snapshot?.orphanRunning || cliBusy);
  const cancelling = !!(task.cancelling || snapshot?.cancelling || cancelPending);
  const blocked = !view || stale || !!pending;
  const staleStop = !!task.staleStopNotice;
  const recovery = repairRecovery(recoveryTask(view));
  const identityChanged = (snapshot?.taskId || snapshot?.id) && taskIdentity(snapshot) !== taskIdentity(task);
  /* A stale stop record describes a past failure that the current artifacts no
   * longer have. Showing its raw lastIssue would read as a live blocker. */
  const issues = [task.error?.message, task.pausedReason,
    ...(staleStop ? [] : [repair.lastIssue]),
    ...(['failed', 'stale'].includes(quality.state) ? [quality.reason] : [])].filter(Boolean).map(text);
  return {
    summary: !view ? '读取中…' : stale ? '非实时 · 保留上次状态' : cancelling ? '等待制作进程退出'
      : cliBusy ? '命令行制作执行中' : running ? '正在制作' : task.status === 'completed'
        ? view?.workflow?.releaseReviewRequired ? '制作已完成，发布审阅按所选策略执行' : '制作已完成，可观看 / 导出成片'
        : STATUS[task.status] || '等待用户操作',
    policy: !auto ? '正在读取默认模式…' : `未来任务：${auto.enabled ? '自动制作（默认生效）' : '自动制作已关闭'}`
      + ` · 最多修复 ${auto.maxRepairs} 轮 · ${auto.source === 'project' ? '项目设置' : '网页默认'}`
      + ` · ${view?.workflow?.profile === 'audited' ? '审校模式' : '内容优先，形式审核可选'}`
      + (view?.visualMode === 'hybrid-sdf' ? ' · 画面可按场混合' : ''),
    activePolicy: auto?.activePolicy
      ? `当前任务实际模式：${auto.activePolicy.enabled ? '自动制作' : '非自动制作'} · 最多修复 ${auto.activePolicy.maxRepairs} 轮`
      : '当前任务实际模式：无已登记策略（不由未来任务设置推断）',
    stage: cancelling ? '正在取消，等待登记进程退出；停止信号不代表已退出'
      : cliBusy ? '命令行制作执行中，不能从此处取消或继续'
        : task.stage ? `${stageLabel(task.stage)}（${text(task.stage)}）` : '尚无阶段记录',
    repair: staleStop ? `历史修复 ${repair.used ?? 0} / ${repair.limit ?? auto?.maxRepairs ?? 2} 轮 · 旧暂停已不成立，不再阻止继续`
      : `已用修复 ${repair.used ?? 0} / ${repair.limit ?? auto?.maxRepairs ?? 2} 轮 · `
        + ({ idle: '未在修复', repairing: '正在修复', stopped: '修复已停止' }[repair.phase] || '等待记录'),
    issues: [...new Set(issues)],
    quality: quality.state === 'passed' && quality.phase === 'pre-render' ? '渲染前机器检查通过（非最终验收）'
      : quality.state === 'passed' && quality.phase === 'final' ? '最终机器检查通过' : QUALITY[quality.state] || '尚未质检',
    qualityState: quality.state || 'not-checked',
    qualityReason: text(quality.reason),
    qualityPhase: quality.phase === 'pre-render' ? '渲染前检查' : quality.phase === 'final' ? '最终检查' : '尚无检查阶段',
    checked: `最近检查：${dateLabel(quality.checkedAt)}`,
    verified: `最近只读强核验：${dateLabel(quality.verifiedAt)}。轻量轮询不重新核验媒体。`,
    historical: ['unverified', 'stale'].includes(quality.state) ? '以下为历史检查记录，不代表当前文件有效。' : '',
    canCancel: !blocked && !cliBusy && running && !cancelling,
    showCancel: !cliBusy && (running || cancelling),
    recovery,
    canResume: !blocked && !running && !cancelling && !resumePending && !identityChanged
      && (recovery.blocked ? recovery.canExtend : !!task.canResume),
    canSave: !blocked && !running && !cancelling,
    canVerify: !!view && !pending && !running && !cancelling,
    cancelling,
  };
}

function validateView(value) {
  if (value?.version !== 1 || value.readOnly !== true || typeof value.automation?.enabled !== 'boolean'
    || !Number.isInteger(value.automation.maxRepairs) || value.automation.maxRepairs < 0 || value.automation.maxRepairs > 5
    || !value.task || !value.repair || !Array.isArray(value.quality?.checks) || !Object.hasOwn(QUALITY, value.quality.state)) {
    throw new Error('自动制作接口返回的数据不完整');
  }
  return value;
}

/* 只有显式点击继续才发起模型任务；刷新、保存、重连和核验均不派发制作。 */
export function attachProductionPanel(root, { project = '', fetchImpl = globalThis.fetch.bind(globalThis),
  document: doc = root.ownerDocument, intervalMs = 4000, autoStart = true, onTask = () => {},
  confirmImpl = doc?.defaultView?.confirm?.bind(doc.defaultView) ?? globalThis.confirm } = {}) {
  const el = (tag, content, cls) => {
    const node = doc.createElement(tag);
    if (content != null) node.textContent = content;
    if (cls) node.className = cls;
    return node;
  };
  const button = label => { const node = el('button', label); node.type = 'button'; return node; };
  const summary = el('summary'), summaryStatus = el('span', '读取中…', 'production-summary');
  const glance = el('span', '', 'production-glance');
  summary.append(el('strong', '自动制作'), summaryStatus, glance);
  const body = el('div', null, 'production-body');
  const policy = el('p'), activePolicy = el('p'), stage = el('p'), repair = el('p');
  const blockers = el('div', null, 'production-blockers');
  const qualityTitle = el('h3'), qualityReason = el('p'), phase = el('p'), checked = el('p'), verified = el('p');
  const note = el('p'), historical = el('p'), checks = el('ul', null, 'production-checks');
  const connection = el('div', '', 'production-connection'); connection.setAttribute('role', 'status');
  connection.setAttribute('aria-live', 'polite');
  const status = el('div', '', 'production-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', null, 'production-actions');
  const cancel = button('取消当前制作'), resume = button('继续原任务（会调用模型）'), verify = button('只读复核当前产物');
  cancel.dataset.action = 'cancel'; resume.dataset.action = 'resume'; verify.dataset.action = 'verify';
  actions.append(cancel, resume, verify);
  const help = el('p', '继续会调用模型，并可能启动配音与渲染、产生费用；制作或取消结束后可只读复核，不启动模型、TTS 或渲染。', 'production-help');
  const advanced = el('details', null, 'production-advanced'); advanced.append(el('summary', '高级设置（只影响未来任务）'));
  const form = el('div', null, 'production-settings');
  const enabledLabel = el('label'), enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = true;
  enabled.dataset.field = 'enabled'; enabledLabel.append(enabled, doc.createTextNode('自动完成制作、必要技术检查和有限修复'));
  const limitLabel = el('label', '最多修复轮次 '), limit = el('select'); limit.dataset.field = 'maxRepairs';
  for (let i = 0; i <= 5; i++) { const option = el('option', `${i} 轮${i === 2 ? '（默认）' : ''}`); option.value = String(i); limit.append(option); }
  limit.value = '2'; limitLabel.append(limit);
  const save = button('保存未来任务设置'); save.dataset.action = 'save';
  const settingsStatus = el('div'); settingsStatus.setAttribute('role', 'status'); settingsStatus.setAttribute('aria-live', 'polite');
  form.append(enabledLabel, limitLabel, save, settingsStatus); advanced.append(form);
  body.append(policy, activePolicy, stage, repair, actions, help, connection, status,
    blockers, qualityTitle, qualityReason, phase, checked, verified, historical, checks, note, advanced,
    el('p', '不会自动发布。机器检查通过不代表事实正确、审美合格或已完成人工审阅。', 'production-caution'));
  root.replaceChildren(summary, body);

  let view = null, snapshot = null, stale = true, fetchError = '', actionMessage = '', settingsError = '', settingsNotice = '';
  let pending = '', fetching = false, dirty = false, cancelPending = false, resumePending = false, resumeIdentity = '';
  let revision = 0, timer = null, disposed = false, expansionChosen = false;
  const url = (path, verifyNow = false) => path + '?p=' + encodeURIComponent(project) + (verifyNow ? '&verify=1' : '');
  const identity = task => JSON.stringify([task?.id, task?.attemptId, task?.status]);
  const model = () => productionView(view, { snapshot, stale, pending, cancelPending, resumePending });
  function paint() {
    if (disposed) return;
    const m = model(); summaryStatus.textContent = m.summary;
    glance.textContent = view ? `${view.automation.enabled ? '自动' : '手动'} · 修复 ${view.repair.used ?? 0}/${view.repair.limit ?? view.automation.maxRepairs} · ${m.quality}` : '';
    policy.textContent = m.policy; activePolicy.textContent = m.activePolicy;
    stage.textContent = '当前阶段：' + m.stage; repair.textContent = m.repair;
    blockers.replaceChildren();
    if (m.issues.length) {
      blockers.append(el('strong', '具体卡点'));
      for (const issue of m.issues) blockers.append(el('p', issue));
    } else blockers.append(el('p', view ? '暂无已报告卡点（不等于质检通过）。' : '等待读取卡点…'));
    qualityTitle.textContent = '质检：' + m.quality; qualityTitle.dataset.state = m.qualityState;
    qualityReason.textContent = m.qualityReason;
    phase.textContent = m.qualityPhase; checked.textContent = m.checked; verified.textContent = m.verified;
    historical.textContent = m.historical; note.textContent = text(view?.quality.note);
    checks.replaceChildren();
    for (const check of view?.quality.checks || []) {
      const item = el('li'); item.dataset.state = ['passed', 'failed'].includes(check.state) ? check.state : 'unknown';
      item.append(el('strong', `${text(check.label || check.id)}：${{ passed: '通过', failed: '未通过' }[check.state] || '待核验'}`));
      for (const issue of check.issues || []) {
        item.append(el('p', text(issue.message)));
        if (issue.hint) item.append(el('p', '建议：' + text(issue.hint)));
      }
      checks.append(item);
    }
    if (!checks.childNodes.length) checks.append(el('li', '暂无逐项检查记录。'));
    cancel.hidden = !m.showCancel; cancel.disabled = !m.canCancel;
    cancel.textContent = m.cancelling ? '正在取消，等待退出…' : '取消当前制作';
    resume.disabled = !m.canResume; resume.textContent = resumePending ? '继续请求已接收，等待状态更新…' : m.recovery.label;
    help.textContent = m.recovery.blocked ? m.recovery.reason + m.recovery.detail
      : '继续会调用模型，并可能启动配音与渲染、产生费用；制作或取消结束后可只读复核，不启动模型、TTS 或渲染。';
    verify.disabled = !m.canVerify; verify.textContent = pending === 'verify' ? '只读复核中…' : '只读复核当前产物';
    enabled.disabled = limit.disabled = !m.canSave;
    save.disabled = !m.canSave || !dirty; save.textContent = pending === 'save' ? '保存中…' : '保存未来任务设置';
    connection.textContent = fetchError ? '连接异常：' + fetchError + '。保留上次视图，非实时；只重试读取，不会自动生成或继续。'
      : !view ? '正在读取自动制作状态…' : doc.hidden ? '页面在后台，已暂停轮询；显示上次读取状态。' : '';
    status.textContent = actionMessage;
    settingsStatus.textContent = [settingsError, dirty ? '当前选择尚未保存。' : '', settingsNotice,
      !m.canSave && view && !pending ? '运行中、取消中或断连时不能保存设置。' : ''].filter(Boolean).join(' ');
  }
  function apply(result) {
    view = result; stale = false; fetchError = '';
    // Normal runs stay compact so controls do not push the preview below the
    // first screen. A blocked task opens its concrete issue once; never fight
    // the user's later native details toggle.
    if (!expansionChosen) {
      root.open = ['failed', 'paused', 'interrupted', 'incomplete'].includes(result.task.status) || ['failed', 'stale'].includes(result.quality.state);
      expansionChosen = true;
    }
    if (!dirty) { enabled.checked = result.automation.enabled; limit.value = String(result.automation.maxRepairs); }
    if (!result.task.running && !result.task.orphanRunning && !result.task.cancelling && !snapshot?.running && !snapshot?.orphanRunning) cancelPending = false;
    if (result.task.running || identity(result.task) !== resumeIdentity) resumePending = false;
    paint();
  }
  async function request(path, options = {}, verifyNow = false) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), verifyNow ? 35000 : 15000);
    try {
      const response = await fetchImpl(url(path, verifyNow), { cache: 'no-store', signal: controller.signal, ...options });
      let result;
      try { result = await response.json(); } catch { throw new Error(`接口返回无效数据（HTTP ${response.status}）`); }
      if (!response.ok || result?.error) {
        const error = new Error(response.status === 404 && path.startsWith('/_api/production')
          ? '当前工作台服务尚未提供新面板接口；请在任务结束后重新启动工作台再刷新，无需运行启用命令'
          : text(result?.error) || `请求失败（HTTP ${response.status}）`);
        error.status = response.status; throw error;
      }
      return result;
    } finally { clearTimeout(timeout); }
  }
  async function refresh({ verifyNow = false } = {}) {
    if (disposed || fetching && !verifyNow || pending && !verifyNow || doc.hidden && !verifyNow) return;
    fetching = true; const current = ++revision;
    if (verifyNow) { pending = 'verify'; actionMessage = ''; paint(); }
    try {
      const result = validateView(await request('/_api/production', {}, verifyNow));
      if (current === revision && !disposed) {
        apply(result);
        if (verifyNow) actionMessage = '只读复核已返回：' + productionView(result).quality + '。未启动制作。';
      }
    } catch (error) {
      if (current === revision && !disposed) {
        if (verifyNow && error.status >= 400 && error.status < 500) actionMessage = '只读复核未完成：' + error.message + '。未认定通过，没有自动重试。';
        else { stale = true; fetchError = error.message; }
      }
    } finally {
      if (current === revision) { fetching = false; if (verifyNow) pending = ''; paint(); }
    }
  }
  enabled.onchange = limit.onchange = () => {
    dirty = !view || enabled.checked !== view.automation.enabled || Number(limit.value) !== view.automation.maxRepairs;
    settingsError = settingsNotice = ''; paint();
  };
  save.onclick = async () => {
    if (save.disabled) return;
    const selection = { enabled: enabled.checked, maxRepairs: Number(limit.value) };
    pending = 'save'; ++revision; fetching = false; settingsError = settingsNotice = ''; paint();
    try {
      const result = validateView(await request('/_api/production/settings', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection) }));
      if (result.automation.enabled !== selection.enabled || result.automation.maxRepairs !== selection.maxRepairs) throw new Error('服务器未确认所选设置');
      dirty = false; settingsNotice = '设置已保存，仅影响未来任务；没有启动或继续制作。'; apply(result);
    } catch (error) {
      dirty = true; settingsError = '保存失败：' + error.message + '。选择已保留，没有自动重试。';
    } finally { pending = ''; paint(); }
  };
  async function act(kind) {
    if (kind === 'cancel' ? !model().canCancel : !model().canResume) return;
    pending = kind; ++revision; fetching = false; actionMessage = ''; paint();
    try {
      const result = kind === 'cancel' ? await request('/_api/chat/cancel', { method: 'POST' })
        : await resumeWithRecovery({ getTask: () => recoveryTask(view), confirmImpl,
          request: options => request('/_api/chat/resume', options) });
      if (!result) return;
      if (kind === 'cancel') {
        if (!result.cancelling && !result.cancelled) throw new Error('服务器未确认可取消的任务');
        cancelPending = !!result.cancelling;
        actionMessage = result.cancelling ? '取消请求已接收，等待登记进程退出；尚未确认停止。' : '服务器确认：登记进程已退出，任务已取消。';
      } else {
        if (result.ok !== true && !result.task) throw new Error('服务器未确认继续请求');
        resumeIdentity = identity(view?.task); resumePending = true;
        actionMessage = '继续请求已接收，等待执行状态；不代表制作或质检成功。';
      }
      if (result.task) onTask(result.task);
    } catch (error) { actionMessage = (kind === 'cancel' ? '取消' : '继续') + '请求失败：' + error.message + '。没有自动重试。'; }
    finally { pending = ''; paint(); await refresh(); }
  }
  cancel.onclick = () => act('cancel'); resume.onclick = () => act('resume');
  verify.onclick = () => { if (!verify.disabled) return refresh({ verifyNow: true }); };
  function visibility() { paint(); if (!doc.hidden) refresh(); }
  doc.addEventListener('visibilitychange', visibility);
  paint();
  if (autoStart) { refresh(); timer = setInterval(() => refresh(), Math.max(3000, intervalMs)); }
  return {
    refresh,
    setTaskSnapshot(value) { snapshot = value; paint(); },
    getState: () => ({ view, stale, dirty, pending }),
    dispose() { disposed = true; ++revision; clearInterval(timer); doc.removeEventListener('visibilitychange', visibility); },
  };
}
