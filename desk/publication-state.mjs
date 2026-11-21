/* 面向人的发布状态：纯投影，不读取进程、媒体或日志，不以任务 completed 代替成片可用。
 * 事实由项目状态边界提供；真实投稿仍须在事务内重新核验。 */
export function publicationState({ task, draft, gate } = {}) {
  const result = (state, label, reason, eligible = false, waiting = false) => ({ state, label, reason, eligible, waiting });
  if (task?.running || task?.taskRunning || task?.productionBusy || task?.orphanRunning || task?.cancelling ||
      draft?.blockers?.some(item => item.code === 'project-running')) {
    if (task?.productionLock?.owner?.command === 'publish-upload') return result('producing', '投稿中，等待结束', '上传期间项目受保护，不能同时重新制作或再次投稿', false, true);
    return result('producing', '制作中，等待完成', '制作或取消尚未结束，不使用目录中遗留的旧成片', false, true);
  }
  if (!draft?.video) return result('waiting-video', '等待成片', '还没有可发布的带声成片', false, true);
  const stale = draft.blockers?.find(item => ['video-stale', 'project-changed'].includes(item.code));
  if (stale) return result('stale', '等待当前版本成片', stale.text, false, true);
  if (gate?.reason === 'duplicate') return result('submitted', '已投稿', gate.message);
  if (gate && !gate.ok) return result(gate.reason === 'unknown' ? 'unknown' : 'blocked', '投稿保护阻断', gate.message || '请检查投稿保护状态');
  const missing = [];
  if (!draft.fields?.title?.trim()) missing.push('标题');
  if (!String(draft.fields?.tags || '').trim()) missing.push('标签');
  if (draft.publish?.ok === false) missing.push('当前版本发布文案');
  if (draft.coverWanted !== false && !draft.cover?.ok) missing.push('可用封面（也可明确保存为不上传封面）');
  const coverIssue = draft.warnings?.find(item => item.code === 'cover-issue');
  if (coverIssue && draft.coverWanted !== false) missing.push(coverIssue.text);
  if (missing.length) return result('needs-attention', '待补投稿资料', '缺少或需要修正：' + [...new Set(missing)].join('、'));
  return result('ready', '待发资料就绪', '本地成片与资料已就绪；提交时仍须核对表单、账号和分区，不代表平台审核通过', true);
}

export function pendingSummary(items) {
  return { total: items.filter(item => item.state !== 'submitted').length,
    ready: items.filter(item => item.eligible).length, waiting: items.filter(item => item.waiting).length,
    needsAttention: items.filter(item => !item.eligible && !item.waiting && item.state !== 'submitted').length,
    submitted: items.filter(item => item.state === 'submitted').length, items };
}
