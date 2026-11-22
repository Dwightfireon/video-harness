import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueueRunner } from '../lib/queue-runner.mjs';
import { addTopic, attachProject, moveItem, readSchedule } from '../lib/schedule.mjs';

function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-qrunner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = new Map(); // rel -> { status, delivered }
  const started = [];
  let lockBusy = false;
  let startResponse = null;

  const runner = createQueueRunner({
    root,
    readQueue: readSchedule,
    isBusy: queue => queue.items.some(item => item.project && ['starting', 'running', 'cancelling'].includes(projects.get(item.project)?.status)),
    inspectProject: async rel => projects.get(rel) || null,
    acquireLock: () => {
      if (lockBusy) throw Object.assign(new Error('busy'), { code: 'PRODUCTION_LOCK_BUSY' });
      return { release() {} };
    },
    startItem: async item => {
      started.push(item.id);
      if (startResponse) return startResponse(item);
      const rel = `projects/${item.id}`;
      attachProject(root, item.id, rel);
      projects.set(rel, { status: 'running', delivered: false });
      return { status: 200, body: { ok: true, rel, started: true } };
    },
    intervalMs: 60000,
  });
  t.after(() => runner.close());

  return {
    root, runner, projects, started,
    setLockBusy: v => { lockBusy = v; },
    setStartResponse: fn => { startResponse = fn; },
  };
}

test('按顺序连续制作多条待做项，运行中可动态追加，全部完成后自动停止', async t => {
  const { root, runner, projects, started } = makeEnv(t);
  const a = addTopic(root, '第一支视频');
  const b = addTopic(root, '第二支视频');

  const s1 = await runner.start();
  assert.equal(s1.active, true);
  assert.equal(s1.currentProject, `projects/${a.id}`);
  assert.equal(s1.remaining, 1);
  assert.deepEqual(started, [a.id]);

  // 第一支还在跑，中途追加第三支
  const c = addTopic(root, '第三支视频');
  const during = await runner.tick();
  assert.equal(during.active, true);
  assert.equal(during.remaining, 2);
  assert.deepEqual(started, [a.id]);

  // 第一支成片交付 → 自动拉起第二支
  projects.set(`projects/${a.id}`, { status: 'completed', delivered: true });
  const s2 = await runner.tick();
  assert.equal(s2.active, true);
  assert.equal(s2.completed, 1);
  assert.equal(s2.currentProject, `projects/${b.id}`);
  assert.deepEqual(started, [a.id, b.id]);

  // 第二支成片交付 → 自动拉起中途追加的第三支
  projects.set(`projects/${b.id}`, { status: 'completed', delivered: true });
  const s3 = await runner.tick();
  assert.equal(s3.active, true);
  assert.equal(s3.completed, 2);
  assert.equal(s3.currentProject, `projects/${c.id}`);
  assert.deepEqual(started, [a.id, b.id, c.id]);

  // 第三支成片交付 → 队列已空，自动结束续跑
  projects.set(`projects/${c.id}`, { status: 'completed', delivered: true });
  const done = await runner.tick();
  assert.equal(done.active, false);
  assert.equal(done.completed, 3);
  assert.equal(done.pausedReason, null);
});

test('支持仅连跑勾选的子集，并在已有视频制作中时等其完成后自动衔接', async t => {
  const { root, runner, projects, started } = makeEnv(t);
  const running = addTopic(root, '正在做的视频');
  attachProject(root, running.id, 'projects/existing');
  projects.set('projects/existing', { status: 'running', delivered: false });
  const skip = addTopic(root, '不选的视频');
  const pick = addTopic(root, '勾选的视频');

  const s1 = await runner.start({ ids: [pick.id] });
  assert.equal(s1.active, true);
  assert.equal(s1.currentProject, 'projects/existing');
  assert.deepEqual(started, []);

  // 正在做的完成 → 只启动勾选的 pick，跳过 skip
  projects.set('projects/existing', { status: 'completed', delivered: true });
  const s2 = await runner.tick();
  assert.equal(s2.active, true);
  assert.equal(s2.currentProject, `projects/${pick.id}`);
  assert.deepEqual(started, [pick.id]);
  assert.equal(readSchedule(root).items.find(i => i.id === skip.id).project, undefined);

  projects.set(`projects/${pick.id}`, { status: 'completed', delivered: true });
  const end = await runner.tick();
  assert.equal(end.active, false);
  assert.deepEqual(started, [pick.id]);
});

test('中途遇失败/暂停/启动失败立刻暂停续跑，不重试也不继续下一支', async t => {
  const { root, runner, projects, started, setStartResponse } = makeEnv(t);
  const a = addTopic(root, '会失败的视频');
  const b = addTopic(root, '下一支不该启动');

  await runner.start();
  projects.set(`projects/${a.id}`, { status: 'failed', delivered: false });
  const paused = await runner.tick();
  assert.equal(paused.active, false);
  assert.match(paused.pausedReason, /已暂停续跑.*会失败的视频.*制作失败/);
  assert.deepEqual(started, [a.id]);
  assert.equal(readSchedule(root).items.find(i => i.id === b.id).project, undefined);

  // 启动阶段报错（如缺 API Key）也立刻暂停
  setStartResponse(() => ({ status: 200, body: { ok: true, rel: 'projects/fail-key', started: false, task: { error: { message: '缺少模型凭证' } } } }));
  const bad = await runner.start();
  assert.equal(bad.active, false);
  assert.match(bad.pausedReason, /缺少模型凭证/);
});

test('手动停止续跑不影响正在制作的视频；派发锁被占用时跳过本轮不报错', async t => {
  const { root, runner, projects, started, setLockBusy } = makeEnv(t);
  const a = addTopic(root, '第一支');
  const b = addTopic(root, '第二支');

  setLockBusy(true);
  const waiting = await runner.start();
  assert.equal(waiting.active, true);
  assert.deepEqual(started, []);

  setLockBusy(false);
  await runner.tick();
  assert.deepEqual(started, [a.id]);

  const stopped = runner.stop();
  assert.equal(stopped.active, false);
  assert.equal(stopped.pausedReason, null);
  assert.equal(projects.get(`projects/${a.id}`).status, 'running');

  projects.set(`projects/${a.id}`, { status: 'completed', delivered: true });
  await runner.tick();
  assert.deepEqual(started, [a.id], '停止续跑后不再拉起第二支');
});

test('moveItem 可把未开工项置顶或上移，且拒绝移动已开工项', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-move-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const done = addTopic(root, '已开工');
  attachProject(root, done.id, 'projects/done');
  const first = addTopic(root, '待做一');
  const second = addTopic(root, '待做二');
  const third = addTopic(root, '待做三');

  moveItem(root, third.id, 'up');
  assert.deepEqual(readSchedule(root).items.map(i => i.id), [done.id, first.id, third.id, second.id]);

  moveItem(root, second.id, 'top');
  assert.deepEqual(readSchedule(root).items.map(i => i.id), [done.id, second.id, first.id, third.id]);

  assert.throws(() => moveItem(root, done.id, 'top'), /已开工/);
});
