import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSchedule, writeSchedule, addTopic, attachProject, removeItem, removeItems, firstUnstarted,
  deriveStatus, listWithStatus, dispatchedToday, slugify } from '../lib/schedule.mjs';
import { shouldBuild, shouldPublish, setPlans, describePlans, parseClock, withinWindow } from '../lib/timing-plan.mjs';

/* 队列只记「想做哪些」，执行状态从项目推导、不存副本。
 * 这些用例断言的就是这条边界：没有 claim / finish / reconcile。 */

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('加选题：去重、默认没有项目', t => {
  const root = tmp(t);
  const item = addTopic(root, '本地大模型为什么突然好用了');
  assert.equal(item.project, undefined);
  assert.throws(() => addTopic(root, '本地大模型为什么突然好用了'), /已有同一个选题/);
});

test('读旧文件：v1 的 status 字段被忽略，不参与判断', t => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'schedule.json'), JSON.stringify({
    version: 1, items: [
      { id: 'a', topic: '甲', status: 'running', startedAt: 1 },
      { id: 'b', topic: '乙', status: 'done', finishedAt: 2 },
    ],
  }));
  const queue = readSchedule(root);
  assert.equal(queue.items.length, 2);
  assert.equal(queue.items[0].status, undefined, '旧状态字段不再读入');
  assert.equal(queue.items[0].project, undefined);
});

test('开工只记项目，不写执行状态', t => {
  const root = tmp(t);
  const item = addTopic(root, '甲');
  const attached = attachProject(root, item.id, 'projects/甲');
  assert.equal(attached.project, 'projects/甲');
  assert.equal(attached.state, undefined, '队列项不保存派生状态');
  assert.ok(attached.dispatchedAt > 0);
});

test('同一项不能指向两个项目', t => {
  const root = tmp(t);
  const item = addTopic(root, '甲');
  attachProject(root, item.id, 'projects/甲');
  assert.throws(() => attachProject(root, item.id, 'projects/乙'), /另一个项目/);
});

test('状态从项目推导：没有项目=未开工，完成=完成，跑动=进行中', () => {
  assert.equal(deriveStatus({ id: 'a', topic: 't' }), 'todo');
  assert.equal(deriveStatus({ id: 'a', topic: 't', project: 'p' }, () => ({ status: 'completed', delivered: true })), 'done');
  assert.equal(deriveStatus({ project: 'p' }, () => ({ status: 'completed', delivered: false })), 'stopped');
  assert.equal(deriveStatus({ project: 'p' }, () => ({ status: 'completed' })), 'stopped');
  assert.equal(deriveStatus({ id: 'a', topic: 't', project: 'p' }, () => ({ status: 'running' })), 'running');
  assert.equal(deriveStatus({ id: 'a', topic: 't', project: 'p' }, () => ({ status: 'failed' })), 'failed');
});

test('状态推导：取消但成片齐了算完成，没齐算停住', () => {
  assert.equal(deriveStatus({ project: 'p' }, () => ({ status: 'cancelled', delivered: true })), 'done');
  assert.equal(deriveStatus({ project: 'p' }, () => ({ status: 'cancelled', delivered: false })), 'stopped');
  assert.equal(deriveStatus({ project: 'p' }, () => null), 'stopped', '项目不见了也不崩');
});

test('只有没开过工的项会被派发：跑过的不自动重来', t => {
  const root = tmp(t);
  const a = addTopic(root, '甲');
  addTopic(root, '乙');
  attachProject(root, a.id, 'projects/甲');
  const queue = readSchedule(root);
  assert.equal(firstUnstarted(queue).topic, '乙', '已开工的不再自动重派');
});

test('每日派发计数只看 dispatchedAt', t => {
  const now = new Date(2026, 10, 8, 12).getTime();
  const queue = { items: [
    { id: 'a', topic: 'a', dispatchedAt: new Date(2026, 10, 8, 9).getTime() },
    { id: 'b', topic: 'b', dispatchedAt: new Date(2026, 10, 7, 9).getTime() },
    { id: 'c', topic: 'c' },
  ] };
  assert.equal(dispatchedToday(queue, now), 1);
});

test('移除：只删队列记录，不问项目', t => {
  const root = tmp(t);
  const item = addTopic(root, '甲');
  assert.equal(removeItem(root, item.id).removed, 1);
  assert.equal(readSchedule(root).items.length, 0);
  assert.equal(removeItem(root, '不存在'), null);
});

test('批量移除：只写一次盘，正在制作的项跳过并说明原因', t => {
  const root = tmp(t);
  const a = addTopic(root, '甲'), b = addTopic(root, '乙'), c = addTopic(root, '丙');
  attachProject(root, b.id, 'projects/乙');
  const result = removeItems(root, [a.id, b.id, c.id], {
    skip: item => item.id === b.id ? '正在制作，先停止再移除' : null,
  });
  assert.equal(result.removed, 2);
  assert.deepEqual(result.ids.sort(), [a.id, c.id].sort());
  assert.deepEqual(result.skipped, [{ id: b.id, topic: '乙', reason: '正在制作，先停止再移除' }]);
  assert.deepEqual(readSchedule(root).items.map(item => item.id), [b.id], '被跳过的项及其项目指向必须原样保留');

  assert.throws(() => removeItems(root, []), /没有选中/);
  assert.throws(() => removeItems(root, 'nope'), /没有选中/);
  assert.equal(removeItems(root, ['不存在'], {}).removed, 0, '全部不存在时不动盘');
  assert.deepEqual(readSchedule(root).items.map(item => item.id), [b.id]);
});

test('批量移除：skip 抛错时不删该项，不把异常当成可以删', t => {
  const root = tmp(t);
  const a = addTopic(root, '甲'), b = addTopic(root, '乙');
  const result = removeItems(root, [a.id, b.id], { skip: () => { throw new Error('probe failed'); } });
  assert.equal(result.removed, 0);
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(readSchedule(root).items.map(item => item.id), [a.id, b.id]);
});

test('批量移除接口：真实 HTTP 一次删多项，制作中的项原样保留并说明原因', async t => {
  const { once } = await import('node:events');
  const { startServer } = await import('../lib/server.mjs');
  const { beginTask, updateTask } = await import('../lib/task-status.mjs');
  const root = tmp(t), home = path.join(root, 'home');
  fs.mkdirSync(home);
  const idle = path.join(root, 'projects/idle');
  const busy = path.join(root, 'projects/busy');
  for (const dir of [idle, busy]) {
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  }
  const a = addTopic(root, '甲'), b = addTopic(root, '乙'), c = addTopic(root, '丙');
  attachProject(root, b.id, 'projects/busy');
  const task = beginTask(busy, '正在制作', 'article');
  updateTask(busy, task.id, { status: 'running', pid: process.pid }, task.attemptId);

  const server = startServer(idle, 0, { root, home, providerInfo: () => [] });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = body => fetch(url + '/_api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const empty = await post({ action: 'remove-many', ids: [] });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /没有选中/);

  const response = await post({ action: 'remove-many', ids: [a.id, b.id, c.id] });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.removed, 2);
  assert.deepEqual(json.items.map(item => item.id), [b.id], '正在制作的项仍在队列里');
  assert.equal(json.items[0].state, 'running');
  assert.match(json.skipped[0].reason, /正在制作/);
  assert.deepEqual(readSchedule(root).items.map(item => item.id), [b.id]);

  const unknown = await post({ action: 'remove-many', ids: ['不存在'] });
  assert.equal(unknown.status, 400);
  assert.equal(readSchedule(root).items.length, 1, '找不到的 id 不改动队列');
});

test('listWithStatus 给界面用：带 state，但不写盘', t => {
  const root = tmp(t);
  const item = addTopic(root, '甲');
  attachProject(root, item.id, 'p');
  const view = listWithStatus(root, () => ({ status: 'completed', delivered: true }));
  assert.equal(view.items[0].state, 'done');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));
  assert.equal(onDisk.items[0].state, undefined);
});

/* ---------- 定时 ---------- */

const at = (h, m = 0) => new Date(2026, 10, 8, h, m, 0).getTime();

test('两个开关默认都关，且互不影响', () => {
  assert.equal(shouldBuild({ items: [] }, at(10)).reason, 'disabled');
  assert.equal(shouldPublish({ items: [] }, [], at(21)).reason, 'disabled');
  const buildOn = { build: { enabled: true, from: '00:00', to: '00:00' }, items: [{ id: 'a', topic: 't' }] };
  assert.equal(shouldBuild(buildOn, at(10)).ok, true);
  assert.equal(shouldPublish(buildOn, [{ id: 'a' }], at(10)).reason, 'disabled', '开生成不影响发布');
});

test('生成：时段、上限、间隔、空队列', () => {
  const base = { build: { enabled: true, from: '09:00', to: '11:00', dailyLimit: 2, minGapMinutes: 60 }, items: [{ id: 'a', topic: 't' }] };
  assert.equal(shouldBuild(base, at(10)).ok, true);
  assert.equal(shouldBuild(base, at(14)).reason, 'outside-window');
  assert.equal(shouldBuild(base, at(14), { dispatchedToday: 2 }).reason, 'outside-window', '先判时段');
  assert.equal(shouldBuild({ ...base, build: { ...base.build, from: '00:00', to: '00:00' } }, at(14), { dispatchedToday: 2 }).reason, 'daily-limit');
  assert.equal(shouldBuild({ ...base, build: { ...base.build, from: '00:00', to: '00:00' } }, at(14), { anyRunning: true }).reason, 'running');
  assert.equal(shouldBuild({ build: base.build, items: [] }, at(10)).reason, 'empty');
});

test('生成：距上次派发不足最小间隔时等一等', () => {
  const queue = { build: { enabled: true, from: '00:00', to: '00:00', minGapMinutes: 120 },
    items: [{ id: 'a', topic: 'a', dispatchedAt: at(9, 30) }, { id: 'b', topic: 'b' }] };
  const result = shouldBuild(queue, at(10));
  assert.equal(result.reason, 'gap');
  assert.match(result.message, /分钟/);
});

test('时段：跨午夜、同一时刻=全天、非法值不通过', () => {
  assert.equal(withinWindow(at(23), '22:00', '02:00'), true);
  assert.equal(withinWindow(at(12), '22:00', '02:00'), false);
  assert.equal(withinWindow(at(3), '00:00', '00:00'), true);
  assert.equal(parseClock('24:00'), null);
  assert.equal(withinWindow(at(10), '25:00', '26:00'), false);
});

test('保存只改定时字段，队列内容不动', t => {
  const root = tmp(t);
  addTopic(root, '甲');
  setPlans(root, { build: { enabled: true, from: '20:00' } });
  const data = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));
  assert.equal(data.build.enabled, true);
  assert.equal(data.build.from, '20:00');
  assert.equal(data.publish.enabled, false);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].topic, '甲');
});

test('界面文案只说明现在会不会发生', () => {
  assert.match(describePlans({ items: [] }, at(21)).build.state, /关/);
  assert.match(describePlans({ build: { enabled: true, from: '20:00', to: '23:00' }, items: [] }, at(21)).build.state, /时段内/);
});

test('项目名可直接当目录名', () => {
  assert.equal(slugify('本地大模型为什么突然好用了'), '本地大模型为什么突然好用了');
  assert.equal(slugify('https://x.test/a 带链接 --mode 参数'), '带链接---mode-参数');
  assert.equal(slugify('   '), 'auto');
});
