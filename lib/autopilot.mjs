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
  return { query, mode, count, buildGapMinutes, publishIntervalSeconds, minQueueSize };
}

export function createAutopilot({
  root,
  readQueue,
  isBusy,
  inspectProject,
  acquireLock,
  startItem,
  discoverAndQueue,
  getPublishSchedule = async () => null,
  syncPublishSchedule = async () => ({ synced: false }),
  stopOtherRunners = () => {},
  intervalMs = 5000,
  clock = Date.now,
  onError = () => {},
} = {}) {
  const configFile = root ? path.join(root, 'out', '.autopilot.json') : null;
  let timer = null;
  let ticking = false;
  let discoveryRunId = 0;

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
    phase: 'idle', // idle | discovering | building | cooldown | paused
    discovering: false,
    currentProject: null,
    currentTopic: null,
    lastFinishedProject: null,
    lastFinishedAt: 0,
    nextBuildAt: 0,
    completed: 0,
    discovered: 0,
    pausedReason: null,
    publishNotice: null,
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
      enabled: Boolean(pub.enabled),
      intervalSeconds: pub.trigger?.kind === 'ready' ? (pub.trigger.intervalSeconds || 180) : null,
      triggerKind: pub.trigger?.kind || null,
      scopeKind: pub.scope?.kind || null,
      partitionLabel: pub.partition?.label || null,
      pauseReason: pub.pauseReason || '',
      accountMatches: pub.accountMatches !== false,
      lastAttempt: pub.lastAttempt ? {
        state: pub.lastAttempt.state,
        id: pub.lastAttempt.id,
        bvid: pub.lastAttempt.bvid || null,
        message: pub.lastAttempt.message || '',
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
      completed: state.completed,
      discovered: state.discovered,
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
    state.pausedReason = reason;
    state.updatedAt = clock();
    return snapshot();
  }

  function triggerDiscovery() {
    if (state.discovering || !state.active) return;
    const runId = ++discoveryRunId;
    state.discovering = true;
    state.phase = 'discovering';
    state.updatedAt = clock();

    void Promise.resolve(discoverAndQueue({ ...config }))
      .then(res => {
        if (runId !== discoveryRunId || !state.active) return;
        state.discovering = false;
        state.updatedAt = clock();
        if (!res || res.ok !== true) {
          stop({ reason: `自动选题/调查失败：${res?.reason || '未知错误'}，已暂停巡航` });
          return;
        }
        const addedCount = Array.isArray(res.added) ? res.added.length : 0;
        state.discovered += addedCount;
        const fresh = readQueue(root);
        if (addedCount === 0 && unstartedItems(fresh).length === 0) {
          stop({ reason: '本轮自动选题未找到可入队的有效原文线索，已暂停巡航；可调整探索方向后重试' });
          return;
        }
        void tick();
      })
      .catch(error => {
        if (runId !== discoveryRunId || !state.active) return;
        state.discovering = false;
        onError(error);
        stop({ reason: `自动选题异常：${error?.message || '未知错误'}，已暂停巡航` });
      });
  }

  async function refreshPublishState() {
    try {
      const pub = await getPublishSchedule();
      state.publishState = summarizePublish(pub);
      return pub;
    } catch {
      return null;
    }
  }

  async function tick() {
    if (!state.active || ticking) return snapshot();
    ticking = true;
    try {
      const pub = await refreshPublishState();
      if (pub && pub.enabled === false) {
        const failedAfterStart = pub.lastAttempt?.state === 'failed'
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
          state.updatedAt = clock();
          return snapshot(queue);
        }
        const delivered = Boolean(view && view.status === 'completed' && view.delivered === true);
        if (!delivered) {
          const label = state.currentTopic ? `「${state.currentTopic}」` : state.currentProject;
          const why = FAILURE_LABELS[view?.status] || '未正常完成';
          return stop({ reason: `已熔断暂停：${label}${why}，请查看原因后再决定是否重启巡航` });
        }
        state.completed += 1;
        state.lastFinishedProject = state.currentProject;
        state.lastFinishedAt = clock();
        state.currentProject = null;
        state.currentTopic = null;
        state.updatedAt = clock();
      }

      if (!state.active) return snapshot(queue);

      /* 2. 检查是否有外部启动的制作任务正在占用队列 */
      if (isBusy(queue)) {
        const running = await findRunningItem(queue);
        if (running) {
          state.currentProject = running.project;
          state.currentTopic = running.topic;
        }
        state.phase = 'building';
        state.updatedAt = clock();
        return snapshot(queue);
      }

      /* 3. 待做队列水位不足时，自动选题 + 联网调查入队（冷却期也可提前补题） */
      const pending = unstartedItems(queue);
      if (pending.length < config.minQueueSize) {
        if (!state.discovering) triggerDiscovery();
        return snapshot(queue);
      }

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

  async function start(patch = null) {
    if (patch && typeof patch === 'object') {
      config = normalizeAutopilotConfig(patch, config);
      persistConfig(config);
    }
    stopOtherRunners();

    state.publishNotice = null;
    try {
      const synced = await syncPublishSchedule(config.publishIntervalSeconds);
      if (synced?.notice) state.publishNotice = synced.notice;
    } catch (error) {
      state.publishNotice = '自动投稿暂未自动启用：' + (error?.message || '请先到发布台确认账号和分区');
    }
    await refreshPublishState();

    const queue = readQueue(root);
    const existing = await findRunningItem(queue);

    state.active = true;
    state.discovering = false;
    state.pausedReason = null;
    state.completed = 0;
    state.discovered = 0;
    state.lastFinishedAt = 0;
    state.nextBuildAt = 0;
    state.startedAt = clock();
    state.updatedAt = state.startedAt;
    if (existing) {
      state.currentProject = existing.project;
      state.currentTopic = existing.topic;
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

  return { start, stop, tick, status, saveConfig, snapshot, close };
}
