/* 持久化的每日待发队列。只编排注入的 getCandidate/submitOne，独立于制作、HTTP、Electron。
 * 配置变更与时点认领用同一跨进程锁；先落盘认领，再投稿。崩溃不重放，失败暂停。
 * 投稿自己的账号锁/视频指纹/未知结果保护仍由原有事务执行，不能用此处的队列代替。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireProductionLock } from './production-lock.mjs';
import { normalizeTimes, normalizePending, normalizeScope, normalizePublishTrigger, duePublish, nextReadyAt, upcomingSlots } from '../desk/publish-schedule.mjs';

const initial = () => ({ version: 1, revision: 0, enabled: false, times: ['20:00'], ids: [],
  scope: { kind: 'selected' }, trigger: { kind: 'daily' }, activatedAt: 0, accountKey: null, partition: null,
  autoPartition: true, lastSlot: '', lastAttempt: null, lastSubmittedAt: 0, pauseReason: '' });

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export function createPublishScheduler({ root, accountKey, getCandidate, submitOne, clock = Date.now,
  listScopeIds = plan => plan.ids, onSubmitted = null, onError = () => {}, intervalMs = 10000 }) {
  const dir = path.join(root, 'out', '.publish-schedule'), file = path.join(dir, 'state.json');
  let timer, stopped = true, ticking = false, activeAttemptId = '', errorMessage = '', pendingPause = '', stopVersion = 0;

  function isAttemptActive(attempt) {
    if (attempt?.state !== 'running') return false;
    if (activeAttemptId && attempt.attemptId === activeAttemptId) return true;
    if (Number.isSafeInteger(attempt.pid) && attempt.pid > 0 && attempt.pid !== process.pid) {
      return pidAlive(attempt.pid);
    }
    return false;
  }

  function read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return initial(); throw new Error('发布排程状态不可读，已停止自动发布：' + error.message); }
    if (![1, 2].includes(data.version) || !Number.isSafeInteger(data.revision) || typeof data.enabled !== 'boolean' ||
      !Number.isFinite(data.activatedAt) || typeof data.lastSlot !== 'string' ||
      (data.lastAttempt && !['running', 'submitted', 'failed', 'waiting'].includes(data.lastAttempt.state))) throw new Error('发布排程状态损坏，已停止自动发布');
    normalizeTimes(data.times); normalizePending(data.ids);
    data.scope = normalizeScope(data.scope);
    data.trigger = normalizePublishTrigger(data.trigger);
    // 旧版服务不能把已授权的 ready 队列误当成每日时点队列。
    if ((data.version === 2) !== (data.trigger.kind === 'ready')) throw new Error('发布方式与状态版本不匹配，已停止自动发布');
    data.autoPartition = data.autoPartition !== false;
    data.lastSubmittedAt ??= data.lastAttempt?.state === 'submitted' ? (data.lastAttempt.finishedAt ?? 0) : 0;
    if (!Number.isSafeInteger(data.lastSubmittedAt) || data.lastSubmittedAt < 0) throw new Error('上次收稿时间无效，已停止自动发布');
    if (data.enabled && (!data.accountKey || !data.partition)) throw new Error('发布排程缺少账号或分区，已停止自动发布');
    return data;
  }
  function write(data) {
    data.revision++;
    const temp = path.join(dir, `state-${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  function mutate(fn) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = acquireProductionLock(dir, { command: 'publish-schedule', env: {} });
    try { return fn(read()); } finally { lock.release(); }
  }
  function view() {
    const data = read();
    const calendar = data.trigger.kind === 'daily' ? upcomingSlots(data, clock()) : [];
    const next = calendar.find(day => day.times.length);
    return { ...data, attemptActive: isAttemptActive(data.lastAttempt),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      calendar, nextSlot: next ? `${next.day} ${next.times[0]}` : null, nextReadyAt: nextReadyAt(data), error: errorMessage,
      accountMatches: !data.accountKey || data.accountKey === accountKey() };
  }
  function reconcileSubmitted({ id, bvid = null, finishedAt = clock(), message = '' } = {}) {
    if (!id || typeof id !== 'string') return false;
    let updated = false;
    mutate(data => {
      if (data.lastAttempt?.state !== 'running' || data.lastAttempt.id !== id || isAttemptActive(data.lastAttempt)) return;
      const doneAt = Number.isSafeInteger(finishedAt) && finishedAt > 0 ? finishedAt : clock();
      data.lastAttempt = {
        ...data.lastAttempt,
        state: 'submitted',
        outcome: 'submitted',
        message: message || '已由人工手动投稿完成，排程记录已自动同步',
        bvid: bvid || data.lastAttempt.bvid || null,
        finishedAt: doneAt,
      };
      data.ids = data.ids.filter(item => item !== id);
      data.lastSubmittedAt = Math.max(data.lastSubmittedAt || 0, doneAt);
      write(data);
      updated = true;
    });
    return updated;
  }
  function save(input) {
    mutate(data => {
      if (input.revision !== data.revision) throw new Error('排程已变化，请刷新后再保存');
      const action = input.action || (input.enabled === false ? 'pause' : 'enable');
      if (!['save', 'enable', 'pause', 'reconcile'].includes(action)) throw new Error('不支持的排程操作');
      if (action === 'reconcile') {
        if (input.confirmed !== true) throw new Error('解除未结束投稿记录需要明确确认');
        if (data.lastAttempt?.state !== 'running') throw new Error('当前没有未结束的投稿记录');
        if (isAttemptActive(data.lastAttempt)) throw new Error('当前投稿仍在执行中，请等待本次处理结束');
        const submitted = input.resolution === 'submitted';
        const doneAt = clock();
        data.lastAttempt = {
          ...data.lastAttempt,
          state: submitted ? 'submitted' : 'failed',
          outcome: submitted ? 'submitted' : 'interrupted',
          message: submitted
            ? '已人工核对确认平台收稿，解除上次中断记录'
            : '已人工核对确认平台未收稿，解除上次中断记录',
          bvid: input.bvid || data.lastAttempt.bvid || null,
          finishedAt: doneAt,
        };
        if (submitted) {
          data.ids = data.ids.filter(id => id !== data.lastAttempt.id);
          data.lastSubmittedAt = Math.max(data.lastSubmittedAt || 0, doneAt);
        }
        data.enabled = false;
        data.pauseReason = '';
        write(data);
        return;
      }
      if (action !== 'pause') {
        if (data.lastAttempt?.state === 'running') throw new Error('上次投稿尚未完整结束，请先人工核对稿件；不能更改排程');
        if (data.trigger.kind === 'ready' && input.trigger === undefined) throw new Error('请刷新到支持成片后投稿的发布台再配置');
        data.trigger = normalizePublishTrigger(input.trigger === undefined ? data.trigger : input.trigger);
        data.version = data.trigger.kind === 'ready' ? 2 : 1;
        data.times = normalizeTimes(input.times ?? data.times);
        data.ids = normalizePending(input.ids ?? data.ids);
        data.scope = normalizeScope(input.scope ?? data.scope);
        if (input.partition !== undefined) data.partition = input.partition ? {
          tid: input.partition.tid, partitionTaxonomy: input.partition.partitionTaxonomy,
          humanType2: input.partition.humanType2, label: String(input.partition.label || '').slice(0, 100),
        } : null;
        if (typeof input.autoPartition === 'boolean') data.autoPartition = input.autoPartition;
      }
      if (action === 'enable') {
        if (input.confirmed !== true) throw new Error('启用自动发布需要明确确认');
        const key = accountKey();
        if (!key) throw new Error('先登录账号再启用自动发布');
        if (!data.partition || !Number.isInteger(data.partition.tid) || data.partition.tid <= 0) throw new Error('请选择投稿分区');
        data.accountKey = key; data.enabled = true; data.activatedAt = clock(); data.pauseReason = '';
      } else {
        data.enabled = false; // 修改配置撤销旧授权；暂停不清空配置或撤销已开始的投稿。
        if (action === 'save') { data.accountKey = null; data.activatedAt = 0; data.pauseReason = ''; }
      }
      write(data);
    });
    errorMessage = '';
    pendingPause = '';
    return view();
  }

  function pause(reason) {
    if (!read().enabled) return;
    mutate(data => { if (data.enabled) { data.enabled = false; data.pauseReason = reason; write(data); } });
  }
  function reconcileAccount() {
    const data = read();
    if (data.enabled && data.accountKey !== accountKey()) { pause('账号已切换或退出，请重新确认自动发布'); return false; }
    return true;
  }
  const lockBusy = error => error.code === 'PRODUCTION_LOCK_BUSY' &&
    ['owner-alive', 'participant-alive', 'metadata-transaction'].includes(error.status?.reason);
  async function receipt(fn) {
    // 只重试本地回执的短锁竞争，不重试任何上传或远端动作。
    for (let n = 0; ; n++) {
      try { return mutate(fn); }
      catch (error) {
        if (!lockBusy(error) || n >= 20) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }

  async function tick() {
    if (ticking) return { reason: 'busy' };
    ticking = true;
    let claimedAttempt = false;
    const lifecycle = stopVersion;
    try {
      if (pendingPause) {
        await receipt(data => { data.enabled = false; data.pauseReason = pendingPause; write(data); });
        pendingPause = '';
        return { reason: 'paused' };
      }
      if (!reconcileAccount()) return { reason: 'account-changed' };
      const snapshot = read(), slot = duePublish(snapshot, clock());
      if (!slot) return { reason: 'not-due' };
      // 没有待发项目不读素材、不上传、不落投稿尝试。
      const ids = normalizePending(await listScopeIds(snapshot));
      if (!ids.length) return { reason: 'empty' };
      let candidate;
      for (const id of ids) {
        candidate = await getCandidate(id);
        if (candidate) break;
      }
      if (!candidate) return { reason: 'empty' };
      if (lifecycle !== stopVersion) return { reason: 'stopped' };
      if (!(await listScopeIds(snapshot)).includes(candidate.id)) return { reason: 'changed' };
      if (lifecycle !== stopVersion) return { reason: 'stopped' };
      const attemptId = randomUUID();
      const claimed = mutate(data => {
        // 扫描素材期间可能已暂停、编辑、跨分钟，或被另一服务认领。
        if (data.revision !== snapshot.revision || duePublish(data, clock())?.key !== slot.key) return false;
        if (data.trigger.kind === 'daily') data.lastSlot = slot.key;
        data.lastAttempt = { attemptId, state: 'running', id: candidate.id, slot: slot.key, at: clock(), pid: process.pid };
        write(data);
        return true;
      });
      if (!claimed) return { reason: 'changed' };
      claimedAttempt = true;
      activeAttemptId = attemptId;
      let result;
      try {
        result = snapshot.accountKey === accountKey()
          ? await submitOne(candidate, snapshot.partition, snapshot.accountKey, snapshot)
          : { ok: false, outcome: 'not-submitted', message: '账号已变化，未投稿' };
      } catch (error) { result = { ok: false, outcome: 'unknown', message: error.message }; }
      let submittedFinishedAt = 0;
      await receipt(data => {
        if (data.lastAttempt?.attemptId !== attemptId) throw new Error('排程投稿回执不匹配，请人工核对');
        const finishedAt = clock();
        data.lastAttempt = { ...data.lastAttempt, state: result.ok ? 'submitted' : result.waiting ? 'waiting' : 'failed',
          outcome: result.outcome, message: result.message || '', bvid: result.bvid || null, finishedAt };
        if (result.ok) {
          submittedFinishedAt = finishedAt;
          data.ids = data.ids.filter(id => id !== candidate.id);
          data.lastSubmittedAt = data.lastAttempt.finishedAt;
        }
        else if (!result.waiting) data.enabled = false;
        write(data);
      });
      if (result.ok && typeof onSubmitted === 'function') {
        try {
          await onSubmitted({ id: candidate.id, bvid: result.bvid || null, finishedAt: submittedFinishedAt });
        } catch (error) {
          onError(error);
        }
      }
      return { reason: result.ok ? 'submitted' : result.waiting ? 'waiting' : 'paused', result };
    } catch (error) {
      if (lockBusy(error) && !claimedAttempt) return { reason: 'busy' };
      errorMessage = error.message; onError(error);
      pendingPause ||= '排程检查失败，已暂停：' + error.message;
      try {
        await receipt(data => { data.enabled = false; data.pauseReason = pendingPause; write(data); });
        pendingPause = '';
      } catch { /* 暂停意图保留；下轮必须先落盘暂停，不会再次扫描或投稿。 */ }
      return { reason: 'error', message: error.message };
    } finally { activeAttemptId = ''; ticking = false; }
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    const run = async () => {
      if (stopped) return;
      await tick();
      if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); }
    };
    void run();
  }
  function stop() { stopped = true; stopVersion++; clearTimeout(timer); }
  return { view, save, pause, reconcileAccount, reconcileSubmitted, tick, start, stop };
}
