/* 全自动巡航编排器（极薄低耦合层，纯依赖注入）。
 *
 * 职责边界：
 * - 不直接依赖 HTTP、DOM、OpenCode 细节或 B 站投稿实现。
 * - 只串联 4 个既有独立能力：自动选题调查入队 → 冷却间隔 → 串行单支制作 → 监听自动投稿状态。
 * - 任何一环报错、制作未交付、或自动投稿触发限流/暂停，立刻熔断停止巡航，绝不盲目重试或顶风投稿。
 * - 配置持久化到 out/.autopilot.json；巡航开关本身在服务重启后安全复位为关闭，避免意外无人值守消耗额度。
 */
import fs from 'node:fs';
import path from 'node:path';

const RUNNING_STATES = new Set(['starting', 'running', 'cancelling']);
const NON_RETRYABLE_KINDS = new Set(['quota', 'auth', 'credentials']);
const FAILURE_LABELS = {
  failed: '制作失败',
  paused: '已暂停（可进入项目继续）',
  cancelled: '已停止',
  interrupted: '制作中断',
  incomplete: '尚未完成',
};

export const DEFAULT_AUTOPILOT_CONFIG = Object.freeze({
  query: 'AI、LLM、Agent、机器学习',
  mode: 'focused',
  count: 3,
  buildGapMinutes: 5,
  publishIntervalSeconds: 300,
  minQueueSize: 1,
  autoPartition: true,
  autoPrune: true,
});

export function normalizeAutopilotConfig(raw = {}, base = DEFAULT_AUTOPILOT_CONFIG) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const query = typeof src.query === 'string' && src.query.trim()
    ? src.query.trim().slice(0, 1000)
    : base.query;
  const mode = ['focused', 'explore', 'recent'].includes(src.mode) ? src.mode : base.mode;
  const countNum = Number(src.count);
  const count = Number.isInteger(countNum) && countNum >= 1 && countNum <= 10 ? countNum : base.count;
  const gapNum = Number(src.buildGapMinutes);
  const buildGapMinutes = Number.isFinite(gapNum) && gapNum >= 0 && gapNum <= 1440
    ? Math.round(gapNum)
    : base.buildGapMinutes;
  const pubNum = Number(src.publishIntervalSeconds);
  const publishIntervalSeconds = Number.isFinite(pubNum) && pubNum >= 60 && pubNum <= 86400
    ? Math.round(pubNum)
    : base.publishIntervalSeconds;
  const minNum = Number(src.minQueueSize);
  const minQueueSize = Number.isInteger(minNum) && minNum >= 1 && minNum <= 10 ? minNum : base.minQueueSize;
  const autoPartition = typeof src.autoPartition === 'boolean' ? src.autoPartition : (base.autoPartition !== false);
  const autoPrune = typeof src.autoPrune === 'boolean' ? src.autoPrune : (base.autoPrune !== false);
  return { query, mode, count, buildGapMinutes, publishIntervalSeconds, minQueueSize, autoPartition, autoPrune };
}

function projectIdOf(relOrId) {
  const raw = String(relOrId || '').trim();
  if (!raw) return '';
  return raw.startsWith('projects/') ? raw.slice('projects/'.length) : raw;
}

export function createAutopilot({
  root,
  readQueue,
  isBusy,
  inspectProject,
  acquireLock,
  startItem,
  resumeItem = null,
  discoverAndQueue,
  getPublishSchedule = async () => null,
  syncPublishSchedule = async () => ({ synced: false }),
  pruneProject = null,
  stopOtherRunners = () => {},
  maxProjectRetries = 2,
  retryDelayMs = 30000,
  maxConsecutiveFailures = resumeItem ? 2 : 1,
  maxDiscoveryFailures = 3,
  discoveryRetryDelayMs = 45000,
  discoveryBusyDelayMs = 15000,
  intervalMs = 5000,
  clock = Date.now,
  onError = () => {},
} = {}) {
  const configFile = root ? path.join(root, 'out', '.autopilot.json') : null;
  let timer = null;
  let ticking = false;
  let discoveryRunId = 0;
  const trackedProjects = new Set();
  const prunedAttempts = new Set();
  const pruningIds = new Set();

  function loadConfig() {
    if (!configFile) return { ...DEFAULT_AUTOPILOT_CONFIG };
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      return normalizeAutopilotConfig(parsed, DEFAULT_AUTOPILOT_CONFIG);
    } catch {
      return { ...DEFAULT_AUTOPILOT_CONFIG };
    }
  }

  function persistConfig(next) {
    if (!configFile) return;
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const tmp = configFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, configFile);
  }

  let config = loadConfig();
  const state = {
    active: false,
    phase: 'idle', // idle | discovering | building | retrying | cooldown | paused
    discovering: false,
    currentProject: null,
    currentTopic: null,
    lastFinishedProject: null,
    lastFinishedAt: 0,
    nextBuildAt: 0,
    nextRetryAt: 0,
    nextDiscoveryRetryAt: 0,
    retryCount: 0,
    discoveryFailures: 0,
    consecutiveFailures: 0,
    completed: 0,
    discovered: 0,
    skipped: 0,
    prunedCount: 0,
    prunedBytes: 0,
    lastPruned: null,
    lastWarning: null,
    pausedReason: null,
    publishNotice: null,
    publishNoticeKind: null,
    publishState: null,
    startedAt: null,
    updatedAt: null,
  };

  function clearTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function unstartedItems(queue) {
    const items = Array.isArray(queue?.items) ? queue.items : [];
    return items.filter(item => !item.project);
  }

  async function findRunningItem(queue) {
    const items = Array.isArray(queue?.items) ? queue.items : [];
    for (const item of items) {
      if (!item.project) continue;
      const view = await inspectProject(item.project);
      if (view && RUNNING_STATES.has(view.status)) return item;
    }
    return null;
  }

  function summarizePublish(pub) {
    if (!pub) return null;
    return {
      revision: Number.isInteger(pub.revision) ? pub.revision : null,
      enabled: Boolean(pub.enabled),
      attemptActive: Boolean(pub.attemptActive),
      intervalSeconds: pub.trigger?.kind === 'ready' ? (pub.trigger.intervalSeconds || 180) : null,
      triggerKind: pub.trigger?.kind || null,
      scopeKind: pub.scope?.kind || null,
      partitionLabel: pub.partition?.label || null,
      autoPartition: pub.autoPartition !== false,
      pauseReason: pub.pauseReason || '',
      accountMatches: pub.accountMatches !== false,
      lastAttempt: pub.lastAttempt ? {
        state: pub.lastAttempt.state,
        outcome: pub.lastAttempt.outcome || null,
        id: pub.lastAttempt.id,
        bvid: pub.lastAttempt.bvid || null,
        message: pub.lastAttempt.message || '',
        at: pub.lastAttempt.at || 0,
        finishedAt: pub.lastAttempt.finishedAt || pub.lastAttempt.at || 0,
      } : null,
    };
  }

  function snapshot(queue = null) {
    const q = queue || (readQueue ? readQueue(root) : null);
    const pendingCount = q ? unstartedItems(q).length : null;
    return {
      active: state.active,
      phase: state.phase,
      discovering: state.discovering,
      config: { ...config },
      currentProject: state.currentProject,
      currentTopic: state.currentTopic,
      lastFinishedProject: state.lastFinishedProject,
      lastFinishedAt: state.lastFinishedAt,
      nextBuildAt: state.nextBuildAt,
      nextRetryAt: state.nextRetryAt,
      nextDiscoveryRetryAt: state.nextDiscoveryRetryAt,
      retryCount: state.retryCount,
      discoveryFailures: state.discoveryFailures,
      completed: state.completed,
      discovered: state.discovered,
      skipped: state.skipped,
      prunedCount: state.prunedCount,
      prunedBytes: state.prunedBytes,
      lastPruned: state.lastPruned,
      lastWarning: state.lastWarning,
      pendingCount,
      pausedReason: state.pausedReason,
      publishNotice: state.publishNotice,
      publish: state.publishState,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
    };
  }

  function stop({ reason = null } = {}) {
    clearTimer();
    discoveryRunId += 1;
    state.active = false;
    state.discovering = false;
    state.phase = reason ? 'paused' : 'idle';
    state.currentProject = null;
    state.currentTopic = null;
    state.nextBuildAt = 0;
    state.nextRetryAt = 0;
    state.nextDiscoveryRetryAt = 0;
    state.retryCount = 0;
    state.discoveryFailures = 0;
    state.pausedReason = reason;
    if (!reason) { state.publishNotice = null; state.publishNoticeKind = null; state.lastWarning = null; }
    state.updatedAt = clock();
    return snapshot();
  }

  function isHardDiscoveryFailure(res) {
    if (res?.hardSearchFailure === true) return true;
    if (Array.isArray(res?.searchFailures) && res.searchFailures.some(f => f?.tool === 'websearch' && ['401', '402', '403'].includes(String(f.status)))) {
      return true;
    }
    const text = [res?.reason, ...(Array.isArray(res?.researchFailures) ? res.researchFailures.map(f => f?.reason) : [])]
      .filter(Boolean).join(' ');
    return /HTTP\s*(?:401|402)|没有额度|未授权|凭证|providers\.json|配置无效|配置损坏/i.test(text);
  }

  function handleDiscoveryFailure(message, { hard = false } = {}) {
    const limit = Math.max(1, Number(maxDiscoveryFailures) || 1);
    state.discoveryFailures += 1;
    if (hard || state.discoveryFailures >= limit) {
      const suffix = limit > 1 && !hard ? `（连续 ${state.discoveryFailures} 轮未入队）` : '';
      stop({ reason: `${message}${suffix}；已暂停巡航` });
      return;
    }
    const delay = Math.max(0, Number(discoveryRetryDelayMs) || 0);
    const now = clock();
    state.nextDiscoveryRetryAt = now + delay;
    if (!state.currentProject) state.phase = 'retrying';
    state.lastWarning = `${message}；将在 ${Math.max(1, Math.round(delay / 1000))} 秒后自动换一批重找（第 ${state.discoveryFailures}/${limit} 次）`;
    state.updatedAt = now;
  }

  function triggerDiscovery() {
    if (state.discovering || !state.active) return;
    const runId = ++discoveryRunId;
    state.discovering = true;
    state.nextDiscoveryRetryAt = 0;
    state.phase = 'discovering';
    state.updatedAt = clock();

    void Promise.resolve(discoverAndQueue({ ...config }))
      .then(res => {
        if (runId !== discoveryRunId || !state.active) return;
        state.discovering = false;
        state.updatedAt = clock();
        if (!res || res.ok !== true) {
          const isBusyLock = res?.busy === true || /已有选题检索在运行|已有选题检索正在启动/.test(String(res?.reason || ''));
          if (isBusyLock) {
            const delay = Math.max(0, Number(discoveryBusyDelayMs) || 15000);
            const now = clock();
            state.nextDiscoveryRetryAt = now + delay;
            if (!state.currentProject) state.phase = 'retrying';
            state.lastWarning = `已有选题检索正在后台运行，将在 ${Math.max(1, Math.round(delay / 1000))} 秒后自动接续检查（不计入失败）`;
            state.updatedAt = now;
            return;
          }
          handleDiscoveryFailure(`自动选题/调查失败：${res?.reason || '未知错误'}`, { hard: isHardDiscoveryFailure(res) });
          return;
        }
        const addedCount = Array.isArray(res.added) ? res.added.length : 0;
        state.discovered += addedCount;
        const fresh = readQueue(root);
        if (addedCount === 0 && unstartedItems(fresh).length === 0) {
          const failures = Array.isArray(res.researchFailures) ? res.researchFailures : [];
          let message;
          if (failures.length) {
            const first = failures[0];
            const detail = String(first?.reason || '').trim().slice(0, 140);
            const hint = (Array.isArray(res.hints) && res.hints[0]) || (Array.isArray(first?.hints) && first.hints[0]) || '';
            const prefix = res.reusedExisting ? '本轮优先调查已有候选选题，但均未入队' : '本轮自动选题已生成候选，但自动调查未入队';
            message = `${prefix}（${detail || '未通过原文校验'}）${hint ? '；建议：' + hint : ''}`;
          } else {
            message = '本轮自动选题未找到可入队的有效原文线索';
          }
          handleDiscoveryFailure(message, { hard: isHardDiscoveryFailure(res) });
          return;
        }
        if (addedCount > 0) {
          state.discoveryFailures = 0;
          state.nextDiscoveryRetryAt = 0;
          if (state.phase === 'discovering') state.lastWarning = null;
        }
        void tick();
      })
      .catch(error => {
        if (runId !== discoveryRunId || !state.active) return;
        state.discovering = false;
        onError(error);
        handleDiscoveryFailure(`自动选题异常：${error?.message || '未知错误'}`, { hard: false });
      });
  }

  async function applyPublishSync() {
    try {
      const synced = await syncPublishSchedule(config.publishIntervalSeconds, config.autoPartition);
      if (synced?.synced) {
        state.publishNotice = null;
        state.publishNoticeKind = null;
      } else {
        state.publishNotice = synced?.notice || null;
        state.publishNoticeKind = synced?.pendingSync ? 'pending-sync'
          : synced?.interruptedAttempt ? 'interrupted'
          : state.publishNotice ? 'other' : null;
      }
    } catch (error) {
      state.publishNotice = '自动投稿暂未自动启用：' + (error?.message || '请先到发布台确认账号和分区');
      state.publishNoticeKind = 'other';
    }
  }

  async function refreshPublishState() {
    try {
      const pub = await getPublishSchedule();
      state.publishState = summarizePublish(pub);
      if (pub && state.publishNotice) {
        const fullySynced = pub.enabled && pub.lastAttempt?.state !== 'running' && pub.accountMatches !== false
          && pub.trigger?.kind === 'ready' && pub.trigger.intervalSeconds === config.publishIntervalSeconds
          && pub.scope?.kind === 'production-queue'
          && (pub.autoPartition !== false) === config.autoPartition;
        if (fullySynced) {
          state.publishNotice = null;
          state.publishNoticeKind = null;
        } else if (!state.active && state.publishNoticeKind === 'interrupted' && pub.lastAttempt?.state !== 'running') {
          state.publishNotice = null;
          state.publishNoticeKind = null;
        }
      }
      return pub;
    } catch {
      return null;
    }
  }

  function trackProject(relOrId) {
    const id = projectIdOf(relOrId);
    if (id) trackedProjects.add(id);
  }

  async function maybePrunePublished(idOrRel, finishedAt = 0) {
    if (!config.autoPrune || typeof pruneProject !== 'function') return { ok: false, skipped: true };
    const id = projectIdOf(idOrRel);
    if (!id) return { ok: false, skipped: true };
    const key = `${id}@${finishedAt || 0}`;
    if (prunedAttempts.has(key) || pruningIds.has(id)) return { ok: false, skipped: true };
    pruningIds.add(id);
    try {
      const res = await pruneProject(id);
      if (res?.ok) {
        prunedAttempts.add(key);
        trackedProjects.delete(id);
        const freed = Number(res.freed) || 0;
        const removed = Array.isArray(res.removed) ? res.removed : [];
        if (removed.length > 0 || freed > 0) {
          state.prunedCount += 1;
          state.prunedBytes += freed;
          state.lastPruned = { id, freed, removed, at: clock() };
          state.updatedAt = clock();
        }
        return res;
      }
      if (!res?.skipped && res?.error) {
        onError(new Error(`发布后自动清理缓存失败（${id}）：${res.error}`));
      }
      return res || { ok: false, skipped: true };
    } catch (error) {
      onError(error);
      return { ok: false, error: error?.message || '清理缓存失败' };
    } finally {
      pruningIds.delete(id);
    }
  }

  async function onProjectPublished({ id, finishedAt = 0 } = {}) {
    if (!config.autoPrune) return { ok: false, skipped: true };
    const pid = projectIdOf(id);
    if (!pid) return { ok: false, skipped: true };
    if (!state.active && !trackedProjects.has(pid)) return { ok: false, skipped: true };
    return maybePrunePublished(pid, finishedAt);
  }

  async function tick() {
    if (!state.active || ticking) return snapshot();
    ticking = true;
    try {
      let pub = await refreshPublishState();
      if (config.autoPrune && pub?.lastAttempt?.state === 'submitted' && pub.lastAttempt.outcome === 'submitted' && pub.lastAttempt.id) {
        const doneAt = pub.lastAttempt.finishedAt || pub.lastAttempt.at || 0;
        if (doneAt >= (state.startedAt || 0) || trackedProjects.has(projectIdOf(pub.lastAttempt.id))) {
          await maybePrunePublished(pub.lastAttempt.id, doneAt);
        }
      }
      if (pub && (state.publishNoticeKind === 'pending-sync' || state.publishNoticeKind === 'interrupted') && pub.lastAttempt?.state !== 'running') {
        await applyPublishSync();
        pub = await refreshPublishState();
      }
      if (pub && pub.enabled === false) {
        const failedAfterStart = pub.lastAttempt?.state === 'failed'
          && pub.lastAttempt?.outcome !== 'interrupted'
          && (pub.lastAttempt.finishedAt || pub.lastAttempt.at || 0) >= (state.startedAt || 0);
        if (pub.pauseReason || failedAfterStart) {
          const why = pub.pauseReason || pub.lastAttempt?.message || '自动投稿触发限流或提交失败';
          return stop({ reason: `自动投稿已熔断暂停（${why}），全自动巡航已同步停止，请先到发布台核对后再重启` });
        }
      }

      const queue = readQueue(root);

      /* 1. 监控当前正在制作的项目 */
      if (state.currentProject) {
        const view = await inspectProject(state.currentProject);
        if (view && RUNNING_STATES.has(view.status)) {
          state.phase = 'building';
          state.nextRetryAt = 0;
          state.updatedAt = clock();
          return snapshot(queue);
        }
        const delivered = Boolean(view && view.status === 'completed' && view.delivered === true);
        if (!delivered) {
          const label = state.currentTopic ? `「${state.currentTopic}」` : state.currentProject;
          const why = FAILURE_LABELS[view?.status] || '未正常完成';
          const rawDetail = String(view?.errorMessage || '').trim().slice(0, 140);
          const detailText = rawDetail ? `（${rawDetail}）` : '';
          const nonRetryable = view?.status === 'cancelled' || (view?.errorKind && NON_RETRYABLE_KINDS.has(view.errorKind));

          /* 偶发上游网关/网络异常：自动等待短暂冷却后从断点续跑，避免无人值守频繁中断 */
          if (!nonRetryable && typeof resumeItem === 'function' && view?.canResume === true && state.retryCount < maxProjectRetries) {
            const now = clock();
            if (!state.nextRetryAt) {
              state.nextRetryAt = now + Math.max(0, retryDelayMs);
              state.phase = 'retrying';
              state.lastWarning = `${label}${why}${detailText}，将在 ${Math.max(1, Math.round(retryDelayMs / 1000))} 秒后自动续跑（第 ${state.retryCount + 1}/${maxProjectRetries} 次）`;
              state.updatedAt = now;
              if (now < state.nextRetryAt) return snapshot(queue);
            }
            if (now < state.nextRetryAt) {
              state.phase = 'retrying';
              state.updatedAt = now;
              return snapshot(queue);
            }
            let lock;
            try { lock = acquireLock(root); }
            catch (error) {
              if (error.code === 'PRODUCTION_LOCK_BUSY') return snapshot(queue);
              throw error;
            }
            try {
              if (!state.active) return snapshot(readQueue(root));
              const fresh = readQueue(root);
              if (isBusy(fresh)) return snapshot(fresh);
              state.retryCount += 1;
              state.nextRetryAt = 0;
              const resumed = await resumeItem(state.currentProject);
              if (resumed && !(resumed.status && resumed.status >= 400) && resumed.body?.ok && resumed.body?.started) {
                state.phase = 'building';
                state.lastWarning = `${label}已自动续跑（第 ${state.retryCount}/${maxProjectRetries} 次）`;
                state.updatedAt = clock();
                return snapshot(readQueue(root));
              }
            } finally {
              lock?.release?.();
            }
          }

          state.consecutiveFailures += 1;
          const limit = Math.max(1, Number(maxConsecutiveFailures) || 1);
          if (!nonRetryable && state.consecutiveFailures < limit) {
            state.skipped += 1;
            state.lastWarning = `${label}自动续跑后仍${why}${detailText}，已跳过并继续下一支（原项目与日志已保留）`;
            state.currentProject = null;
            state.currentTopic = null;
            state.retryCount = 0;
            state.nextRetryAt = 0;
            state.updatedAt = clock();
          } else {
            return stop({ reason: `已熔断暂停：${label}${why}${detailText}，请查看原因后再决定是否重启巡航` });
          }
        } else {
          trackProject(state.currentProject);
          state.completed += 1;
          state.consecutiveFailures = 0;
          state.retryCount = 0;
          state.nextRetryAt = 0;
          state.lastWarning = null;
          state.lastFinishedProject = state.currentProject;
          state.lastFinishedAt = clock();
          state.currentProject = null;
          state.currentTopic = null;
          state.updatedAt = clock();
        }
      }

      if (!state.active) return snapshot(queue);

      /* 2. 检查是否有外部启动的制作任务正在占用队列 */
      if (isBusy(queue)) {
        const running = await findRunningItem(queue);
        if (running) {
          state.currentProject = running.project;
          state.currentTopic = running.topic;
          trackProject(running.project);
        }
        state.phase = 'building';
        state.updatedAt = clock();
        return snapshot(queue);
      }

      /* 3. 待做队列水位不足时，后台自动补题；只要队列里已有 ≥1 支待做选题，就不阻塞开工，边做边补货 */
      const pending = unstartedItems(queue);
      if (pending.length < config.minQueueSize && !state.discovering) {
        const nowForDiscovery = clock();
        if (!state.nextDiscoveryRetryAt || nowForDiscovery >= state.nextDiscoveryRetryAt) {
          triggerDiscovery();
        } else if (pending.length === 0) {
          state.phase = 'retrying';
          state.updatedAt = nowForDiscovery;
          return snapshot(queue);
        }
      }
      if (pending.length === 0) return snapshot(queue);

      /* 4. 检查生成冷却间隔（默认 5 分钟） */
      const gapMs = Math.max(0, config.buildGapMinutes) * 60000;
      const now = clock();
      if (gapMs > 0 && state.lastFinishedAt && now - state.lastFinishedAt < gapMs) {
        state.phase = 'cooldown';
        state.nextBuildAt = state.lastFinishedAt + gapMs;
        state.updatedAt = now;
        return snapshot(queue);
      }
      state.nextBuildAt = 0;

      /* 5. 持锁启动下一支待做选题 */
      let lock;
      try { lock = acquireLock(root); }
      catch (error) {
        if (error.code === 'PRODUCTION_LOCK_BUSY') return snapshot(queue);
        throw error;
      }
      try {
        if (!state.active) return snapshot(readQueue(root));
        const fresh = readQueue(root);
        if (isBusy(fresh)) return snapshot(fresh);
        const candidate = unstartedItems(fresh)[0];
        if (!candidate) return snapshot(fresh);

        const result = await startItem(candidate);
        if (!result || (result.status && result.status >= 400) || !result.body?.ok || !result.body?.started) {
          const errMsg = result?.body?.error || result?.body?.task?.error?.message || '未能启动制作';
          return stop({ reason: `已熔断暂停：「${candidate.topic}」${errMsg}` });
        }
        state.currentProject = result.body.rel || null;
        state.currentTopic = candidate.topic;
        trackProject(state.currentProject);
        state.retryCount = 0;
        state.nextRetryAt = 0;
        state.phase = 'building';
        state.updatedAt = clock();
        return snapshot(readQueue(root));
      } finally {
        lock?.release?.();
      }
    } catch (error) {
      onError(error);
      return stop({ reason: `全自动巡航检查出错（${error?.message || '未知错误'}），已暂停` });
    } finally {
      ticking = false;
    }
  }

  function saveConfig(patch = {}) {
    config = normalizeAutopilotConfig(patch, config);
    persistConfig(config);
    state.updatedAt = clock();
    return snapshot();
  }

  async function syncPublish() {
    await applyPublishSync();
    await refreshPublishState();
    state.updatedAt = clock();
    return snapshot();
  }

  async function updateConfig(patch = {}) {
    saveConfig(patch);
    if (state.active) {
      await applyPublishSync();
      await refreshPublishState();
    } else {
      await refreshPublishState();
    }
    return snapshot();
  }

  async function start(patch = null) {
    if (patch && typeof patch === 'object') {
      config = normalizeAutopilotConfig(patch, config);
      persistConfig(config);
    }
    stopOtherRunners();

    state.publishNotice = null;
    state.publishNoticeKind = null;
    await applyPublishSync();
    await refreshPublishState();

    const queue = readQueue(root);
    const existing = await findRunningItem(queue);

    state.active = true;
    state.discovering = false;
    state.pausedReason = null;
    state.completed = 0;
    state.discovered = 0;
    state.skipped = 0;
    state.prunedCount = 0;
    state.prunedBytes = 0;
    state.lastPruned = null;
    trackedProjects.clear();
    state.consecutiveFailures = 0;
    state.retryCount = 0;
    state.nextRetryAt = 0;
    state.discoveryFailures = 0;
    state.nextDiscoveryRetryAt = 0;
    state.lastWarning = null;
    state.lastFinishedAt = 0;
    state.nextBuildAt = 0;
    state.startedAt = clock();
    state.updatedAt = state.startedAt;
    if (existing) {
      state.currentProject = existing.project;
      state.currentTopic = existing.topic;
      trackProject(existing.project);
      state.phase = 'building';
    } else {
      state.currentProject = null;
      state.currentTopic = null;
      state.phase = 'idle';
    }

    clearTimer();
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();

    return tick();
  }

  async function status() {
    await refreshPublishState();
    return snapshot();
  }

  function close() {
    clearTimer();
    discoveryRunId += 1;
    state.active = false;
    state.discovering = false;
    state.phase = 'idle';
    state.currentProject = null;
    state.currentTopic = null;
  }

  return { start, stop, tick, status, saveConfig, updateConfig, syncPublish, onProjectPublished, snapshot, close };
}
