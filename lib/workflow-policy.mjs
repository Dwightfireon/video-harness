/* One workflow policy across authoring, production and delivery. This changes
 * optional editorial work, never security, artifact integrity or paid-review consent. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const WORKFLOW_PROFILES = Object.freeze(['content-first', 'audited']);

function metadata(project) {
  try { return JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function workflowPolicy(project) {
  const data = metadata(project), configured = data.workflow;
  if (configured != null && (!configured || typeof configured !== 'object' || Array.isArray(configured)))
    throw new Error('workflow 必须是包含 profile 的对象');
  const profile = configured?.profile ?? 'content-first';
  if (!WORKFLOW_PROFILES.includes(profile)) throw new Error('workflow.profile 只能是 content-first 或 audited');
  const audited = profile === 'audited';
  return { version: 1, profile, editorialDiagnostics: audited, visualAudit: audited,
    qualityProfile: audited ? 'strict' : 'technical', releaseReviewRequired: audited,
    claimsRequired: audited || data.contentReview?.required === true };
}

export function workflowPrompt(project) {
  const policy = workflowPolicy(project);
  return `【当前工作流 v${policy.version}：${policy.profile}】\n` + (policy.profile === 'content-first'
    ? '内容优先：读懂来源、写连贯口播、用简洁画面说明，再由执行器推进最少失效技术阶段并交付首个完整版本。形式诊断、打分、两版试稿、关键样片和人工审核表不是默认前置步骤；不要为这些另起模型轮次或反复改片。关键出处保留在原文及方案/脚本中，不为凑表逐条外查；claims.json 仅在明确需要时登记。普通 pack 可直接导出，不要求审核签字。'
    : '审校模式：运行完整形式诊断与实测视觉检查，发布验收要求当前审阅记录；未执行不标通过。') +
    '\n技术保护、配音实测、字幕完整、当前媒体与缓存身份、用户明确要求和来源真实性仍须满足。历史明确启用的模型审稿合同独立保留，不自动开启付费审稿。交付说明实际路径与未验证项，不把机器检查说成看过、听过或发布授权。';
}

export function configureWorkflow(project, profile) {
  if (!WORKFLOW_PROFILES.includes(profile)) throw new Error('工作流只能是 content-first 或 audited');
  const file = path.join(project, 'PROJECT.json'), before = fs.readFileSync(file, 'utf8'), data = JSON.parse(before);
  const backups = path.join(project, 'out/.vh-workflow-backups');
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, randomUUID() + '.json'), before, { flag: 'wx', mode: 0o600 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...data, workflow: { ...data.workflow, version: 1, profile } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (fs.readFileSync(file, 'utf8') !== before) throw new Error('保存工作流时项目配置改变，未覆盖');
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return workflowPolicy(project);
}
