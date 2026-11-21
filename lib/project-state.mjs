/* 项目事实的共同读取边界。制作进程/锁只在 taskStatus 中判断；页面不保存状态副本。
 * 便宜的进程观察留在服务线程，成片/文案快照交给现有的有界只读 worker。 */
import path from 'node:path';
import { taskStatus } from './task-status.mjs';

export const observeProjectTask = (project, { productionLease } = {}) => taskStatus(project, { includeDeliverable: false, reconcile: false, productionLease });
export const reconcileProjectTask = (project, { productionLease } = {}) => taskStatus(project, { includeDeliverable: false, productionLease });
export const projectBusy = task => Boolean(task?.running || task?.taskRunning || task?.productionBusy || task?.orphanRunning || task?.cancelling);
export const sameProjectAttempt = (a, b) => a?.taskId === b?.taskId && a?.attemptId === b?.attemptId && a?.status === b?.status && a?.mode === b?.mode;

export async function readProjectTask(project, { snapshots }) {
  const terminal = status => ['completed', 'failed', 'paused', 'cancelled', 'interrupted', 'incomplete'].includes(status);
  // 取消协调只在服务线程进行；worker 与素材读取只作无副作用观察。
  const initial = reconcileProjectTask(project);
  if (!terminal(initial.status)) return initial;
  const result = await snapshots.readDelivery(project, initial.execution?.runner === 'opencode' ? 'task'
    : ['edit-copy', 'edit-script', 'edit-visual'].includes(initial.mode) ? initial.mode : ['article', 'topic'].includes(initial.mode) ? 'project' : 'video');
  const current = observeProjectTask(project);
  if (sameProjectAttempt(initial, current) && !projectBusy(current)) {
    current.deliverableStale = result.stale ? result.reason : null;
    current.completionKind = result.kind || null;
    const observed = result.taskObservation;
    if (observed?.taskId === current.taskId && observed?.attemptId === current.attemptId && observed?.status === current.status && observed.staleStopNotice) {
      current.staleStopNotice = observed.staleStopNotice; current.pausedReason = observed.staleStopNotice;
    }
    if (!result.stale && result.kind !== 'response' && ['cancelled', 'interrupted', 'incomplete', 'failed'].includes(current.status)) {
      current.delivered = true; current.canResume = false; current.canRetry = false;
    }
  } else if (terminal(current.status)) current.deliverableStale = '任务状态刚发生变化，产物状态待重新核验';
  return current;
}

export async function readPublicationDraft(project) {
  const [{ projectDraft }, { prepareCoverIssues }] = await Promise.all([import('../desk/projects.mjs'), import('../desk/cover-prep.mjs')]);
  return projectDraft(path.dirname(path.dirname(project)), path.basename(project), undefined, { coverIssues: prepareCoverIssues });
}

export function createProjectStateService({ snapshots }) {
  return {
    observe: observeProjectTask,
    readTask: project => readProjectTask(project, { snapshots }),
    readDraft: project => snapshots.readPublication(project),
  };
}
