import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { dailyBuildCandidate, dispatchDailyBuild, startDailyBuildTicker } from '../lib/daily-build.mjs';
import { shouldBuild } from '../lib/timing-plan.mjs';
import { attachProject, readSchedule, writeSchedule } from '../lib/schedule.mjs';
import { startServer } from '../lib/server.mjs';

const at = (day, hour, minute, second = 0) => +new Date(2026, 10, day, hour, minute, second);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-daily-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = { items: [{ id: 'a', topic: '选题 A' }, { id: 'b', topic: '选题 B' }], build: { enabled: true, mode: 'daily', from: '09:00' } };
  writeSchedule(root, plan);
  return { root, plan };
}

test('定点制作：旧轮询不接管，当前分钟只启动一支，过时不补，下一天继续', t => {
  const { root, plan } = fixture(t);
  assert.equal(shouldBuild(plan, at(10, 9, 0)).reason, 'daily-mode');
  assert.equal(dailyBuildCandidate(root, at(10, 8, 59)), null);
  assert.equal(dailyBuildCandidate(root, at(10, 9, 1)), null);
  let now = at(10, 9, 0, 2);
  const calls = [], options = { clock: () => now, dispatch: item => {
    calls.push(item.id);
    assert.equal(dispatchDailyBuild(root, options).reason, 'not-due');
    attachProject(root, item.id, `projects/${item.id}`, now);
  } };
  assert.equal(dispatchDailyBuild(root, { ...options, dryRun: true }).reason, 'dry-run');
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
  assert.equal(dispatchDailyBuild(root, { ...options, isBusy: () => true }).reason, 'busy');
  assert.equal(dispatchDailyBuild(root, options).reason, 'dispatched');
  assert.equal(dispatchDailyBuild(root, options).reason, 'not-due');
  const queue = readSchedule(root); queue.build.from = '10:00'; writeSchedule(root, queue);
  now = at(10, 10, 0); assert.equal(dispatchDailyBuild(root, options).reason, 'not-due');
  now = at(11, 10, 0); assert.equal(dispatchDailyBuild(root, options).reason, 'dispatched');
  assert.deepEqual(calls, ['a', 'b']);
});

test('工作台定点计时器只派发制作器，自己不写队列或发布状态', t => {
  const { root } = fixture(t);
  let launches = 0;
  const stop = startDailyBuildTicker(root, { clock: () => at(10, 9, 0, 5), launch: () => { launches++; } });
  stop();
  assert.equal(launches, 1);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
  assert.equal(readSchedule(root).items[0].project, undefined);
});

test('真实制作设置 API 支持独立启停和切回时段模式，不创建发布状态', async t => {
  const { root } = fixture(t);
  const q = readSchedule(root); q.build.enabled = false; writeSchedule(root, q);
  const server = startServer(null, 0, { root, home: root, publish: {} });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/_api/schedule`;
  const set = async build => {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ action: 'timing', build }) });
    assert.equal(res.status, 200); return res.json();
  };
  const daily = await set({ enabled: false, mode: 'daily', from: '08:25' });
  assert.equal(daily.timing.dailyBuildSupported, true);
  assert.equal(daily.timing.build.mode, 'daily');
  assert.equal(daily.timing.build.from, '08:25');
  assert.equal(daily.items.length, 2);
  const window = await set({ enabled: false, mode: 'window' });
  assert.equal(window.timing.build.mode, undefined);
  assert.equal(fs.existsSync(path.join(root, 'out', '.publish-schedule')), false);
});
