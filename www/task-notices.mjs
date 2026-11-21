/* 任务原因、产物状态与运行警告分开展示；重新执行后不沿用上一轮的提示。 */
export function taskNotices(task = {}) {
  const active = task.running || task.cancelling || task.orphanRunning ||
    ['starting', 'running', 'cancelling'].includes(task.status);
  const currentBlocker = ['cancelling', 'orphan', 'production'].includes(task.error?.kind);
  let error = !active || currentBlocker ? task.error?.message || '' : '';
  /* 产物已核验齐全、只是执行器收尾异常时，不要用"任务未完成"吓人：
   * 真正的事实是"成片在，收尾没走干净"，把判断权交回给人。 */
  if (!active && task.delivered && task.status === 'failed' && task.error?.kind === 'execution') {
    error = '制作结果已交付；执行器收尾异常退出，详见日志。';
  }
  return {
    reason: error || (!active && task.status === 'paused'
      ? task.pausedReason || task.resumeNotice || '任务已暂停，进度已保留，可继续原任务。' : ''),
    deliverable: !active && task.deliverableStale ? '产物状态：' + task.deliverableStale : '',
    /* 运行期间的警告（例如中途断线后恢复、收尾非零但交付完整）：
     * 只在结束后展示，不覆盖失败原因。 */
    warnings: !active && Array.isArray(task.warnings) ? task.warnings.filter(item => typeof item === 'string' && item.trim()) : [],
  };
}
