/* 投稿表单/媒体约束与 payload 映射。无 Node/Electron 依赖，前端与执行端共享。 */
import { partitionIdProblems, formPartition, HUMAN_PARTITION_TAXONOMY, HUMAN_COMPAT_TID } from './partitions.mjs';
import { splitTags } from '../lib/tags.mjs';
import { publishLimitIssues } from '../lib/publish-limits.mjs';
import { audienceIssues } from '../lib/publish-audience.mjs';
import { normalizePromotion, promotionProblems, promotionPayload, marketingStatement } from './promotion.mjs';
export { splitTags } from '../lib/tags.mjs';
export { BILIBILI_LIMITS as LIMITS } from '../lib/publish-limits.mjs';

export function normalizeForm(input = {}) {
  const { taxonomy, id } = formPartition(input);
  return { title: String(input.title ?? '').trim(), desc: String(input.desc ?? ''), tags: splitTags(input.tags),
    partitionTaxonomy: taxonomy, humanType2: taxonomy === HUMAN_PARTITION_TAXONOMY ? Number(id) : 0,
    tid: taxonomy === HUMAN_PARTITION_TAXONOMY ? HUMAN_COMPAT_TID : Number(input.tid),
    copyright: Number(input.copyright ?? 1), source: String(input.source ?? ''),
    noReprint: input.noReprint ? 1 : 0, dynamic: String(input.dynamic ?? ''), dtime: input.dtime ?? null,
    promotion: normalizePromotion(input.promotion) };
}

export function validateForm(input) {
  const form = normalizeForm(input), problems = [];
  if (!form.title) problems.push('标题不能为空');
  problems.push(...publishLimitIssues(form).map(issue => issue.message));
  /* 投稿表单里的标题与简介会原样公开：取材过程与内部记录不能混进去。
   * 短字段（标题）里的疑似取材叙述在 checkPublish 里只算提示，这里只取错误。 */
  problems.push(...audienceIssues({ main: form.title, desc: form.desc }).errors.map(issue => issue.message));
  const selection = formPartition(form);
  problems.push(...partitionIdProblems(selection.id, selection.taxonomy));
  if (selection.taxonomy !== HUMAN_PARTITION_TAXONOMY && Number(input?.humanType2) > 0) problems.push('新版分区必须使用 human-type2 模式，不能混入旧投稿参数');
  if (!form.tags.length) problems.push('至少填一个标签');
  if (![1, 2].includes(form.copyright)) problems.push('版权类型只能是 1（自制）或 2（转载）');
  if (form.copyright === 2 && !form.source.trim()) problems.push('选转载就必须填来源地址');
  problems.push(...promotionProblems(input?.promotion));
  return problems;
}

export function validateInput(input, draft) {
  const problems = validateForm(input);
  if (!draft?.video?.path) problems.push('这个项目没有可用成片');
  for (const blocker of draft?.blockers || []) problems.push(blocker.text);
  // 兼容旧 adapter 的草稿；新 adapter 使用结构化 blockers，不由提示文案推导权限。
  if (!draft?.blockers && draft?.warnings?.some(w => w.code === 'video-stale')) problems.push('成片与当前时间轴不一致，先重新出片');
  if (input?.cover !== false && draft?.cover?.ok === false && input?.cover) problems.push('勾选了上传封面，但当前没有可用封面');
  return [...new Set(problems)];
}

/* 预览和正式提交只在 video/cover 上不同，其余字段统一在这里映射。 */
export function buildPayload(input) {
  const form = normalizeForm(input), problems = validateForm(input);
  if (!input?.video?.filename) problems.push('还没有上传完成的视频文件名');
  if (problems.length) throw Object.assign(new Error('投稿参数不完整：' + problems.join('；')), { step: 'payload', problems });
  const payload = {
    copyright: form.copyright, source: form.source, tid: form.tid, cover: String(input.cover || ''),
    title: form.title, desc: form.desc, desc_format_id: 0, dynamic: form.dynamic,
    subtitle: { open: 0, lan: '' }, tag: form.tags.join(','),
    videos: [{ title: form.title, filename: input.video.filename, desc: form.desc }],
    open_subtitle: false, interactive: 0, dolby: 0, lossless_music: 0, no_reprint: form.noReprint, charging_pay: 0,
  };
  if (form.partitionTaxonomy === HUMAN_PARTITION_TAXONOMY) payload.human_type2 = form.humanType2;
  if (form.dtime) payload.dtime = Number(form.dtime);
  const porder = promotionPayload(form.promotion);
  if (porder) payload.porder = porder;
  const statement = marketingStatement(form.promotion);
  if (statement) payload.creation_statement = statement;
  return payload;
}
