/* 作品投稿资料独立保存：不改作者文案，不启用排程，不把保存当投稿。 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicJSON } from './checkpoint.mjs';
import { acquireProductionLock } from './production-lock.mjs';
import { splitTags } from './tags.mjs';
import { publishLimitIssues } from './publish-limits.mjs';
import { audienceIssues } from './publish-audience.mjs';
import { normalizePromotion, promotionProblems } from '../desk/promotion.mjs';
import { formPartition, partitionIdProblems, HUMAN_PARTITION_TAXONOMY, HUMAN_COMPAT_TID } from '../desk/partitions.mjs';

export const PUBLISH_FORM_FILE = '.publish-form.json';
function normalize(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('投稿资料格式无效');
  for (const field of ['title', 'desc']) if (input[field] != null && typeof input[field] !== 'string') throw new Error('标题和简介须为文字');
  if (input.cover !== undefined && typeof input.cover !== 'boolean') throw new Error('封面选择须为布尔值');
  const fields = { title: (input.title || '').trim(), desc: input.desc || '', tags: splitTags(input.tags),
    cover: input.cover !== false, promotion: normalizePromotion(input.promotion) };
  const problems = [...publishLimitIssues(fields).map(item => item.message),
    ...audienceIssues({ main: fields.title, desc: fields.desc }).errors.map(item => item.message), ...promotionProblems(input.promotion)];
  const { taxonomy, id } = formPartition(input);
  let partition = null;
  if (id) {
    problems.push(...partitionIdProblems(id, taxonomy));
    partition = { partitionTaxonomy: taxonomy, tid: Number(input.tid), humanType2: Number(input.humanType2) || 0 };
    if (!Number.isSafeInteger(partition.tid) || partition.tid <= 0) problems.push('投稿分区参数无效');
    if (taxonomy === HUMAN_PARTITION_TAXONOMY && partition.tid !== HUMAN_COMPAT_TID) problems.push('新版分区的兼容 tid 不正确，请刷新分区');
    if (taxonomy !== HUMAN_PARTITION_TAXONOMY && partition.humanType2) problems.push('旧版分区不能混入 human_type2');
  }
  if (problems.length) throw new Error(problems.join('；'));
  return { fields, partition };
}

export function readPublishForm(dir) {
  if (!dir) return null;
  let raw;
  try { raw = fs.readFileSync(path.join(dir, PUBLISH_FORM_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1 || !data.fields || !data.fields.promotion || typeof data.savedAt !== 'string') throw new Error('schema');
    const normalized = normalize({ ...data.fields, ...data.partition });
    return { ...data, ...normalized };
  } catch { throw new Error('已保存投稿资料损坏或格式无效；不会当作空资料或取消商业声明，请保留文件并检查'); }
}

export function savePublishForm(dir, input, revision) {
  const normalized = normalize(input);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('请先读取投稿资料版本');
  const lockDir = path.join(dir, 'out', '.publish-settings');
  fs.mkdirSync(lockDir, { recursive: true });
  const lock = acquireProductionLock(lockDir, { command: 'publish-settings', env: {} });
  try {
    const current = readPublishForm(dir);
    if ((current?.revision || 0) !== revision) throw Object.assign(new Error('其他页面已修改投稿资料。当前编辑已保留，请先读取已保存资料，再核对并保存。'), { statusCode: 409 });
    const record = { version: 1, revision: revision + 1, savedAt: new Date().toISOString(), ...normalized };
    atomicJSON(path.join(dir, PUBLISH_FORM_FILE), record);
    return record;
  } finally { lock.release(); }
}

export function applyPublishForm(draft) {
  const savedForm = readPublishForm(draft.dir);
  if (!savedForm) return { ...draft, savedForm: null, coverWanted: true };
  const fields = savedForm.fields;
  return { ...draft, savedForm, coverWanted: fields.cover, promotion: fields.promotion,
    fields: { ...draft.fields, title: fields.title, desc: fields.desc, tags: fields.tags.join(' ') },
    copy: { ...draft.copy, main: fields.title, desc: fields.desc, tags: fields.tags },
    publish: { ...draft.publish, ok: Boolean(fields.title && fields.tags.length), savedForm: true } };
}
