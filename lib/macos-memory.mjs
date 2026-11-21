/* 只读 macOS 快照；不运行 memory_pressure（其压测模式会分配内存）。
 * 同步接口供 renderSettings 使用。首读采样约 300ms，随后进程内缓存 2s。
 * 计数器是启动以来累计值，必须作差；已有 swap 不等于正在交换。
 */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MiB = 1024 ** 2;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function parseMacMemory(vm, sys) {
  const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1]);
  const pages = label => {
    const value = vm.match(new RegExp('^' + label + ':\\s+(\\d+)\\.?$', 'm'))?.[1];
    return value === undefined ? NaN : Number(value);
  };
  const scalar = name => Number(sys.match(new RegExp('^' + name.replaceAll('.', '\\.') + ':\\s+(\\d+)\\s*$', 'm'))?.[1]);
  const swap = sys.match(/vm\.swapusage:.*?used\s*=\s*([\d.]+)([KMGT])/);
  const result = {
    totalBytes: scalar('hw.memsize'), pressure: scalar('kern.memorystatus_vm_pressure_level'),
    freeBytes: pages('Pages free') * pageSize,
    fileBytes: pages('File-backed pages') * pageSize,
    inactiveBytes: pages('Pages inactive') * pageSize,
    speculativeBytes: pages('Pages speculative') * pageSize,
    compressorBytes: pages('Pages occupied by compressor') * pageSize,
    swapUsedBytes: swap ? Number(swap[1]) * 1024 ** ('KMGT'.indexOf(swap[2]) + 1) : NaN,
    swapins: pages('Swapins'), swapouts: pages('Swapouts'), pageouts: pages('Pageouts'),
  };
  if (![4096, 16384].includes(pageSize) || !Object.values(result).every(n => Number.isFinite(n) && n >= 0) || result.totalBytes < MiB) {
    throw new Error('macOS 内存字段缺失或无效');
  }
  return result;
}

export function createMacMemoryObserver({
  run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 1500, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } }),
  now = () => performance.now(), sleep = pause,
} = {}) {
  let cached, cachedAt = -Infinity;
  const snapshot = () => parseMacMemory(run('/usr/bin/vm_stat', []),
    run('/usr/sbin/sysctl', ['hw.memsize', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage']));
  return () => {
    if (cached && now() >= cachedAt && now() - cachedAt < 2000) return structuredClone(cached);
    try {
      const before = snapshot(), start = now();
      sleep(300);
      const after = snapshot(), sampleMs = now() - start;
      const deltas = Object.fromEntries(['swapins', 'swapouts', 'pageouts'].map(k => [k, after[k] - before[k]]));
      const valid = sampleMs >= 250 && sampleMs <= 5000 && before.totalBytes === after.totalBytes && Object.values(deltas).every(n => n >= 0);
      cached = { status: valid ? 'known' : 'unknown', ...after, sampleMs, deltas,
        pressure: before.pressure !== 1 ? before.pressure : after.pressure,
        compressorBytes: Math.max(before.compressorBytes, after.compressorBytes),
        swapUsedBytes: Math.max(before.swapUsedBytes, after.swapUsedBytes),
        freeBytes: Math.min(before.freeBytes, after.freeBytes),
        fileBytes: Math.min(before.fileBytes, after.fileBytes),
        inactiveBytes: Math.min(before.inactiveBytes, after.inactiveBytes),
        speculativeBytes: Math.min(before.speculativeBytes, after.speculativeBytes) };
    } catch (error) {
      cached = { status: 'unknown', reason: String(error.message).slice(0, 300) };
    }
    cachedAt = now();
    return structuredClone(cached);
  };
}

export const observeMacMemory = createMacMemoryObserver();

// “文件页”未必干净或可立即回收，inactive 也未必是文件页。
// 因此只取两者较小值的一半，最多物理内存 15%，不加 purgeable（可能重叠）。
// 这是保守启发式额度，不是操作系统 available，也不是不会 OOM 的保证。
export function macMemoryAllowance(observation, freeBytes, workerBytes) {
  const o = observation;
  const unknown = { memory: 1, creditBytes: 0, reason: 'macOS 压力/交换采样未知，保守单路' };
  if (!o || o.status !== 'known' || !Number.isFinite(o.sampleMs) || o.sampleMs < 250 || o.sampleMs > 5000) return unknown;
  const fields = ['totalBytes', 'pressure', 'freeBytes', 'fileBytes', 'inactiveBytes', 'speculativeBytes', 'compressorBytes', 'swapUsedBytes'];
  if (!fields.every(k => Number.isFinite(o[k]) && o[k] >= 0) || o.totalBytes < MiB ||
      !['swapins', 'swapouts', 'pageouts'].every(k => Number.isFinite(o.deltas?.[k]) && o.deltas[k] >= 0)) return unknown;
  if (o.pressure !== 1) return { ...unknown, reason: 'macOS 内存压力非正常，保守单路' };
  if (Object.values(o.deltas).some(n => n > 0)) return { ...unknown, reason: 'macOS 采样期间有交换/换出活动，保守单路' };
  if (o.compressorBytes > o.totalBytes * .30 || o.swapUsedBytes > o.totalBytes * .20) {
    return { ...unknown, reason: 'macOS 压缩器或 swap 存量超过保守阈值，单路' };
  }
  if (!Number.isFinite(freeBytes) || freeBytes < 0 || fields.filter(k => k.endsWith('Bytes') && k !== 'totalBytes' && k !== 'swapUsedBytes').some(k => o[k] > o.totalBytes)) return unknown;
  const free = Math.min(freeBytes, o.freeBytes);
  const creditBytes = Math.min(o.fileBytes, o.inactiveBytes + o.speculativeBytes, o.totalBytes * .30) * .5;
  const capacity = bytes => Math.max(1, Math.floor(Math.max(0, bytes - 512 * MiB) * .65 / workerBytes));
  const freeOnly = capacity(free);
  // 缓存额度最多放宽到 2 路；充裕的真实空闲仍沿用原预算。显式 jobs 也受此限制。
  const memory = Math.max(freeOnly, Math.min(2, capacity(free + creditBytes)));
  return { memory, creditBytes, effectiveFreeBytes: free,
    reason: 'macOS 压力正常且短采样无交换；文件缓存折半计额，缓存放宽最多 2 路' };
}
