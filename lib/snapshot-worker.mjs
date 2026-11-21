/* The full snapshot performs synchronous hashing/probing and may load the
 * project's timing validator. Keep it off the HTTP event loop. One request at
 * a time per worker preserves the existing snapshot implementation. Workers
 * that import project code are retired before the next observation. */
import { parentPort } from 'node:worker_threads';
import { snapshot } from './state.mjs';
import { deliverableState, projectDeliveryState, taskDeliveryState } from './deliverable.mjs';
import { observeTaskCompletion } from './task-completion.mjs';
import { readTask, taskStatus } from './task-status.mjs';
import { readPublicationDraft } from './project-state.mjs';

parentPort.on('message', async ({ id, project, kind, mode }) => {
  try {
    let value = kind === 'snapshot' ? await snapshot(project)
      : kind === 'publication' ? await readPublicationDraft(project)
      : kind === 'delivery' ? mode === 'task' ? observeTaskCompletion(project, readTask(project))
        : ['edit-copy', 'edit-script', 'edit-visual'].includes(mode) ? taskDeliveryState(project, mode)
        : mode === 'project' ? projectDeliveryState(project) : deliverableState(project)
        : null;
    if (!value) throw new Error('unknown observation');
    if (kind === 'delivery' && readTask(project)?.status === 'paused') {
      // 暂停原因是否已失效也可能核验整片，只能在 worker 做，不放回轻量轮询线程。
      const task = taskStatus(project, { includeDeliverable: false, includeArtifactChecks: true, reconcile: false });
      if (task.staleStopNotice) value = { ...value, taskObservation: { taskId: task.taskId, attemptId: task.attemptId, status: task.status, staleStopNotice: task.staleStopNotice } };
    }
    parentPort.postMessage({ id, ok: true, value });
  }
  catch { parentPort.postMessage({ id, ok: false }); }
});
