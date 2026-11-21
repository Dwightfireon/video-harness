/* 草稿组装：把项目接口（adapter）的返回值整理成投稿台需要的形状。
 *
 * 这一层只做“组合 + 判断”，不读文件、不解析格式、不碰 harness 内部；
 * adapter 换成假实现就能完整单测。
 */
import path from 'node:path';

function splitCoverCopy(text) {
  const out = { main: '', sub: '' };
  for (const raw of String(text || '').split('\n')) {
    const match = raw.match(/^\s*(主|副)\s*[：:]\s*(.+)$/);
    if (match) out[match[1] === '主' ? 'main' : 'sub'] = match[2].trim();
  }
  return out;
}

export function composeDraft({ id, dir, copy, copyStatus, video, videoState, cover, review, coverIssues = [], task = null, productionChanged = false }) {
  const warnings = [];
  const warn = (code, text) => warnings.push({ code, text });

  if (!copy) warn('no-copy', '还没有发布文案.md：标题/简介/标签需要手填，或先在 vh 工作台生成。');
  // 文案缺失已经由 no-copy 说明；文案检查器必然再次报告同一件事，重复显示只会淹没真正的问题。
  for (const message of copyStatus?.errors || []) {
    if (!copy && /没有发布文案|缺少发布文案/.test(message)) continue;
    warn('copy-error', message);
  }
  for (const message of copyStatus?.warnings || []) warn('copy-warning', message);
  if (!video) warn('no-video', '没有成片：先 vh go 出片，发布台不会替你渲染。');
  // 成片与时间轴不符是要害问题：发出去的是旧画面。必须说“不能发”，不能只说“可能过期”。
  else if (videoState?.stale) warn('video-stale', '成片与当前时间轴不一致，不能按这版发布：' + (videoState.reason || '需重新出片'));
  if (task?.running || task?.taskRunning || task?.productionBusy || task?.orphanRunning || task?.cancelling) warn('project-running', '项目仍在制作或取消，等待完成后再发布，不使用遗留成片');
  if (productionChanged) warn('project-changed', '读取成片期间任务发生变化，等待重新核验');
  if (!cover?.ok) {
    // 原因和下一步要说清：封面过期通常只是重生成一次，不是重做视频。
    const code = cover?.code || '';
    const how = ['copy-changed', 'input-changed', 'legacy'].includes(code)
      ? '封面图还在，只是绑定的输入变了：运行 vh cover 重新生成一次即可，不会重做视频。'
      : code === 'missing' ? '还没有生成封面：运行 vh cover。'
        : code === 'missing-file' || code === 'tampered' ? '封面图片缺失或被改动：运行 vh cover 重新生成。'
          : '请运行 vh cover 重新生成，或在发布台取消勾选上传封面。';
    warn('no-cover', (cover?.reason || '没有可用封面') + '。' + how);
  }
  for (const issue of coverIssues) warn('cover-issue', issue);
  if (!copy?.tags?.length) warn('no-tags', '文案里没有标签；B 站要求至少 1 个，建议 3–6 个。');
  if (!review || review.state === 'unavailable') {
    warn('review-unavailable', '未能核验内容、画面与音频审阅状态；素材齐全不等于发布审阅通过。');
  } else if (!review.ok) {
    const issues = (review.issues || []).map(issue => issue.message).filter(Boolean);
    const detail = issues.length ? '：' + issues.slice(0, 4).join('；') + (issues.length > 4 ? `；另有 ${issues.length - 4} 项` : '') : '';
    warn('review-pending', '发布审阅待核或未通过' + detail + '。这与投稿表单能否提交是两回事。');
  } else {
    warn('review-recorded', '发布审阅声明及依据指纹已登记；程序不能证明实际看过、听过或判断事实语义。');
  }

  const coverCopy = splitCoverCopy(copy?.cover || '');
  const tags = copy?.tags || [];
  const blockers = warnings.filter(w => ['no-video', 'video-stale', 'project-running', 'project-changed'].includes(w.code));
  return {
    id,
    dir,
    task,
    copy: { main: copy?.title || '', alts: copy?.alts || [], desc: copy?.desc || '', comment: copy?.comment || '',
      tags, coverMain: coverCopy.main, coverSub: coverCopy.sub },
    fields: { title: copy?.title || '', desc: copy?.desc || '', tags: tags.join(' ') },
    publish: { ok: Boolean(copyStatus?.ok), revision: copyStatus?.revision ?? null },
    review: review || { ok: false, state: 'unavailable', statuses: {}, issues: [] },
    video: video ? { file: path.basename(video.file || video.path), path: video.path, kind: video.kind, bytes: video.bytes, duration: video.duration, fingerprint: video.fingerprint || null } : null,
    cover: cover?.ok ? { ok: true, file: cover.file, path: cover.path, bytes: cover.bytes, thumb: cover.thumb } : { ok: false, code: cover?.code || '', reason: cover?.reason || '没有封面' },
    warnings,
    blockers,
    ready: !blockers.length && Boolean(video) && Boolean(copy?.title) && Boolean(copyStatus?.ok),
  };
}
