/* 所有继续入口共用：追加预算只属于当前任务，必须显式确认并由服务端回证。 */
const integer = value => Number.isInteger(value) && value >= 0;
export const taskIdentity = task => JSON.stringify([task?.taskId ?? task?.id, task?.attemptId]);

export function repairRecovery(task = {}) {
  task ||= {};
  const recovery = task.repairRecovery;
  /* A stale stop record means the actual artifacts have since been produced
   * (e.g. the stage was completed from the CLI). The used rounds are history,
   * not a live budget block: ordinary continue and new instructions must stay
   * available. */
  const staleStop = !!task.staleStopNotice;
  // 旧服务已明确耗尽预算时不能退回一个看似能自动修复的普通继续按钮。
  const summary = task.automationSummary;
  const legacyBlocked = !recovery && !staleStop && summary?.enabled && summary.repairPhase === 'stopped'
    && integer(summary.repairUsed) && integer(summary.repairLimit) && summary.repairUsed >= summary.repairLimit;
  const blocked = !staleStop && (recovery?.blocked === true || !!legacyBlocked);
  const used = recovery?.used ?? summary?.repairUsed;
  const limit = recovery?.limit ?? summary?.repairLimit;
  const additionalRepairs = recovery?.additionalRepairs;
  const targetLimit = recovery?.targetLimit;
  const busy = task.running || task.cancelling || task.orphanRunning || task.productionBusy
    || ['starting', 'running', 'cancelling'].includes(task.status);
  const canExtend = blocked && recovery?.canExtend === true && integer(used) && integer(limit)
    && used === limit && !busy
    && [1, 2].includes(additionalRepairs) && targetLimit === limit + additionalRepairs && targetLimit <= 5
    && !!(task.taskId ?? task.id) && !!task.attemptId;
  const reason = !blocked ? '' : `自动修复预算已耗尽，累计已用 ${used ?? '?'} 轮，当前限额 ${limit ?? '?'} 轮；普通继续不会增加修复预算。`
    + (legacyBlocked ? '当前服务未提供追加授权信息，请重启工作台后刷新。'
      : !canExtend ? limit >= 5 ? '已达总上限 5 轮，请先手动修改输入再核验。' : '当前不可追加，请刷新核对任务身份与恢复信息。' : '');
  return { blocked, canExtend, used, limit, additionalRepairs, targetLimit, reason,
    label: !blocked ? '继续原任务（会调用模型）' : canExtend
      ? `追加${additionalRepairs}轮修复并继续（会调用模型）` : '修复预算不可追加',
    detail: blocked ? '累计已用轮次保留；只调整当前任务，不改变未来任务设置、8分钟时长上限或验收标准。可能产生模型、TTS 和渲染费用。' : '' };
}

export async function resumeWithRecovery({ getTask, request, confirmImpl = globalThis.confirm } = {}) {
  const task = getTask(), recovery = repairRecovery(task);
  const signatureOf = value => JSON.stringify([taskIdentity(value), value?.status, value?.running,
    value?.cancelling, value?.orphanRunning, value?.productionBusy, value?.repairRecovery, value?.automationSummary]);
  const signature = signatureOf(task);
  let options = { method: 'POST' };
  if (recovery.blocked) {
    if (!recovery.canExtend) throw new Error(recovery.reason);
    if (typeof confirmImpl !== 'function') throw new Error('无法显示费用确认；未追加预算，也未继续任务。');
    const confirmed = await confirmImpl(`${recovery.label}？\n累计已用 ${recovery.used} 轮将保留，当前限额 ${recovery.limit}→${recovery.targetLimit} 轮。\n${recovery.detail}\n这不是制作成功或质检通过的证明。`);
    if (confirmed !== true) return null;
    if (signature !== signatureOf(getTask())) {
      throw new Error('任务或执行轮次已变化，未提交追加；请核对当前视图后重新确认。');
    }
    options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      additionalRepairs: recovery.additionalRepairs, taskId: task.taskId ?? task.id, attemptId: task.attemptId,
    }) };
  }
  const result = await request(options);
  if (recovery.blocked) {
    const actual = result?.task;
    const actualLimit = actual?.repairRecovery?.limit ?? actual?.automationSummary?.repairLimit;
    const actualUsed = actual?.repairRecovery?.used ?? actual?.automationSummary?.repairUsed;
    if (actualLimit !== recovery.targetLimit || (actual?.taskId ?? actual?.id) !== (task.taskId ?? task.id)
      || integer(actualUsed) && actualUsed < recovery.used) {
      throw new Error('服务器未确认当前任务的新修复限额，不能认定追加授权成功。旧服务可能忽略请求内容，请重启工作台后核对；不要自动重试。');
    }
  }
  return result;
}
