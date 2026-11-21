import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMacMemoryObserver, parseMacMemory } from '../lib/macos-memory.mjs';
import { renderSettings } from '../lib/render-budget.mjs';

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const healthy = () => ({ status: 'known', sampleMs: 300, totalBytes: 16 * GiB, pressure: 1,
  freeBytes: 256 * MiB, fileBytes: 6 * GiB, inactiveBytes: 6 * GiB, speculativeBytes: 0,
  compressorBytes: 2 * GiB, swapUsedBytes: GiB, deltas: { swapins: 0, swapouts: 0, pageouts: 0 } });
const settings = (o, options = {}, extra = {}) => renderSettings(options,
  { platform: 'darwin', cpus: 16, freeMemory: o?.freeBytes ?? 16 * GiB, macMemory: o, ...extra });

test('健康缓存可有界放宽到2；显式jobs不能越过缓存/CPU/像素预算', () => {
  const o = healthy(), result = settings(o);
  assert.equal(result.jobs, 2);
  assert.equal(result.memoryPolicy.creditBytes, 2.4 * GiB);
  assert.equal(result.freeMemory, 256 * MiB);
  assert.equal(settings(o, { jobs: 32 }).jobs, 2);
  assert.equal(settings(o, { jobs: 1 }).jobs, 1);
  assert.equal(settings(o, {}, { cpus: 2 }).jobs, 1);
  assert.equal(settings(o, { width: 7680, height: 4320 }).jobs, 1);
  assert.deepEqual([result.fps, result.crf, result.preset], [30, 18, 'medium']);
  assert.equal(result.memoryPolicy.effectiveFreeBytes, 256 * MiB);
  assert.deepEqual([settings(o, { hq: true }).crf, settings(o, { hq: true }).preset], [17, 'slow']);
});

test('实际空闲充裕才可超过2；默认4，显式jobs仍有CPU与内存上限', () => {
  const o = { ...healthy(), freeBytes: 12 * GiB, fileBytes: 0, inactiveBytes: 0 };
  assert.equal(settings(o).jobs, 4);
  assert.equal(settings(o, { jobs: 32 }).jobs, 15);
  assert.equal(settings(o, { jobs: 8 }).jobs, 8);
  assert.equal(settings(o, {}, { freeMemory: 0 }).jobs, 1);
});

test('不将inactive/purgeable简单加总，也不把缓存估计当硬保证', () => {
  const o = { ...healthy(), fileBytes: 0, purgeableBytes: 10 * GiB };
  assert.equal(settings(o).jobs, 1);
  assert.equal(settings(o).memoryPolicy.creditBytes, 0);
  assert.equal(settings({ ...healthy(), inactiveBytes: 0 }).jobs, 1);
});

test('压力、交换活动、未知/无效采样即使显式jobs也单路', () => {
  const changes = [null, { status: 'unknown' }, { pressure: 2 }, { pressure: 4 }, { pressure: 0 },
    { sampleMs: 0 }, { sampleMs: 6000 }, { sampleMs: NaN }, { totalBytes: 0 }, { fileBytes: Infinity },
    { inactiveBytes: 20 * GiB }, { compressorBytes: 5 * GiB }, { swapUsedBytes: 4 * GiB },
    { deltas: null }, { deltas: { swapins: -1, swapouts: 0, pageouts: 0 } },
    ...['swapins', 'swapouts', 'pageouts'].map(k => ({ deltas: { ...healthy().deltas, [k]: 1 } }))];
  for (const change of changes) {
    const o = change === null ? null : { ...healthy(), freeBytes: 12 * GiB, ...change };
    assert.equal(settings(o, { jobs: 32 }).jobs, 1, JSON.stringify(change));
  }
  assert.equal(renderSettings({}, { cpus: 32, freeMemory: 32 * GiB }).jobs, 4, 'legacy injection never reads host');
  assert.equal(renderSettings({}, { platform: 'darwin', cpus: 32, freeMemory: 32 * GiB }).jobs, 1);
});

const vm = (swapins = 100) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 16384.
Pages inactive: 393216.
Pages speculative: 0.
File-backed pages: 393216.
Pages occupied by compressor: 131072.
Swapins: ${swapins}.
Swapouts: 200.
Pageouts: 300.
`;
const sys = `hw.memsize: 17179869184
kern.memorystatus_vm_pressure_level: 1
vm.swapusage: total = 2048.00M  used = 1024.00M  free = 1024.00M (encrypted)
`;

test('解析实际vm_stat/sysctl格式，缺字段或异常页大小拒绝', () => {
  assert.equal(parseMacMemory(vm(), sys).swapUsedBytes, GiB);
  assert.equal(parseMacMemory(vm().replace('16384 bytes', '4096 bytes'), sys).freeBytes, 64 * MiB);
  assert.throws(() => parseMacMemory(vm().replace('Swapins:', 'No:'), sys));
  assert.throws(() => parseMacMemory(vm(), sys.replace('kern.memorystatus_vm_pressure_level: 1', '')));
  assert.throws(() => parseMacMemory(vm().replace('16384 bytes', '0 bytes'), sys));
});

test('短采样计数差分，2秒缓存免spawn，过期刷新，不泄漏可变引用', () => {
  let clock = 0, calls = 0, swaps = 100;
  const observe = createMacMemoryObserver({ now: () => clock, sleep: ms => { clock += ms; },
    run: file => { calls++; return file.endsWith('vm_stat') ? vm(swaps++) : sys; } });
  const first = observe();
  assert.equal(calls, 4); assert.equal(first.sampleMs, 300);
  assert.equal(first.deltas.swapins, 1); assert.equal(settings(first).jobs, 1);
  first.deltas.swapins = 999;
  assert.equal(observe().deltas.swapins, 1); assert.equal(calls, 4);
  clock += 1999; observe(); assert.equal(calls, 4);
  clock += 1; observe(); assert.equal(calls, 8);
});

test('失败缓存亦保守，过期可恢复；计数回退/无采样时长不冒充空闲', () => {
  let clock = 0, fail = true;
  const observe = createMacMemoryObserver({ now: () => clock, sleep: ms => { clock += ms; },
    run: file => { if (fail) throw new Error('timeout'); return file.endsWith('vm_stat') ? vm() : sys; } });
  assert.equal(observe().status, 'unknown');
  fail = false; assert.equal(observe().status, 'unknown');
  clock += 2000; assert.equal(observe().status, 'known');
  assert.equal(settings(observe()).jobs, 2);
  let swaps = 100;
  const reset = createMacMemoryObserver({ now: () => clock, sleep: ms => { clock += ms; },
    run: file => file.endsWith('vm_stat') ? vm(swaps--) : sys });
  assert.equal(reset().status, 'unknown');
  const noTime = createMacMemoryObserver({ now: () => 0, sleep: () => {}, run: file => file.endsWith('vm_stat') ? vm() : sys });
  assert.equal(noTime().status, 'unknown');
});
