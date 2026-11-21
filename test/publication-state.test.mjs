import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { publicationState, pendingSummary } from '../desk/publication-state.mjs';
import { composeDraft } from '../desk/draft.mjs';
import { createPublishApi } from '../lib/publish-api.mjs';
import { createPublishScheduler } from '../lib/publish-scheduler.mjs';
import { createSnapshotService } from '../lib/snapshot-service.mjs';
import { createProjectStateService, observeProjectTask } from '../lib/project-state.mjs';
import { beginTask, updateTask } from '../lib/task-status.mjs';
import { acquireProductionLock } from '../lib/production-lock.mjs';
import { publishAccountKey, createPublishTransaction } from '../desk/publish-transaction.mjs';
import { recordAttempt } from '../lib/publish-guard.mjs';
import { buildPayload } from '../desk/publish-contract.mjs';
import { startServer } from '../lib/server.mjs';
import { productionFailure } from '../lib/automation.mjs';
import { writeCheckpoint } from '../lib/checkpoint.mjs';

const ready = () => ({ fields: { title: '测试视频', tags: 'AI', desc: '测试简介' }, copy: { tags: ['AI'] },
  publish: { ok: true }, video: { path: '/fake/video.mp4' }, cover: { ok: true }, warnings: [], blockers: [] });

test('发布状态区分制作、无成片、过期、缺资料、已投、未知和可发布；completed不是授权', () => {
  const draft = ready();
  assert.equal(publicationState({ task: { status: 'completed' }, draft: { ...draft, video: null } }).state, 'waiting-video');
  for (const flag of ['running', 'taskRunning', 'productionBusy', 'orphanRunning', 'cancelling']) {
    const state = publicationState({ task: { [flag]: true }, draft });
    assert.equal(state.state, 'producing'); assert.equal(state.waiting, true); assert.equal(state.eligible, false);
  }
  assert.equal(publicationState({ draft: { ...draft, blockers: [{ code: 'video-stale', text: '旧版' }] } }).state, 'stale');
  assert.equal(publicationState({ draft: { ...draft, cover: { ok: false } } }).state, 'needs-attention');
  assert.equal(publicationState({ draft: { ...draft, publish: { ok: false } } }).state, 'needs-attention');
  assert.equal(publicationState({ draft, gate: { ok: false, reason: 'duplicate' } }).state, 'submitted');
  assert.equal(publicationState({ draft, gate: { ok: false, reason: 'unknown' } }).state, 'unknown');
  assert.equal(publicationState({ draft, gate: { ok: false, reason: 'cooldown' } }).state, 'blocked');
  assert.equal(publicationState({ draft }).eligible, true);
  const summary = pendingSummary([{ id: 'a', ...publicationState({ draft }) }, { id: 'b', ...publicationState({ draft: null }) },
    { id: 'c', ...publicationState({ draft, gate: { ok: false, reason: 'duplicate' } }) }]);
  assert.equal(summary.total, 2); assert.equal(summary.ready, 1); assert.equal(summary.waiting, 1); assert.equal(summary.submitted, 1);
});

test('草稿层携带制作事实，目录中遗留MP4不会让制作中项目可提交', () => {
  const draft = composeDraft({ id: 'a', dir: '/fake', copy: { title: '标题', tags: ['AI'] }, copyStatus: { ok: true },
    video: { file: 'out/video-voice.mp4' }, videoState: { stale: false }, cover: { ok: true }, task: { running: true } });
  assert.equal(draft.ready, false); assert.ok(draft.blockers.some(item => item.code === 'project-running'));
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publication-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), dir = path.join(root, 'projects/a');
  fs.mkdirSync(home); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{"deliveryTarget":"video"}');
  const video = path.join(dir, 'fake-video.mp4'); fs.writeFileSync(video, 'simulated video bytes');
  const credential = { mid: 1, cookies: { SESSDATA: 'fake', bili_jct: 'fake', DedeUserID: '1' } };
  const credDir = path.join(home, '.config/video-harness'); fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, 'bilibili.json'), JSON.stringify(credential), { mode: 0o600 });
  let scheduler, deps, draft = { ...ready(), id: 'a', dir, video: { path: video, fingerprint: createHash('sha256').update(fs.readFileSync(video)).digest('hex') } };
  const api = createPublishApi({ root, home, getDraft: async () => draft,
    fetchImpl: async () => { throw new Error('禁止联网'); },
    schedulerFactory: options => { deps = options; scheduler = createPublishScheduler(options); return scheduler; } });
  return { root, home, dir, video, credential, api, get scheduler() { return scheduler; }, get deps() { return deps; },
    setDraft: value => { draft = value; } };
}

test('共用任务事实：发布台和调度器都排除制作中遗留成片，结束后自动转待发', async t => {
  const f = fixture(t), task = beginTask(f.dir, '测试制作', 'article');
  const producing = (await f.api.projects())[0];
  assert.equal(producing.task.running, true); assert.equal(producing.publication.state, 'producing');
  assert.equal(await f.deps.getCandidate('a'), null);
  updateTask(f.dir, task.id, { status: 'completed' });
  const finished = (await f.api.projects())[0];
  assert.equal(finished.task.running, false); assert.equal(finished.publication.state, 'ready');
  assert.equal((await f.deps.getCandidate('a')).id, 'a');
});

test('发布台没有独立完成状态副本：写入新任务后下一次读取立即恢复等待', async t => {
  const f = fixture(t);
  assert.equal((await f.api.projects())[0].publication.state, 'ready');
  beginTask(f.dir, '重新制作', 'article');
  assert.equal((await f.api.projects())[0].publication.state, 'producing');
  assert.equal((await f.api.projects())[0].ready, false);
});

test('制作队列范围动态纳入后续项目，但不纳入无关目录；未出片不启动投稿', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'schedule.json'), JSON.stringify({ items: [{ id: 't1', topic: '选题' }] }));
  await f.api.saveSchedule({ action: 'save', revision: 0, times: ['12:00'], ids: [], scope: { kind: 'production-queue' }, partition: null });
  let state = await f.api.schedule();
  assert.equal(state.enabled, false); assert.equal(state.pending.total, 0);
  fs.writeFileSync(path.join(f.root, 'schedule.json'), JSON.stringify({ items: [{ id: 't1', topic: '选题', project: 'projects/a' },
    { id: 't2', topic: '无关目录', project: 'demo/example' }] }));
  state = await f.api.schedule(); assert.equal(state.pending.ready, 1); assert.deepEqual(state.pending.items.map(item => item.id), ['a']);
  assert.equal(state.protocolVersion, 3);
  beginTask(f.dir, '制作', 'article');
  state = await f.api.schedule(); assert.equal(state.pending.ready, 0); assert.equal(state.pending.waiting, 1);
});

test('已投成片和未知账号日志，在项目列表与排程摘要使用同一发布状态', async t => {
  const f = fixture(t), store = path.join(f.home, '.config/video-harness/publish-state', publishAccountKey(f.credential));
  const fingerprint = createHash('sha256').update(fs.readFileSync(f.video)).digest('hex');
  recordAttempt(store, { project: 'a', fingerprint, outcome: 'submitted', bvid: 'BV-fixture' });
  assert.equal((await f.api.projects())[0].publication.state, 'submitted');
  await f.api.saveSchedule({ action: 'save', revision: 0, ids: ['a'], times: ['12:00'] });
  assert.equal((await f.api.schedule()).pending.submitted, 1);
  assert.equal(await f.deps.getCandidate('a'), null);
  recordAttempt(store, { project: 'another-project', outcome: 'unknown' });
  assert.equal((await f.api.projects())[0].publication.state, 'unknown');
  assert.equal((await f.api.schedule()).pending.needsAttention, 1);
});

test('保存排程不要求登录/分区/成片；明确启用才需要账号和有效分区，修改撤销旧授权', async t => {
  const f = fixture(t);
  const saved = await f.api.saveSchedule({ action: 'save', revision: 0, ids: [], times: ['12:00'], partition: null });
  assert.equal(saved.enabled, false);
  await assert.rejects(async () => f.api.saveSchedule({ action: 'enable', revision: saved.revision, confirmed: true }), /分区/);
  const enabled = await f.api.saveSchedule({ action: 'enable', revision: saved.revision, confirmed: true, partition: { tid: 231, partitionTaxonomy: 'legacy-tid' } });
  assert.equal(enabled.enabled, true); assert.equal(enabled.pending.total, 0);
  const edited = await f.api.saveSchedule({ action: 'save', revision: enabled.revision, times: ['13:00'] });
  assert.equal(edited.enabled, false); assert.equal(edited.accountKey, null);
  fs.unlinkSync(path.join(f.home, '.config/video-harness/bilibili.json'));
  const offline = await f.api.saveSchedule({ action: 'save', revision: edited.revision, times: ['14:00'], partition: null });
  assert.equal(offline.enabled, false); assert.deepEqual(offline.times, ['14:00']);
});

test('共用状态服务的publication快照在有界worker中读取；没有视频不是读取错误', async t => {
  const f = fixture(t), snapshots = createSnapshotService(), states = createProjectStateService({ snapshots });
  t.after(() => snapshots.close());
  const task = beginTask(f.dir, '测试', 'article');
  const running = await states.readDraft(f.dir);
  assert.equal(running.task.running, true); assert.equal(running.video, null);
  updateTask(f.dir, task.id, { status: 'completed' });
  const done = await states.readDraft(f.dir);
  assert.equal(done.task.running, false); assert.equal(done.video, null);
});

test('上传项目租约防止发布期间被重新制作；锁竞争不产生对外投稿', async t => {
  const f = fixture(t);
  const lock = acquireProductionLock(f.dir, { command: 'test-live-production', env: {} });
  try {
    const result = await f.api.submit({ id: 'a', title: '标题', tags: 'AI', tid: 231, copyright: 1, cover: false, confirmed: true });
    assert.equal(result.ok, false); assert.equal(result.waiting, true);
  } finally { lock.release(); }
});

test('只读publication worker不会结算取消或覆盖任务/运行标记', async t => {
  const f = fixture(t), task = beginTask(f.dir, '取消中的旧任务', 'article');
  const marker = { pid: 99999999, taskId: task.id, attemptId: task.attemptId };
  updateTask(f.dir, task.id, { status: 'cancelling', cancellation: { ...marker, pids: [marker.pid], childPids: [], marker } });
  const runPath = path.join(f.dir, 'out/.vh-run.json'), taskPath = path.join(f.dir, 'out/.vh-task.json');
  fs.writeFileSync(runPath, JSON.stringify(marker));
  const beforeTask = fs.readFileSync(taskPath), beforeRun = fs.readFileSync(runPath);
  const snapshots = createSnapshotService(); t.after(() => snapshots.close());
  const draft = await snapshots.readPublication(f.dir);
  assert.equal(draft.task.cancelling, true);
  assert.deepEqual(fs.readFileSync(taskPath), beforeTask); assert.deepEqual(fs.readFileSync(runPath), beforeRun);
});

test('同进程上传租约对派发和改幅可见，只有真实句柄能作内部复核豁免', async t => {
  const f = fixture(t), lock = acquireProductionLock(f.dir, { command: 'publish-upload', env: {} });
  const server = startServer(f.dir, 0, { root: f.root, home: f.home, publish: {} });
  await once(server, 'listening');
  try {
    assert.equal(observeProjectTask(f.dir).productionBusy, true);
    assert.equal(observeProjectTask(f.dir, { productionLease: { project: f.dir, pid: process.pid } }).productionBusy, true);
    assert.equal(observeProjectTask(f.dir, { productionLease: lock }).productionBusy, false);
    assert.throws(() => beginTask(f.dir, '不能同时重新制作', 'article'), /执行进程|取消/);
    const base = `http://127.0.0.1:${server.address().port}`;
    const before = fs.readFileSync(path.join(f.dir, 'PROJECT.json'));
    const response = await fetch(base + '/_api/format', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{"aspectRatio":"9:16"}' });
    assert.equal(response.status, 409); assert.deepEqual(fs.readFileSync(path.join(f.dir, 'PROJECT.json')), before);
  } finally { lock.release(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});

test('上传租约不会把自己的worker快照当成制作阻断，且上传中不能派发其它制作', async t => {
  const f = fixture(t), fingerprint = createHash('sha256').update(fs.readFileSync(f.video)).digest('hex');
  let uploads = 0;
  const api = createPublishApi({ root: f.root, home: f.home,
    projectStates: { readDraft: async () => {
      const task = observeProjectTask(f.dir);
      return { ...ready(), dir: f.dir, task, video: { path: f.video, fingerprint },
        blockers: task.productionBusy ? [{ code: 'project-running', text: '模拟worker看到上传租约' }] : [] };
    } },
    fetchImpl: async () => { throw new Error('禁止联网'); },
    createClient: () => ({
      partitions: async () => ({ live: true, taxonomy: 'legacy-tid', list: [{ id: 231, name: '计算机技术' }] }),
      uploadVideo: async () => { uploads++; assert.throws(() => beginTask(f.dir, '不能同时制作', 'article')); return { filename: 'fake-upload' }; },
      buildPayload, submit: async () => ({ bvid: 'BV-fixture', aid: 1 }),
    }),
  });
  const result = await api.submit({ id: 'a', title: '标题', tags: 'AI', tid: 231, copyright: 1, cover: false, confirmed: true });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(uploads, 1);
  assert.equal(observeProjectTask(f.dir).productionBusy, false);
});

test('提交预检和账号事务完整哈希走异步流，不在HTTP线程同步读取整片', async t => {
  const f = fixture(t); fs.writeFileSync(f.video, Buffer.alloc(4 * 1024 * 1024, 7));
  const tx = createPublishTransaction({ root: f.root, home: f.home });
  const input = { credential: f.credential, draft: { video: { path: f.video } }, input: { id: 'a' } };
  const inode = fs.statSync(f.video).ino, original = fs.readSync;
  let synchronousMediaBytes = 0;
  fs.readSync = function(fd, ...args) {
    const count = Reflect.apply(original, this, [fd, ...args]);
    if (fs.fstatSync(fd).ino === inode) synchronousMediaBytes += count;
    return count;
  };
  try {
    assert.equal((await tx.preflight(input)).ok, true);
    assert.equal((await tx.execute(input, async () => ({ ok: true, outcome: 'submitted', bvid: 'BV-fixture' }))).ok, true);
  } finally { fs.readSync = original; }
  assert.ok(synchronousMediaBytes <= 2 * 1024 * 1024, `只允许两次兼容旧日志的首兆读取，实际 ${synchronousMediaBytes}`);
});

test('暂停任务的轻量观察不为检查旧停止原因而同步哈希媒体', t => {
  const f = fixture(t), task = beginTask(f.dir, '等待修复的任务', 'article');
  let repairs = {};
  for (let i = 0; i < 2; i++) repairs = productionFailure(repairs, { stage: 'measure', reason: 'FAIL 测试', sourceSignature: String(i), maxRepairs: 2 });
  repairs = productionFailure(repairs, { stage: 'render', reason: 'ENOSPC 空间不足', sourceSignature: 'stopped', maxRepairs: 2 });
  writeCheckpoint(f.dir, { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId, mode: 'article', status: 'paused',
    messages: [{ role: 'user', content: '测试' }], pending: [], pipelineState: { productionRepairs: repairs } });
  updateTask(f.dir, task.id, { status: 'paused' });
  const media = ['video.mp4', 'video-voice.mp4'].map(file => path.join(f.dir, 'out', file));
  for (const file of media) fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));
  const inodes = new Set(media.map(file => fs.statSync(file).ino)), original = fs.readSync;
  let bytes = 0;
  fs.readSync = function(fd, ...args) { const count = Reflect.apply(original, this, [fd, ...args]); if (inodes.has(fs.fstatSync(fd).ino)) bytes += count; return count; };
  try { assert.equal(observeProjectTask(f.dir).status, 'paused'); }
  finally { fs.readSync = original; }
  assert.equal(bytes, 0);
});
