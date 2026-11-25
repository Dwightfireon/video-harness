import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutopilot, DEFAULT_AUTOPILOT_CONFIG } from '../lib/autopilot.mjs';

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
