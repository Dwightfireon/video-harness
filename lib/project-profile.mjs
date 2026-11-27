/* 项目目录 PROJECT.json 的 contentProfile 读写薄适配层。
 *
 * 与纯函数层 lib/content-profile.mjs 分离：
 *   - 仅在 CLI（vh.mjs）、HTTP（server.mjs）或项目级审校入口需要落盘/读取项目配置时引入；
 *   - 队列（schedule.mjs）、提示词拼装（task-prompts.mjs）、发现规则（discovery-*）均不依赖本文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  extractBriefMetadata,
  normalizeContentProfile,
  resolveContentProfile,
  validResolvedProfile,
} from './content-profile.mjs';

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

export function readProjectContentProfile(project) {
  if (!project) return 'auto';
  try {
    const data = JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8'));
    return normalizeContentProfile(data?.contentProfile, 'auto');
  } catch {
    return 'auto';
  }
}

export function configureContentProfile(project, profile) {
  const normalized = normalizeContentProfile(profile, null);
  if (!normalized) throw new Error('内容定位只能选择 auto、intel、science 或 opinion');
  const file = path.join(project, 'PROJECT.json');
  const before = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(before);
  if (normalized === 'auto' && data.contentProfile === undefined) return 'auto';
  const nextData = { ...data };
  if (normalized === 'auto') delete nextData.contentProfile;
  else nextData.contentProfile = normalized;
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(nextData, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (fs.readFileSync(file, 'utf8') !== before) throw new Error('保存内容定位时项目配置已变化，未覆盖');
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
  return normalized;
}

export function resolveProjectContentProfile(project, {
  explicit = '',
  message = '',
  plan = '',
  materials = '',
} = {}) {
  const cli = normalizeContentProfile(explicit, 'auto');
  const configured = project ? readProjectContentProfile(project) : 'auto';
  const matText = materials || (project
    ? [readIf(path.join(project, 'materials', '选题.md')), readIf(path.join(project, 'materials', '原文.md'))].filter(Boolean).join('\n')
    : '');
  const planText = plan || (project ? readIf(path.join(project, '方案.md')) : '');
  const upstreamText = [message, matText].filter(Boolean).join('\n');
  const combined = [upstreamText, planText].filter(Boolean).join('\n');
  const upstreamMeta = extractBriefMetadata(upstreamText);
  const planMeta = extractBriefMetadata(planText);
  const checkedAt = upstreamMeta.checkedAt || planMeta.checkedAt;
  const checkedDate = upstreamMeta.checkedDate || planMeta.checkedDate;

  if (validResolvedProfile(cli)) {
    return { profile: cli, source: 'explicit', checkedAt, checkedDate };
  }
  if (validResolvedProfile(configured)) {
    return { profile: configured, source: 'project-config', checkedAt, checkedDate };
  }
  if (upstreamMeta.explicitProfile) {
    return { profile: upstreamMeta.explicitProfile, source: 'topic-brief', checkedAt, checkedDate };
  }
  if (planMeta.explicitProfile) {
    return { profile: planMeta.explicitProfile, source: 'author-plan', checkedAt, checkedDate };
  }
  return {
    profile: resolveContentProfile({ text: combined }),
    source: 'inferred',
    checkedAt,
    checkedDate,
  };
}
