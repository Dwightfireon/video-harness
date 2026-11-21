/* 渲染前资源预算：并发有界，磁盘预估明确标注不确定性，不冒充实测耗时。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { observeMacMemory, macMemoryAllowance } from './macos-memory.mjs';

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const presets = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo']);
export function renderRequestError(options = {}) {
  if (options.all && options.scenes !== undefined) return '--all 与 --scenes 不能混用；请明确整片或局部渲染，未开始截图';
  if (options.from !== undefined || options.to !== undefined) return '正式管道暂不为 --from/--to 的任意帧范围登记整片凭证；请使用覆盖全部改动的 --scenes 或 --all，预览用 stills --at';
  if (options.encodeOnly) return '现有帧没有逐帧来源凭证，不能用 --encode-only 为当前整片登记新版本；请先 --all 重渲';
  if (options.scenes !== undefined && !/^\d+(?:,\d+)*$/.test(options.scenes)) return '--scenes 场号无效，未开始截图';
  return null;
}
export function renderSettings(options = {}, machine = {}) {
  const number = (key, fallback, min, max, integer = false) => {
    const raw = options[key] === undefined ? fallback : options[key];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) throw new Error(`${key} 必须为 ${min}–${max} 的${integer ? '整数' : '有限数值'}`);
    return n;
  };
  const width = number('width', 1920, 1, 8192, true), height = number('height', 1080, 1, 8192, true);
  const fps = number('fps', 30, 1, 120, true), crf = number('crf', options.hq ? 17 : 18, 0, 51);
  const preset = options.preset === undefined ? options.hq ? 'slow' : 'medium' : options.preset;
  if (!presets.has(preset)) throw new Error('preset 不是有效的 x264 编码预设');
  const cpu = Math.max(1, Math.floor(machine.cpus ?? os.availableParallelism?.() ?? os.cpus().length) - 1);
  const freeMemory = machine.freeMemory ?? os.freemem();
  const workerBytes = 256 * MiB + width * height * 4 * 8;
  // 旧 machine 注入（cpus/freeMemory）保持纯函数，不偷偷读取宿主 macOS。
  // 要测试 macOS，显式注入 platform:'darwin' 和 macMemory（null 代表未知）。
  const platform = machine.platform ?? (Object.keys(machine).length ? 'injected' : os.platform());
  const observation = platform === 'darwin'
    ? (Object.keys(machine).length ? machine.macMemory : observeMacMemory()) : null;
  const memoryPolicy = platform === 'darwin' ? macMemoryAllowance(observation, freeMemory, workerBytes)
    : { memory: Number.isFinite(freeMemory) && freeMemory >= 0 ? Math.max(1, Math.floor(Math.max(0, freeMemory - 512 * MiB) * .65 / workerBytes)) : 1,
      creditBytes: 0, reason: '系统空闲内存扣除 512 MiB 后按 65% 预算' };
  const memory = memoryPolicy.memory;
  const requestedJobs = options.jobs === undefined ? null : number('jobs', 1, 1, 32, true);
  const jobs = Math.min(requestedJobs ?? 4, cpu, memory, 32);
  const warnings = [];
  if (jobs < (requestedJobs ?? 4)) warnings.push(`${requestedJobs ? '请求 ' + requestedJobs : '默认最多 4'} 路，按当前 CPU/可用内存降为 ${jobs} 路；不是性能保证`);
  if (platform === 'darwin') warnings.push(memoryPolicy.reason);
  return { width, height, fps, preset, crf, jobs, requestedJobs, workerBytes, freeMemory,
    memoryPolicy: { ...memoryPolicy, platform, observation },
    limits: { cpu, memory, defaultMax: 4, hardMax: 32 }, warnings };
}

export function renderBudget({ duration, settings, freeBytes = null, existingFrameBytes = 0 }) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('资源预算需要有效视频时长');
  const frames = Math.round(duration * settings.fps);
  const pixels = settings.width * settings.height;
  const frameBytesLow = Math.max(16 * 1024, pixels * .025), frameBytesHigh = Math.max(64 * 1024, pixels * .2);
  const frameRange = { low: Math.ceil(frames * frameBytesLow), high: Math.ceil(frames * frameBytesHigh) };
  const reserveBytes = 512 * MiB;
  // 不把可压缩率估计当硬下界。只在确定连安全余量都不足时硬拦，未知容量不报“通过”。
  const known = Number.isFinite(freeBytes) && freeBytes >= 0;
  const warnings = [...settings.warnings];
  if (!known) warnings.push('无法读取目标卷剩余空间，磁盘预检未完成');
  else if (freeBytes < frameRange.high + reserveBytes) warnings.push('剩余空间低于帧缓存高位估计；复杂画面可能更大，请保留编码临时空间');
  return { ok: !known || freeBytes >= reserveBytes, frames, duration, settings,
    freeBytes: known ? freeBytes : null, reserveBytes, frameRange, existingFrameBytes, warnings,
    note: 'JPEG 帧空间范围仅为估计，不含准确编码大小、TTS/素材增长或制作耗时；缓存不按字节数直接折抵所需空间' };
}

export function diskObservation(project, statfs = fs.statfsSync) {
  let volume = path.resolve(project, 'out');
  while (!fs.existsSync(volume) && path.dirname(volume) !== volume) volume = path.dirname(volume);
  try { const s = statfs(volume); return { volume, freeBytes: Number(s.bavail) * Number(s.bsize) }; }
  catch { return { volume, freeBytes: null }; }
}

export function budgetReport(budget) {
  const gb = n => (n / GiB).toFixed(2);
  return [`渲染预算：${budget.duration}s @ ${budget.settings.fps}fps，${budget.frames} 帧，${budget.settings.jobs} 路`,
    `  CPU 上限 ${budget.settings.limits.cpu} 路；内存估计上限 ${budget.settings.limits.memory} 路（系统报告空闲 ${gb(budget.settings.freeMemory)} GiB${budget.settings.memoryPolicy?.effectiveFreeBytes != null ? `；实际按可回收空闲页 ${gb(budget.settings.memoryPolicy.effectiveFreeBytes)} GiB` : ''}；缓存折扣额度 ${gb(budget.settings.memoryPolicy?.creditBytes ?? 0)} GiB，均不是可用内存实测）`,
    `  JPEG 帧估计 ${gb(budget.frameRange.low)}–${gb(budget.frameRange.high)} GiB；目标卷可用 ${budget.freeBytes == null ? '未知' : gb(budget.freeBytes) + ' GiB'}`,
    ...budget.warnings.map(w => '  ⚠ ' + w),
    ...(!budget.ok ? ['  ✗ 目标卷不足 512 MiB 安全余量，未开始渲染；先释放空间'] : [])].join('\n');
}

export function sameRenderSettings(record, settings) {
  let previous = record?.settings;
  if (!previous && record?.params) {
    const args = record.params;
    const value = key => args.match(new RegExp('(?:^|\\s)--' + key + '\\s+(\\S+)'))?.[1];
    const fast = /(?:^|\s)--fast(?:\s|$)/.test(args);
    previous = { fps: Number(value('fps') ?? 30), crf: Number(value('crf') ?? (fast ? 18 : 17)),
      preset: value('preset') ?? (fast ? 'medium' : 'slow'), width: settings.width, height: settings.height };
  }
  return !!previous && ['fps', 'crf', 'preset', 'width', 'height'].every(key => previous[key] === settings[key]);
}
