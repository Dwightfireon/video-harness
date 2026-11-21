/* 制作定点，不依赖发布服务。父进程只看时钟和队列，子进程持锁执行旧制作入口。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireProductionLock } from './production-lock.mjs';
import { readSchedule, firstUnstarted } from './schedule.mjs';
import { dailyBuildSlot } from './timing-plan.mjs';
import { observeProjectTask, projectBusy } from './project-state.mjs';

const stateDir = root => path.join(root, 'out', '.daily-build');
export function acquireQueueDispatch(root) {
  const dir = stateDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return acquireProductionLock(dir, { command: 'queue-build', env: {} });
}

export function queueProductionBusy(root, queue) {
  return queue.items.some(item => {
    if (!item.project || path.dirname(item.project) !== 'projects') return false;
    const task = observeProjectTask(path.join(root, item.project));
    return projectBusy(task) && task.productionLock?.owner?.command !== 'publish-upload';
  });
}
function lastDailyBuildSlot(root) {
  try {
    const slot = fs.readFileSync(path.join(stateDir(root), 'slot'), 'utf8').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot)) throw new Error('定点制作记录损坏，请先人工核对');
    return slot;
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export function dailyBuildCandidate(root, now) {
  const queue = readSchedule(root), slot = dailyBuildSlot(queue.build, now);
  if (!slot || slot <= lastDailyBuildSlot(root)) return null;
  const item = firstUnstarted(queue);
  return item ? { slot, item, queue } : null;
}

export function dispatchDailyBuild(root, { dispatch, isBusy = () => false, clock = Date.now, dryRun = false }) {
  const candidate = dailyBuildCandidate(root, clock());
  if (!candidate) return { reason: 'not-due' };
  if (dryRun) return { reason: 'dry-run', item: candidate.item };
  const dir = stateDir(root);
  let lock;
  try { lock = acquireQueueDispatch(root); }
  catch (error) { if (error.code === 'PRODUCTION_LOCK_BUSY') return { reason: 'busy' }; throw error; }
  try {
    const current = dailyBuildCandidate(root, clock());
    if (current?.slot !== candidate.slot || current.item.id !== candidate.item.id) return { reason: 'changed' };
    if (isBusy(current.queue)) return { reason: 'busy' };
    const temp = path.join(dir, `${randomUUID()}.tmp`);
    try {
      // 开始之前认领；中断后不盲目重建同一支。真正的制作状态仍由项目管理。
      fs.writeFileSync(temp, current.slot + '\n', { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temp, path.join(dir, 'slot'));
    } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return { reason: 'dispatched', item: current.item, result: dispatch(current.item) };
  } finally { lock.release(); }
}

export function startDailyBuildTicker(root, { launch, clock = Date.now, intervalMs = 5000, onError = () => {} }) {
  let active = false, checkedMinute;
  function tick() {
    const now = clock(), minute = Math.floor(now / 60000);
    if (active || minute === checkedMinute) return;
    checkedMinute = minute;
    try {
      if (!dailyBuildCandidate(root, now)) return;
      active = true;
      void Promise.resolve(launch()).catch(onError).finally(() => { active = false; });
    } catch (error) { active = false; onError(error); }
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
