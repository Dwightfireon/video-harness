/* 展示实际关口，不把“文件存在”变成质量分数或虚构进度百分比。 */
const STAGES = { draft_plan: '选题与方案', draft_script: '脚本与证据', draft_claims: '事实来源', draft_scenes: '逐场制作画面',
  author_edit: '落实修改', define_change: '确认修改范围', verify_change: '核验修改',
  build: '构建画面预览', measure: '实测配音时间轴', render: '渲染视频', voice: '配音与字幕',
  publish: '发布文案', validate: '最终机械核验' };
export const stageLabel = stage => STAGES[stage] || '核对已有文件';
export const reviewRequired = state => state?.delivery?.review?.required ?? state?.workflow?.releaseReviewRequired ?? state?.workflow?.profile === 'audited';

export function projectProgress(state, task = {}) {
  if (!state) return { headline: '正在读取项目状态…', steps: [], next: null };
  const stale = state.stale || {}, delivery = state.delivery || {}, pub = delivery.publish || {};
  const requiredReview = reviewRequired(state);
  const steps = [
    { id: 'script', label: '脚本', state: state.script?.length ? 'done' : 'pending', note: state.script?.length ? '已保存' : '待编写', tab: 'chat' },
    { id: 'visual', label: '画面预览', state: state.sceneM && !stale.scene ? 'done' : state.sceneM ? 'stale' : 'pending', note: state.sceneM && !stale.scene ? '可预览，非视觉验收' : state.sceneM ? '需要更新' : '待构建', tab: 'chat' },
    { id: 'timing', label: '配音实测', state: state.timing?.state === 'valid' && !stale.measure ? 'done' : 'pending', note: state.timing?.state === 'valid' && !stale.measure ? '实测有效' : '待实测', tab: 'chat' },
    { id: 'video', label: '带声成片', state: delivery.video?.state === 'checked' ? 'done' : delivery.video?.state === 'stale' ? 'stale' : 'pending', note: delivery.video?.state === 'checked' ? '版本有效，仍须试听' : '待生成 / 更新', tab: 'chat' },
    { id: 'publish', label: '发布文案', state: pub.required === false ? 'optional' : !pub.ok ? 'pending' : pub.revision && pub.revision.state !== 'current' ? 'stale' : 'done',
      note: pub.required === false ? '仅视频交付，可选' : !pub.ok ? '待补齐 / 更新' : pub.revision && pub.revision.state !== 'current' ? '待核对版本' : '机械检查通过', tab: 'publish' },
    { id: 'review', label: requiredReview ? '人工审阅' : '人工审阅（可选）', state: delivery.review?.state === 'recorded' ? 'done' : requiredReview ? 'pending' : 'optional',
      note: delivery.review?.state === 'recorded' ? '仅表示已登记' : requiredReview ? '待审阅画面与声音' : '未验证，不阻塞交付', tab: 'video' },
  ];
  let headline = '逐步完成制作与交付';
  let nextStep = steps.find(s => s.state !== 'done' && s.state !== 'optional');
  let next = nextStep ? { tab: nextStep.tab, label: nextStep.tab === 'video' ? '去审阅成片' : nextStep.tab === 'publish' ? '去核对发布文案' : '去继续制作',
    detail: `${nextStep.label}：${nextStep.note}` } : { tab: 'video', label: '观看 / 下载成片', detail: '成片已交付，可观看、下载或使用 vh pack 导出；未验证事项不代表通过，也不会自动发布。' };
  if (task.cancelling) { headline = '正在取消，等待制作进程退出'; next = { tab: 'chat', label: '查看取消状态', detail: '登记进程退出前不能重新派发，不把已发送停止信号当成已停止。' }; }
  else if (task.running) { headline = '正在制作：' + stageLabel(task.stage); next = { tab: 'chat', label: '查看当前执行', detail: '阶段取自执行记录，不代表质量验收；无需重复提交。' }; }
  else if (task.orphanRunning) { headline = '上一工具仍在运行'; next = { tab: 'chat', label: '查看执行状态', detail: '先等待或手动取消，不重复启动任务。' }; }
  else if (task.canResume) { headline = task.status === 'paused' ? '任务已暂停，进度保留' : '任务未完成，已有产物保留'; next = { tab: 'chat', label: '查看原因并继续', detail: task.error?.message || task.resumeNotice || '继续原任务，不从头重复制作。' }; }
  /* 产物齐但流程没走完（用户中途停止、调度回收）：这不是"未完成"。
   * 说清"已经做完了，不用继续"，避免人不确定要不要再点一次。 */
  else if (task.delivered) { headline = '这一版已经做完，不需要继续'; next = { tab: 'chat', label: '要改就写要求', detail: '成片与发布物料都在。要调整就写一句改哪里；不改可直接去发布台。' }; }
  else if (delivery.video?.state === 'checked' && (!pub.required || pub.ok)) headline = requiredReview && delivery.review?.state !== 'recorded' ? '视频已生成，等待必需的人工审阅' : '视频已交付';
  return { headline, steps, next };
}
