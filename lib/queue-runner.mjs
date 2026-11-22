/* 待做队列的串行续跑控制器（内存态，不写第二份执行状态副本）。
 *
 * 设计边界：
 * - 不直接依赖 HTTP、DOM 或具体制作引擎，全部通过依赖注入传入。
 * - 与「定时生成」共用 acquireQueueDispatch 锁和 queueProductionBusy 检查，避免并发撞车。
 * - 同一时间只跑 1 支；前一支确认 completed 且成片交付后才拉起下一支。
 * - 遇失败/中断/暂停立刻停止续跑并记录原因，绝不自动重试或盲目继续烧下一支额度。
 * - 服务重启自动复位为关闭，避免意外静默开跑。
 */

const RUNNING_STATES = new Set(['starting', 'running', 'cancelling']);
const FAILURE_LABELS = {
  failed: '制作失败',
  paused: '已暂停（可进入项目继续）',
  cancelled: '已停止',
  interrupted: '制作中断',
  incomplete: '尚未完成',
};

export function createQueueRunner({
  root,
  readQueue,
  isBusy,
  inspectProject,
  acquireLock,
  startItem,
  intervalMs = 5000,
  clock = Date.now,
  onError = () => {},
} = {}) {
  let timer = null;
  let ticking = false;
  const state = {
    active: false,
    scopeIds: null,
    currentProject: null,
    currentTopic: null,
    completed: 0,
    pausedReason: null,
    lastFinishedProject: null,
    startedAt: null,
    updatedAt: null,
  };

  function clearTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function unstartedMatches(queue, scopeIds = state.scopeIds) {
    const items = Array.isArray(queue?.items) ? queue.items : [];
    const allowed = Array.isArray(scopeIds) ? new Set(scopeIds) : null;
    return items.filter(item => !item.project && (!allowed || allowed.has(item.id)));
  }

  function findNext(queue, scopeIds = state.scopeIds) {
    return unstartedMatches(queue, scopeIds)[0] || null;
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

  function snapshot(queue = null) {
    const remaining = queue ? unstartedMatches(queue).length : null;
    return {
      active: state.active,
      scopeIds: state.scopeIds ? [...state.scopeIds] : null,
      currentProject: state.currentProject,
      currentTopic: state.currentTopic,
      completed: state.completed,
      pausedReason: state.pausedReason,
      lastFinishedProject: state.lastFinishedProject,
      remaining,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
    };
  }

  function stop({ reason = null } = {}) {
    clearTimer();
    state.active = false;
    state.scopeIds = null;
    state.currentProject = null;
    state.currentTopic = null;
    state.pausedReason = reason;
    state.updatedAt = clock();
    return snapshot(readQueue(root));
  }

  async function tick() {
    if (!state.active || ticking) return snapshot(readQueue(root));
    ticking = true;
    try {
      const queue = readQueue(root);
      if (state.currentProject) {
        const view = await inspectProject(state.currentProject);
        if (view && RUNNING_STATES.has(view.status)) return snapshot(queue);
        const delivered = Boolean(view && view.status === 'completed' && view.delivered === true);
        if (!delivered) {
          const label = state.currentTopic ? `「${state.currentTopic}」` : state.currentProject;
          const why = FAILURE_LABELS[view?.status] || '未正常完成';
          return stop({ reason: `已暂停续跑：${label}${why}，请查看原因后再决定是否继续` });
        }
        state.completed += 1;
        state.lastFinishedProject = state.currentProject;
        state.currentProject = null;
        state.currentTopic = null;
        state.updatedAt = clock();
      }

      if (!state.active) return snapshot(queue);

      if (isBusy(queue)) {
        const running = await findRunningItem(queue);
        if (running) {
          state.currentProject = running.project;
          state.currentTopic = running.topic;
          state.updatedAt = clock();
        }
        return snapshot(queue);
      }

      const next = findNext(queue);
      if (!next) return stop({ reason: null });

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
        const candidate = findNext(fresh);
        if (!candidate) return stop({ reason: null });

        const result = await startItem(candidate);
        if (!result || (result.status && result.status >= 400) || !result.body?.ok || !result.body?.started) {
          const errMsg = result?.body?.error || result?.body?.task?.error?.message || '未能启动制作';
          return stop({ reason: `已暂停续跑：「${candidate.topic}」${errMsg}` });
        }
        state.currentProject = result.body.rel || null;
        state.currentTopic = candidate.topic;
        state.updatedAt = clock();
        return snapshot(readQueue(root));
      } finally {
        lock?.release?.();
      }
    } catch (error) {
      onError(error);
      return stop({ reason: `已暂停续跑：调度检查出错（${error.message || '未知错误'}）` });
    } finally {
      ticking = false;
    }
  }

  async function start({ ids = null } = {}) {
    let normalizedIds = null;
    if (ids != null) {
      if (!Array.isArray(ids)) throw Object.assign(new Error('ids 必须是数组'), { statusCode: 400 });
      normalizedIds = [...new Set(ids.filter(id => typeof id === 'string' && id.trim()))];
      if (!normalizedIds.length) throw Object.assign(new Error('请先勾选至少一个待做选题'), { statusCode: 400 });
    }
    const queue = readQueue(root);
    const pending = unstartedMatches(queue, normalizedIds);
    const existing = await findRunningItem(queue);
    if (!pending.length) {
      throw Object.assign(new Error(normalizedIds ? '所选项目中没有尚未开工的选题' : '待做队列里没有尚未开工的选题'), { statusCode: 400 });
    }

    state.active = true;
    state.scopeIds = normalizedIds;
    state.pausedReason = null;
    state.completed = 0;
    state.startedAt = clock();
    state.updatedAt = state.startedAt;
    if (existing) {
      state.currentProject = existing.project;
      state.currentTopic = existing.topic;
    } else {
      state.currentProject = null;
      state.currentTopic = null;
    }

    clearTimer();
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();

    return tick();
  }

  function close() {
    clearTimer();
    state.active = false;
    state.scopeIds = null;
    state.currentProject = null;
    state.currentTopic = null;
  }

  return { start, stop, tick, snapshot, close };
}
