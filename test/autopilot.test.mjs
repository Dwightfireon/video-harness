import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutopilot, DEFAULT_AUTOPILOT_CONFIG } from '../lib/autopilot.mjs';
import { createPublishScheduler } from '../lib/publish-scheduler.mjs';
import { stripProjectCaches } from '../lib/disk-hygiene.mjs';

function makeHarness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-autopilot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1_700_000_000_000;
  const queue = { items: [] };
  const statuses = new Map();
  let publish = { enabled: true, pauseReason: '', trigger: { kind: 'ready', intervalSeconds: 300 }, scope: { kind: 'production-queue' }, partition: { label: '人工智能（1011）' } };
  const started = [];
  const discovered = [];
  let syncedInterval = null;

  const autopilot = createAutopilot({
    root,
    clock: () => now,
    intervalMs: 60_000,
    readQueue: () => queue,
    isBusy: q => q.items.some(it => it.project && ['starting', 'running', 'cancelling'].includes(statuses.get(it.project)?.status)),
    inspectProject: async rel => statuses.get(rel) || null,
    acquireLock: () => ({ release() {} }),
    startItem: async item => {
      const rel = `projects/p-${started.length + 1}`;
      item.project = rel;
      statuses.set(rel, { status: 'running', delivered: false });
      started.push({ id: item.id, topic: item.topic, rel });
      return { status: 200, body: { ok: true, started: true, rel } };
    },
    discoverAndQueue: async cfg => {
      discovered.push(cfg);
      const item = { id: `auto-${discovered.length}`, topic: `AI 选题 ${discovered.length}` };
      queue.items.push(item);
      return { ok: true, results: [item], added: [item] };
    },
    getPublishSchedule: async () => publish,
    syncPublishSchedule: async sec => { syncedInterval = sec; return { synced: true }; },
    ...overrides,
  });
  t.after(() => autopilot.close());
  return {
    root, queue, statuses, started, discovered, autopilot,
    advance: ms => { now += ms; },
    setPublish: next => { publish = next; },
    getSyncedInterval: () => syncedInterval,
  };
}

test('全自动巡航：空队列自动补题入队 → 启动制作 → 成片后严格冷却 5 分钟再接下一支', async t => {
  const h = makeHarness(t);
  await h.autopilot.start({ query: 'AI、LLM、Agent、机器学习', buildGapMinutes: 5, publishIntervalSeconds: 300 });
  assert.equal(h.getSyncedInterval(), 300);

  // 等待异步补题 Promise 落地并触发下一次 tick
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.discovered.length, 1);
  assert.equal(h.discovered[0].mode, DEFAULT_AUTOPILOT_CONFIG.mode);
  assert.equal(h.started.length, 1);
  assert.equal(h.autopilot.snapshot().phase, 'building');

  // 第 1 支交付完成，并预先放第 2 支到队列
  h.queue.items.push({ id: 'q2', topic: 'Agent 记忆机制' });
  h.statuses.set('projects/p-1', { status: 'completed', delivered: true });
  const afterFinish = await h.autopilot.tick();
  assert.equal(afterFinish.completed, 1);
  assert.equal(afterFinish.phase, 'cooldown');
  assert.equal(h.started.length, 1, '冷却未满 5 分钟不得启动下一支');

  // 推进 4 分钟：仍在冷却
  h.advance(4 * 60_000);
  await h.autopilot.tick();
  assert.equal(h.started.length, 1);

  // 再推进 1 分钟（满 5 分钟）：自动启动第 2 支
  h.advance(60_000);
  const next = await h.autopilot.tick();
  assert.equal(h.started.length, 2);
  assert.equal(next.currentTopic, 'Agent 记忆机制');
  assert.equal(next.phase, 'building');
});

test('全自动巡航：制作失败或自动投稿触发限流暂停时立刻熔断', async t => {
  const h = makeHarness(t);
  h.queue.items.push({ id: 'q1', topic: '大模型推理优化' });
  await h.autopilot.start();
  assert.equal(h.started.length, 1);

  // 模拟 B 站限流导致自动投稿暂停
  h.setPublish({ enabled: false, pauseReason: 'HTTP 406 您上传视频过快' });
  const paused = await h.autopilot.tick();
  assert.equal(paused.active, false);
  assert.equal(paused.phase, 'paused');
  assert.match(paused.pausedReason, /406/);
});

test('全自动巡航：制作失败立即停止，绝不盲目继续下一支', async t => {
  const h = makeHarness(t);
  h.queue.items.push({ id: 'q1', topic: '题目 1' }, { id: 'q2', topic: '题目 2' });
  await h.autopilot.start({ buildGapMinutes: 0 });
  assert.equal(h.started.length, 1);

  h.statuses.set('projects/p-1', { status: 'failed', delivered: false });
  const stopped = await h.autopilot.tick();
  assert.equal(stopped.active, false);
  assert.match(stopped.pausedReason, /制作失败/);
  assert.equal(h.started.length, 1);
});

test('全自动巡航：配置持久化保存，且默认参数符合用户约定', t => {
  const h = makeHarness(t);
  assert.equal(DEFAULT_AUTOPILOT_CONFIG.query, 'AI、LLM、Agent、机器学习');
  assert.equal(DEFAULT_AUTOPILOT_CONFIG.mode, 'focused');
  assert.equal(DEFAULT_AUTOPILOT_CONFIG.buildGapMinutes, 5);
  assert.equal(DEFAULT_AUTOPILOT_CONFIG.publishIntervalSeconds, 300);

  const saved = h.autopilot.saveConfig({ query: 'LLM Agent', buildGapMinutes: 8, publishIntervalSeconds: 420 });
  assert.equal(saved.config.query, 'LLM Agent');
  assert.equal(saved.config.buildGapMinutes, 8);
  assert.equal(saved.config.publishIntervalSeconds, 420);
  assert.equal(fs.existsSync(path.join(h.root, 'out', '.autopilot.json')), true);
});

test('全自动巡航：自动调查失败未入队时透出具体失败原因与建议，不笼统吞错', async t => {
  const h = makeHarness(t, {
    maxDiscoveryFailures: 1,
    discoverAndQueue: async () => ({
      ok: true,
      results: [{ id: 'c1', topic: '示例问题' }],
      added: [],
      researchFailures: [{ topicId: 'c1', topic: '示例问题', reason: '搜索服务限流：websearch 返回 HTTP 429' }],
      hints: ['稍等几分钟再试，搜索服务当前限流'],
    }),
  });
  await h.autopilot.start();
  await new Promise(r => setTimeout(r, 20));
  const snap = h.autopilot.snapshot();
  assert.equal(snap.active, false);
  assert.equal(snap.phase, 'paused');
  assert.match(snap.pausedReason, /HTTP 429/);
  assert.match(snap.pausedReason, /稍等几分钟再试/);
});

test('全自动巡航：优先消化旧候选但全部调查失败时，提示文案明确指向已有候选', async t => {
  const h = makeHarness(t, {
    maxDiscoveryFailures: 1,
    discoverAndQueue: async () => ({
      ok: true,
      reusedExisting: true,
      results: [],
      added: [],
      researchFailures: [{ topicId: 'old-1', topic: '旧候选题目', reason: '所有站点均返回 403' }],
      hints: ['优先换官方公告、论文或原始数据这类不需要登录的来源'],
    }),
  });
  await h.autopilot.start();
  await new Promise(r => setTimeout(r, 20));
  const snap = h.autopilot.snapshot();
  assert.equal(snap.active, false);
  assert.equal(snap.phase, 'paused');
  assert.match(snap.pausedReason, /本轮优先调查已有候选选题，但均未入队/);
  assert.match(snap.pausedReason, /403/);
});

test('全自动巡航：选题遇到 403 等软失败时冷却后自动换一批重找；连续多次失败或额度硬故障才熔断', async t => {
  let round = 0;
  const h = makeHarness(t, {
    maxDiscoveryFailures: 3,
    discoveryRetryDelayMs: 60_000,
    discoverAndQueue: async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          added: [],
          researchFailures: [{ topicId: 'c1', topic: '被拦截题', reason: '已经累计 8 次读不到原文' }],
          hints: ['优先换官方公告、论文或原始数据'],
        };
      }
      const item = { id: `auto-${round}`, topic: `补位成功选题 ${round}` };
      h.queue.items.push(item);
      return { ok: true, results: [item], added: [item] };
    },
  });

  await h.autopilot.start({ buildGapMinutes: 0 });
  await new Promise(r => setTimeout(r, 20));
  const cooling = h.autopilot.snapshot();
  assert.equal(cooling.active, true, '单轮 403 不应直接暂停巡航');
  assert.equal(cooling.phase, 'retrying');
  assert.equal(cooling.discoveryFailures, 1);
  assert.match(cooling.lastWarning, /60 秒后自动换一批重找（第 1\/3 次）/);

  // 冷却未到不重复触发
  h.advance(30_000);
  await h.autopilot.tick();
  assert.equal(round, 1);

  // 冷却到期后自动重试并入队开工
  h.advance(30_000);
  await h.autopilot.tick();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(round, 2);
  assert.equal(h.started.length, 1);
  assert.equal(h.autopilot.snapshot().discoveryFailures, 0);
  assert.equal(h.autopilot.snapshot().phase, 'building');

  // 硬故障（websearch 402 无额度）立即熔断，不盲目重试
  const hHard = makeHarness(t, {
    maxDiscoveryFailures: 3,
    discoveryRetryDelayMs: 60_000,
    discoverAndQueue: async () => ({
      ok: true,
      hardSearchFailure: true,
      added: [],
      researchFailures: [{ topicId: 'c2', topic: '无额度题', reason: '搜索服务没有额度或未授权：websearch 返回 HTTP 402' }],
    }),
  });
  await hHard.autopilot.start();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(hHard.autopilot.snapshot().active, false);
  assert.equal(hHard.autopilot.snapshot().phase, 'paused');
  assert.match(hHard.autopilot.snapshot().pausedReason, /HTTP 402/);
});

test('全自动巡航：遇到已有检索占用锁时不计失败且 15 秒后重检；队列有存货时边制作边后台补题', async t => {
  let calls = 0;
  const h = makeHarness(t, {
    maxDiscoveryFailures: 2,
    discoveryRetryDelayMs: 45_000,
    discoveryBusyDelayMs: 15_000,
    discoverAndQueue: async () => {
      calls += 1;
      if (calls <= 3) {
        return { ok: false, busy: true, reason: '已有选题检索在运行，请稍后再试', added: [] };
      }
      const item = { id: `auto-${calls}`, topic: `补位选题 ${calls}` };
      h.queue.items.push(item);
      return { ok: true, results: [item], added: [item] };
    },
  });

  await h.autopilot.start({ minQueueSize: 2, buildGapMinutes: 0 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.equal(h.autopilot.snapshot().active, true);
  assert.equal(h.autopilot.snapshot().discoveryFailures, 0, '锁占用不应计入失败次数');

  // 连续 3 次锁占用都不应触发 2 次失败熔断
  for (let i = 2; i <= 3; i++) {
    h.advance(15_000);
    await h.autopilot.tick();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(calls, i);
    assert.equal(h.autopilot.snapshot().active, true);
    assert.equal(h.autopilot.snapshot().discoveryFailures, 0);
  }

  // 即使 minQueueSize=2，只要队列里出现了 1 条待做选题，立刻开始制作，不干等第 2 条
  h.queue.items.push({ id: 'q-ready', topic: '先开工的存货' });
  h.advance(15_000);
  await h.autopilot.tick();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.started.length, 1);
  assert.equal(h.started[0].topic, '先开工的存货');
});

test('全自动巡航：上次投稿中断未闭合时在解除阻断后自动恢复排程联动并清除报错，且不误触熔断', async t => {
  let syncCalls = 0;
  let scheduleState = {
    revision: 5,
    enabled: true,
    attemptActive: false,
    pauseReason: '',
    trigger: { kind: 'ready', intervalSeconds: 480 },
    scope: { kind: 'production-queue' },
    partition: { tid: 21, label: '人工智能（1011）' },
    lastAttempt: { state: 'running', id: '公交免费以后马路上真的会少车吗', at: 1_699_999_900_000 },
  };
  const h = makeHarness(t, {
    getPublishSchedule: async () => scheduleState,
    syncPublishSchedule: async intervalSeconds => {
      syncCalls += 1;
      if (scheduleState.lastAttempt?.state === 'running') {
        return {
          synced: false,
          interruptedAttempt: { id: scheduleState.lastAttempt.id, revision: scheduleState.revision },
          notice: '自动投稿未自动联动：上次自动投稿因服务中断未完整闭合记录。',
        };
      }
      scheduleState = {
        ...scheduleState,
        enabled: true,
        trigger: { kind: 'ready', intervalSeconds },
      };
      return { synced: true };
    },
  });
  h.queue.items.push({ id: 'q1', topic: '新选题' });

  // 启动并修改投稿间隔为 300s，因遗留 running 暂未同步
  const started = await h.autopilot.start({ publishIntervalSeconds: 300 });
  assert.equal(started.active, true);
  assert.match(started.publishNotice, /未完整闭合记录/);
  assert.equal(syncCalls, 1);

  // 场景 A：人工核对为“未收稿”（outcome=interrupted, enabled=false）时，tick 自动补同步且不误判为投稿失败熔断
  scheduleState = {
    ...scheduleState,
    enabled: false,
    lastAttempt: {
      state: 'failed',
      outcome: 'interrupted',
      id: '公交免费以后马路上真的会少车吗',
      at: 1_699_999_900_000,
      finishedAt: 1_700_000_010_000,
    },
  };
  const healed = await h.autopilot.tick();
  assert.equal(healed.active, true);
  assert.equal(healed.publishNotice, null);
  assert.equal(healed.publish.enabled, true);
  assert.equal(healed.publish.intervalSeconds, 300);

  // 场景 B：巡航运行中正在真实上传时修改投稿间隔，挂起等待上传结束后自动同步
  scheduleState = {
    ...scheduleState,
    attemptActive: true,
    lastAttempt: { state: 'running', id: '正在上传的作品', at: 1_700_000_020_000 },
  };
  const pending = await h.autopilot.updateConfig({ publishIntervalSeconds: 600 });
  assert.equal(pending.config.publishIntervalSeconds, 600);
  // 模拟当前上传正常结束
  scheduleState = {
    ...scheduleState,
    attemptActive: false,
    lastAttempt: { state: 'submitted', outcome: 'submitted', id: '正在上传的作品', finishedAt: 1_700_000_030_000 },
  };
  await h.autopilot.syncPublish();
  assert.equal(h.autopilot.snapshot().publishNotice, null);
  assert.equal(h.autopilot.snapshot().publish.intervalSeconds, 600);
});

test('全自动巡航：偶发模型/网关报错自动冷却续跑；单支仍失败时跳过继续，连续两支失败才熔断', async t => {
  const resumed = [];
  const h = makeHarness(t, {
    maxProjectRetries: 1,
    retryDelayMs: 30_000,
    maxConsecutiveFailures: 2,
    resumeItem: async rel => {
      resumed.push(rel);
      h.statuses.set(rel, { status: 'running', delivered: false });
      return { status: 200, body: { ok: true, started: true, rel } };
    },
  });
  h.queue.items.push({ id: 'q1', topic: '海底热泉' }, { id: 'q2', topic: '南极冰架' });
  await h.autopilot.start({ buildGapMinutes: 0 });
  assert.equal(h.started.length, 1);

  // 第 1 支遇上游 400 失败 → 进入 retrying 冷却，不立即停航
  h.statuses.set('projects/p-1', { status: 'failed', delivered: false, canResume: true, errorKind: 'execution', errorMessage: 'Upstream request failed: [400]' });
  const waiting = await h.autopilot.tick();
  assert.equal(waiting.active, true);
  assert.equal(waiting.phase, 'retrying');
  assert.match(waiting.lastWarning, /30 秒后自动续跑/);
  assert.equal(resumed.length, 0);

  // 推进 30 秒 → 自动续跑第 1 支
  h.advance(30_000);
  const retried = await h.autopilot.tick();
  assert.equal(retried.active, true);
  assert.equal(retried.phase, 'building');
  assert.deepEqual(resumed, ['projects/p-1']);

  // 续跑后仍失败 → 单支异常跳过并自动启动第 2 支，不打断整晚巡航
  h.statuses.set('projects/p-1', { status: 'failed', delivered: false, canResume: true, errorKind: 'execution', errorMessage: 'Upstream request failed: [400]' });
  const skipped = await h.autopilot.tick();
  assert.equal(skipped.active, true);
  assert.equal(skipped.skipped, 1);
  assert.equal(h.started.length, 2);
  assert.equal(skipped.currentTopic, '南极冰架');

  // 第 2 支若遇配额不足（不可重试）→ 立即熔断并透出具体原因
  h.statuses.set('projects/p-2', { status: 'failed', delivered: false, canResume: true, errorKind: 'quota', errorMessage: '模型渠道额度不足' });
  const stopped = await h.autopilot.tick();
  assert.equal(stopped.active, false);
  assert.equal(stopped.phase, 'paused');
  assert.match(stopped.pausedReason, /模型渠道额度不足/);
});

test('全自动巡航：视频发布成功后自动清理缓存并统计释放体积；关闭开关或清理报错不阻断巡航', async t => {
  const pruned = [];
  const errors = [];
  const h = makeHarness(t, {
    pruneProject: async id => {
      pruned.push(id);
      return { ok: true, freed: 2_500_000_000, removed: ['out/frames', 'out/seg', 'out/.voice-kokoro'] };
    },
    onError: err => errors.push(err),
  });

  assert.equal(DEFAULT_AUTOPILOT_CONFIG.autoPrune, true);
  h.queue.items.push({ id: 'q1', topic: '缓存清理测试' }, { id: 'q2', topic: '停航前最后一支' });
  await h.autopilot.start({ buildGapMinutes: 0 });
  assert.equal(h.started.length, 1);

  // 第 1 支制作完成，队列里第 2 支随即启动，此时第 1 支尚未发布不清理缓存
  h.statuses.set('projects/p-1', { status: 'completed', delivered: true });
  await h.autopilot.tick();
  assert.equal(h.started.length, 2);
  assert.equal(pruned.length, 0, '尚未发布前不清理缓存');

  // 模拟发布台确认第 1 支收稿
  h.advance(10_000);
  h.setPublish({
    enabled: true,
    pauseReason: '',
    trigger: { kind: 'ready', intervalSeconds: 300 },
    scope: { kind: 'production-queue' },
    partition: { label: '人工智能（1011）' },
    lastAttempt: {
      state: 'submitted',
      outcome: 'submitted',
      id: 'p-1',
      bvid: 'BV1xx411c7mD',
      finishedAt: 1_700_000_010_000,
    },
  });
  const afterPub = await h.autopilot.tick();
  assert.deepEqual(pruned, ['p-1']);
  assert.equal(afterPub.prunedCount, 1);
  assert.equal(afterPub.prunedBytes, 2_500_000_000);
  assert.equal(afterPub.lastPruned.id, 'p-1');

  // 再次 tick 不会对同一次投稿重复清理
  await h.autopilot.tick();
  assert.deepEqual(pruned, ['p-1']);

  // 第 2 支制作完成并手动停止巡航后，若第 2 支随后完成投稿，仍自动清理；无关项目不清理
  h.statuses.set('projects/p-2', { status: 'completed', delivered: true });
  await h.autopilot.tick();
  h.autopilot.stop({ reason: null });

  await h.autopilot.onProjectPublished({ id: 'unrelated-project', finishedAt: 1_700_000_020_000 });
  assert.deepEqual(pruned, ['p-1'], '巡航已停止且非本轮跟踪项目不应自动清缓存');

  await h.autopilot.onProjectPublished({ id: 'p-2', finishedAt: 1_700_000_030_000 });
  assert.deepEqual(pruned, ['p-1', 'p-2'], '本轮已生成项目在停航后完成发布仍应自动清缓存');

  // 关闭 autoPrune 时不清理
  h.autopilot.saveConfig({ autoPrune: false });
  await h.autopilot.start({ buildGapMinutes: 0, autoPrune: false });
  await h.autopilot.onProjectPublished({ id: 'p-3', finishedAt: 1_700_000_040_000 });
  assert.deepEqual(pruned, ['p-1', 'p-2']);

  // 清理抛出异常时绝不熔断停止巡航
  const hErr = makeHarness(t, {
    pruneProject: async () => { throw new Error('模拟磁盘忙'); },
    onError: err => errors.push(err),
  });
  hErr.queue.items.push({ id: 'q1', topic: '容错测试' });
  await hErr.autopilot.start({ buildGapMinutes: 0 });
  hErr.setPublish({
    enabled: true,
    pauseReason: '',
    trigger: { kind: 'ready', intervalSeconds: 300 },
    scope: { kind: 'production-queue' },
    partition: { label: '人工智能（1011）' },
    lastAttempt: { state: 'submitted', outcome: 'submitted', id: 'p-1', finishedAt: 1_700_000_050_000 },
  });
  const stillActive = await hErr.autopilot.tick();
  assert.equal(stillActive.active, true, '清缓存失败不应熔断停止巡航');
  assert.ok(errors.some(e => /模拟磁盘忙/.test(e.message)));
});

test('发布排程 onSubmitted 联动巡航：收稿落盘后自动清掉 out/frames 等缓存并保留成片与文稿', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ap-prune-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projDir = path.join(root, 'projects', 'demo-video');
  fs.mkdirSync(path.join(projDir, 'out', 'frames'), { recursive: true });
  fs.mkdirSync(path.join(projDir, 'out', 'seg'), { recursive: true });
  fs.mkdirSync(path.join(projDir, 'out', '.voice-kokoro'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(projDir, '脚本.md'), '# 脚本');
  fs.writeFileSync(path.join(projDir, '发布文案.md'), '# 发布文案');
  fs.writeFileSync(path.join(projDir, 'out', 'video-voice.mp4'), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(projDir, 'out', 'frames', '000001.jpg'), Buffer.alloc(4096, 2));
  fs.writeFileSync(path.join(projDir, 'out', 'seg', 'seg-001.mp4'), Buffer.alloc(2048, 3));
  fs.writeFileSync(path.join(projDir, 'out', '.voice-kokoro', '001.wav'), Buffer.alloc(1024, 4));

  let now = 1_700_000_000_000;
  const autopilot = createAutopilot({
    root,
    clock: () => now,
    intervalMs: 60_000,
    readQueue: () => ({ items: [{ id: 'q1', topic: '测试', project: 'projects/demo-video' }] }),
    isBusy: () => false,
    inspectProject: async () => ({ status: 'completed', delivered: true }),
    acquireLock: () => ({ release() {} }),
    startItem: async () => ({ status: 200, body: { ok: true, started: true, rel: 'projects/demo-video' } }),
    discoverAndQueue: async () => ({ ok: true, added: [] }),
    pruneProject: async id => {
      const cleaned = stripProjectCaches(path.join(root, 'projects', id), { keepSeg: false });
      return { ok: true, freed: cleaned.freed, removed: cleaned.removed };
    },
  });
  t.after(() => autopilot.close());
  await autopilot.start({ minQueueSize: 1 });

  const scheduler = createPublishScheduler({
    root,
    clock: () => now,
    accountKey: () => 'acc-1',
    listScopeIds: () => ['demo-video'],
    getCandidate: async id => ({ id }),
    submitOne: async () => ({ ok: true, outcome: 'submitted', bvid: 'BV1test123456' }),
    onSubmitted: info => autopilot.onProjectPublished(info),
  });
  scheduler.save({
    revision: 0,
    action: 'enable',
    confirmed: true,
    trigger: { kind: 'ready', intervalSeconds: 300 },
    scope: { kind: 'production-queue' },
    partition: { tid: 231, label: '科技' },
  });

  const tickRes = await scheduler.tick();
  assert.equal(tickRes.reason, 'submitted');
  assert.equal(fs.existsSync(path.join(projDir, 'out', 'frames')), false, 'out/frames 应已清理');
  assert.equal(fs.existsSync(path.join(projDir, 'out', 'seg')), false, 'out/seg 应已清理');
  assert.equal(fs.existsSync(path.join(projDir, 'out', '.voice-kokoro')), false, 'out/.voice-* 应已清理');
  assert.equal(fs.existsSync(path.join(projDir, 'out', 'video-voice.mp4')), true, '成片必须保留');
  assert.equal(fs.existsSync(path.join(projDir, '脚本.md')), true, '脚本必须保留');
  assert.equal(fs.existsSync(path.join(projDir, '发布文案.md')), true, '发布文案必须保留');
  assert.equal(autopilot.snapshot().prunedCount, 1);
  assert.equal(autopilot.snapshot().prunedBytes, 4096 + 2048 + 1024);
});
