/* Content determines duration by default. An explicit user cap remains binding;
 * resource/measurement/quality safety is separate from an editorial time limit. */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DURATION_LIMIT = null;

/* Numeric integrity only; there is no arbitrary 8/15-minute editorial ceiling. */
export const MAX_DURATION_SECONDS = Number.MAX_SAFE_INTEGER;

export function durationLimit(project) {
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!Object.hasOwn(config, 'durationLimit')) return null;
  const value = config.durationLimit;
  if (value === null) return null;
  if (!value || !Number.isFinite(value.maxSeconds) || value.maxSeconds <= 0 || value.maxSeconds > MAX_DURATION_SECONDS ||
      !Number.isFinite(value.targetSeconds) || value.targetSeconds <= 0 || value.targetSeconds > value.maxSeconds) {
    throw new Error('时长限制配置无效：用 null 明确表示不限时长；maxSeconds 必须为正有限秒数，targetSeconds 为正数且不得超过上限');
  }
  return value;
}

// New policy-bearing projects need measured timing even when their editorial
// limit is null. Truly legacy hand-authored projects keep their old contract.
export function durationMeasurementRequired(project) {
  try { return Object.hasOwn(JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8')), 'durationLimit'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/* 用户主动调整时长上限。与 agent 的写保护区分开：
 * 模型不得改它来绕过限制，但用户本人当然可以决定自己的片长。 */
export function setDurationLimit(project, { maxSeconds, targetSeconds, unlimited = false } = {}) {
  const file = path.join(project, 'PROJECT.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (unlimited && (maxSeconds !== undefined || targetSeconds !== undefined)) throw new Error('--unlimited 不能与 --max / --target 同用');
  if (unlimited) {
    fs.writeFileSync(file, JSON.stringify({ ...config, durationLimit: null }, null, 2) + '\n');
    return null;
  }
  const current = durationLimit(project);
  const max = maxSeconds === undefined ? current?.maxSeconds : Number(maxSeconds);
  const target = targetSeconds === undefined
    ? Math.min(current?.targetSeconds ?? max, max)
    : Number(targetSeconds);
  if (!Number.isFinite(max) || max <= 0 || max > MAX_DURATION_SECONDS) {
    throw new Error('请用 --max 显式指定正有限秒数，或用 --unlimited 取消上限');
  }
  if (!Number.isFinite(target) || target <= 0 || target > max) {
    throw new Error('目标时长必须为正数，且不得超过上限');
  }
  fs.writeFileSync(file, JSON.stringify({ ...config, durationLimit: { maxSeconds: max, targetSeconds: target } }, null, 2) + '\n');
  return { maxSeconds: max, targetSeconds: target };
}

export function initializeDurationLimit(project) {
  const file = path.join(project, 'PROJECT.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 只由新建入口调用；已有显式设置不覆盖。
  if (Object.hasOwn(config, 'durationLimit')) return durationLimit(project);
  fs.writeFileSync(file, JSON.stringify({ ...config, durationLimit: DEFAULT_DURATION_LIMIT }, null, 2) + '\n');
  return DEFAULT_DURATION_LIMIT;
}

export function durationLimitError(limit, seconds, label = '时间轴', hint = '') {
  if (!limit) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return `${label}时长无法核验，先 vh measure 实测后再渲染`;
  if (seconds <= limit.maxSeconds) return null;
  const gap = (seconds - limit.maxSeconds).toFixed(1);
  return `${label} ${seconds.toFixed(2)} 秒，超过当前上限 ${limit.maxSeconds} 秒 ${gap} 秒。` +
    '两条路，选一条：' +
    '① 删减重复或非必要支线——用 vh trim 看候选，不删必要解释；改稿后重审并重新 measure；' +
    `② 内容确实需要更长——由你决定放宽上限：node vh.mjs duration --max ${Math.ceil(seconds / 60) * 60}，或 duration --unlimited 取消上限（不要靠加速旁白或裁尾绕过）` +
    (hint || '');
}

export function assertDurationLimit(project, seconds, label) {
  const error = durationLimitError(durationLimit(project), seconds, label);
  if (error) throw new Error(error);
}

export function durationPrompt(project) {
  try {
    const limit = durationLimit(project);
    if (!limit) return '【时长策略】不设视频时长硬上限，也不预设必须凑满的目标分钟数。按问题和受众把必要背景、对象、过程、判断依据与限定讲完整，内容需要多长就做多长；删重复和无关支线，不删推导，不为显得详细而注水。仍须实测配音，核对字幕与动作，并通过资源、媒体和质量检查；不靠加速旁白或裁尾制造简洁。';
    return `【时长上限】本项目最终成片不得超过 ${limit.maxSeconds} 秒（含片头、停顿、转场、片尾）。方案与脚本按约 ${limit.targetSeconds} 秒规划，预留配音余量；挑一个核心问题讲透，建议 6–8 场，不为凑场数扩写。先 build 草稿，再 measure 实测；超过上限先删重复和非必要支线，不删对象、前提、过程、判断依据与必要限定。不够则讨论缩范围/拆集或由用户决定放宽上限（可用 node vh.mjs duration --max N），不要靠加速旁白、裁尾或缩短实测槽位绕过。改画面优先静帧/HTML 预览，定稿再渲染；内容不足就短于目标，不注水。`;
  } catch { return '【时长配置异常】先修复时长限制配置，不能假定无上限继续出片。'; }
}

export function durationWriteRefusal(project, relative, content) {
  if (relative !== 'PROJECT.json') return null;
  const limit = durationLimit(project);
  try {
    if (JSON.stringify(JSON.parse(content).durationLimit ?? null) === JSON.stringify(limit)) return null;
  } catch {}
  return '拒绝：制作工具不得自行修改时长限制策略；用户可用 duration --max N 设置，或 duration --unlimited 取消，不能靠改元数据绕过明确要求';
}
