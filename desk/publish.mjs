/* 投稿编排（纯逻辑，不依赖 Electron、不依赖 harness 内部模块）。
 *
 * 输入是已经整理好的草稿（draft）与表单（input），加上注入的 B 站客户端；
 * 输出是逐步进度与最终结果。文件读取、界面、凭据存储都不在这里，
 * 所以可以脱离窗口用假客户端跑完整流程测试。
 *
 * 顺序固定：视频 → 封面 → 组 payload → 提交。
 * 任何一步失败都立刻停下并保留已完成步骤，不自动重提投稿。
 */

import { validateInput, normalizeForm } from './publish-contract.mjs';
import { verifyMarketingStatement } from './promotion.mjs';
export { LIMITS, validateInput, splitTags } from './publish-contract.mjs';

export function summarizeSteps(steps) {
  return steps.map(step => `${step.state === 'failed' ? '✗' : '✓'} ${step.name}` + (step.detail ? `：${step.detail}` : ''));
}

/* 实际执行。所有副作用都来自参数：api（上传/提交）、prepareCover（读图/转码）。
 * 返回 { ok, steps, video, cover, payload, result } 或抛出带 steps 的错误。 */
export async function runPublish({ draft, input, api, prepareCover, cleanupCover = () => {}, onStep = () => {} }) {
  const problems = validateInput(input, draft);
  if (problems.length) throw Object.assign(new Error('投稿参数不完整：' + problems.join('；')), { steps: [], problems });
  if (!prepareCover) throw new Error('缺少封面处理函数');

  const steps = [], warnings = [];
  let prepared = null;
  let stage = 'preflight';
  const step = (name, detail) => {
    const previous = steps[steps.length - 1];
    if (previous && previous.state === 'doing') previous.state = 'done';
    const entry = { name, detail: detail || '', state: 'doing' };
    steps.push(entry);
    // 进度展示不是投稿本身；窗口关闭/通知异常不能把已提交稿件变成“失败”。
    try { onStep({ ...entry }); } catch { warnings.push('进度通知失败，请以最终结果为准'); }
    return entry;
  };
  const finish = () => { const last = steps[steps.length - 1]; if (last && last.state === 'doing') last.state = 'done'; };
  const fail = error => {
    const last = steps[steps.length - 1];
    if (last && last.state === 'doing') last.state = 'failed';
    if (!steps.some(item => item.state === 'failed')) steps.push({ name: '失败', detail: error.message, state: 'failed' });
    error.steps = steps;
    error.stage = stage;
    error.outcome ||= stage === 'submit' ? 'unknown' : 'not-submitted';
    error.warnings = warnings;
    return error;
  };

  try {
    // 所有本地检查在远端上传前完成，避免传完整个视频才发现封面尺寸错误。
    if (input.cover !== false && draft.cover?.ok) {
      prepared = prepareCover(draft.cover.path);
      if (!prepared.ok) throw new Error('封面不可用：' + (prepared.issues || []).join('；'));
    }
    stage = 'video';
    step('上传视频', draft.video.file);
    const video = await api.uploadVideo(draft.video.path);
    step('视频已上传', `${video.filename} · ${video.chunks} 块`);

    let coverUrl = '';
    if (prepared) {
      stage = 'cover';
      step('上传封面', (prepared.file.split('/').pop() || '') + (prepared.note ? `（${prepared.note}）` : ''));
      coverUrl = await api.uploadCover(prepared.file);
      step('封面已上传', coverUrl);
    }

    stage = 'payload';
    const payload = api.buildPayload({ ...normalizeForm(input), cover: coverUrl, video });
    stage = 'submit';
    step('提交投稿', payload.title);
    const result = await api.submit(payload);
    step('已提交', result.bvid ? 'BV ' + result.bvid : 'aid ' + (result.aid ?? '—'));
    let declarationVerification = null;
    if (payload.creation_statement) {
      step('回读营销声明', '只查询平台资料，不修改或重发');
      let archive;
      try { archive = await api.archiveDetail({ bvid: result.bvid, aid: result.aid }); }
      catch { /* 收稿已成功；回读失败绝不能变成可重试的投稿失败。 */ }
      declarationVerification = verifyMarketingStatement(archive);
      steps[steps.length - 1].detail = declarationVerification.message;
      if (declarationVerification.state !== 'confirmed') warnings.push(declarationVerification.message);
    }
    finish();
    return { ok: true, outcome: 'submitted', steps, video, cover: coverUrl, payload, result, warnings, declarationVerification };
  } catch (error) {
    throw fail(error);
  } finally {
    if (prepared) {
      try { cleanupCover(prepared); } catch { warnings.push('封面临时文件清理失败；不改变投稿结果'); }
    }
  }
}
