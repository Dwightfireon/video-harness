import { taskDeliveryState } from './deliverable.mjs';
import { taskScopeObservation } from './task-contract.mjs';

export function observeTaskCompletion(project, task) {
  const scope = taskScopeObservation(project, task?.contract);
  if (scope.stale) return { ...scope, kind: 'requirements' };
  if (task?.contract?.readOnly) return { stale: false, reason: null, kind: 'response', changed: scope.changed };
  return { ...taskDeliveryState(project, task?.contract?.mode || task?.mode), changed: scope.changed };
}

export function settleTaskResult(project, task, result) {
  if (!result.ok || result.status !== 'completed') return result;
  const delivery = observeTaskCompletion(project, task);
  if (!String(result.answer || '').trim()) return { ...result, ok: false, status: 'incomplete', executionStatus: 'completed',
    error: '执行器已经退出，但没有留下回答或交付说明', deliverable: { stale: true, reason: '缺少执行结果说明' } };
  return { ...result, executionStatus: 'completed', deliverable: delivery,
    ...(delivery.stale ? { ok: false, status: 'incomplete', error: delivery.reason } : {}) };
}
