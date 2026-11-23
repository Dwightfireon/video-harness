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
