import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { normalizeTimes, normalizePending, dueSlot, upcomingSlots, slotAt } from '../desk/publish-schedule.mjs';
import { createPublishScheduler } from '../lib/publish-scheduler.mjs';
import { startServer } from '../lib/server.mjs';
import { acquireProductionLock } from '../lib/production-lock.mjs';
import { createPublishService } from '../desk/service.mjs';

const date = (day, hour, minute = 0, second = 0) => +new Date(2026, 10, day, hour, minute, second);
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publish-schedule-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = date(10, 19), key = 'account-a';
  const calls = [], candidates = [];
  const deps = { root, clock: () => now, accountKey: () => key,
    getCandidate: async id => { candidates.push(id); return id === 'unfinished' ? null : { id }; },
    submitOne: async candidate => { calls.push(candidate.id); return { ok: true, outcome: 'submitted', bvid: 'BV-fixture' }; }, ...options };
  const scheduler = createPublishScheduler(deps);
  t.after(() => scheduler.stop());
  const enable = (input = {}) => scheduler.save({ revision: scheduler.view().revision, enabled: true, confirmed: true,
    times: ['20:00'], ids: ['a', 'b'], partition: { tid: 231, partitionTaxonomy: 'legacy-tid' }, ...input });
  return { root, scheduler, deps, enable, calls, candidates, time: value => { now = value; }, account: value => { key = value; } };
}

test('每日时点严格校验、去重排序；队列允许空，但拒绝路径', () => {
  assert.deepEqual(normalizeTimes(['20:00', '09:30', '20:00']), ['09:30', '20:00']);
  for (const times of [[], ['24:00'], ['9:00'], ['12:60'], null]) assert.throws(() => normalizeTimes(times));
  assert.deepEqual(normalizePending([]), []);
  assert.deepEqual(normalizePending(['a', ' a ', 'b']), ['a', 'b']);
  for (const ids of [['../a'], ['a/b'], ['..'], [''], ['a\\b'], ['a\n']]) assert.throws(() => normalizePending(ids));
});

test('未启用与空队列没有任何投稿或素材读取，默认读取也不创建目录', async t => {
  const f = fixture(t);
  assert.equal((await f.scheduler.tick()).reason, 'not-due');
  assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
  f.enable({ ids: [] }); f.time(date(10, 20));
  assert.equal((await f.scheduler.tick()).reason, 'empty');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.candidates, []);
  assert.equal(f.scheduler.view().lastAttempt, null);
});

test('没有成片时不动；有成片按队列顺序取一支，其余留待下一时点', async t => {
  const f = fixture(t); f.enable({ ids: ['unfinished', 'a', 'b'], times: ['20:00', '21:30'] });
  f.time(date(10, 19, 59)); assert.equal((await f.scheduler.tick()).reason, 'not-due');
  f.time(date(10, 20, 0, 10)); assert.equal((await f.scheduler.tick()).reason, 'submitted');
  assert.deepEqual(f.calls, ['a']); assert.deepEqual(f.scheduler.view().ids, ['unfinished', 'b']);
  await f.scheduler.tick(); assert.deepEqual(f.calls, ['a']);
  f.time(date(10, 21, 30)); await f.scheduler.tick(); assert.deepEqual(f.calls, ['a', 'b']);
  f.time(date(11, 20)); assert.equal((await f.scheduler.tick()).reason, 'empty');
  assert.equal(f.scheduler.view().enabled, true);
});

test('成片后投稿：空转只看就绪状态，第一支立即提交，从收稿开始计时且重启不清冷却', async t => {
  let ready = false, finish, start;
  const submitting = new Promise(resolve => { start = resolve; });
  const f = fixture(t, {
    getCandidate: async id => ready ? { id } : null,
    submitOne: async ({ id }) => {
      f.calls.push(id);
      if (id === 'a') await new Promise(resolve => { finish = resolve; start(); });
      return { ok: true, outcome: 'submitted' };
    },
  });
  const trigger = { kind: 'ready', intervalSeconds: 45 };
  assert.throws(() => f.enable({ trigger: { ...trigger, intervalSeconds: 29 } }), /30–86400/);
  f.enable({ trigger });
  assert.equal((await f.scheduler.tick()).reason, 'empty');
  assert.equal(f.scheduler.view().lastAttempt, null);
  ready = true; const pending = f.scheduler.tick(); await submitting;
  const restarted = createPublishScheduler(f.deps);
  f.time(date(10, 19, 10)); assert.equal((await restarted.tick()).reason, 'not-due');
  finish(); assert.equal((await pending).reason, 'submitted');
  assert.equal(restarted.view().nextReadyAt, date(10, 19, 10, 45));
  f.time(date(10, 19, 10, 44)); assert.equal((await restarted.tick()).reason, 'not-due');
  f.time(date(10, 19, 10, 45));
  await Promise.all([restarted.tick(), f.scheduler.tick()]);
  assert.deepEqual(f.calls, ['a', 'b']);
  assert.equal(restarted.view().lastSlot, '');
  assert.deepEqual(restarted.view().calendar, []);
});

test('成片后投稿读动态制作队列；制作锁只等待，未知结果暂停且不会自动重投', async t => {
  const ids = [];
  const f = fixture(t, {
    listScopeIds: () => ids,
    submitOne: async ({ id }) => {
      f.calls.push(id);
      return f.calls.length === 1 ? { ok: false, waiting: true } : { ok: false, outcome: 'unknown' };
    },
  });
  const trigger = { kind: 'ready', intervalSeconds: 30 };
  f.enable({ trigger, scope: { kind: 'production-queue' } });
  assert.equal((await f.scheduler.tick()).reason, 'empty');
  ids.push('new-project');
  assert.equal((await f.scheduler.tick()).reason, 'waiting');
  assert.equal(f.scheduler.view().enabled, true);
  assert.equal((await f.scheduler.tick()).reason, 'paused');
  assert.equal(f.scheduler.view().enabled, false);
  f.time(date(11, 18));
  assert.equal((await createPublishScheduler(f.deps).tick()).reason, 'not-due');
  assert.deepEqual(f.calls, ['new-project', 'new-project']);
});

test('纯未完成队列不认领时点、不写尝试，也不自动触发制作', async t => {
  const f = fixture(t); const enabled = f.enable({ ids: ['unfinished'] });
  f.time(date(10, 20)); await f.scheduler.tick();
  assert.equal(f.scheduler.view().revision, enabled.revision);
  assert.equal(f.scheduler.view().lastSlot, ''); assert.deepEqual(f.calls, []);
});

test('错过不补发；启用当前分钟不立即投稿；本地日期跨天正常', async t => {
  const f = fixture(t); f.time(date(10, 20, 0, 15)); f.enable();
  assert.equal((await f.scheduler.tick()).reason, 'not-due');
  f.time(date(11, 20, 1)); assert.equal((await f.scheduler.tick()).reason, 'not-due');
  f.time(date(12, 20)); await f.scheduler.tick(); assert.deepEqual(f.calls, ['a']);
  assert.equal(f.scheduler.view().lastSlot, '2026-11-12 20:00');
});

test('认领持久化：重建服务与双实例都不会在同一时点连发', async t => {
  const f = fixture(t); f.enable(); f.time(date(10, 20));
  const second = createPublishScheduler(f.deps);
  await Promise.all([f.scheduler.tick(), second.tick()]);
  assert.equal(f.calls.length, 1);
  await createPublishScheduler(f.deps).tick(); assert.equal(f.calls.length, 1);
  f.time(date(11, 20)); await second.tick(); assert.deepEqual(f.calls, ['a', 'b']);
});

test('真正跨进程竞争一个时点，只能提交一支，不会先后连发不同作品', async t => {
  const f = fixture(t); f.enable();
  const url = new URL('../lib/publish-scheduler.mjs', import.meta.url).href;
  const code = `import fs from 'node:fs'; import { createPublishScheduler } from ${JSON.stringify(url)};
    const root = process.argv[1];
    const s = createPublishScheduler({root,clock:()=>+new Date(2026,10,10,20),accountKey:()=> 'account-a',
      getCandidate:async id=>{await new Promise(r=>setTimeout(r,30));return {id};},
      submitOne:async ({id})=>{fs.appendFileSync(root+'/fake-submissions.txt',id+'\\n');await new Promise(r=>setTimeout(r,30));return {ok:true,outcome:'submitted'};}});
    await s.tick();`;
  await Promise.all([1, 2].map(async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.root], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const [status] = await once(child, 'close'); assert.equal(status, 0, stderr);
  }));
  assert.equal(fs.readFileSync(path.join(f.root, 'fake-submissions.txt'), 'utf8'), 'a\n');
  assert.deepEqual(f.scheduler.view().ids, ['b']);
});

test('只重试回执短锁竞争，不重复调用投稿；扫描异常则持久化暂停', async t => {
  let submits = 0;
  const f = fixture(t, { submitOne: async () => {
    submits++;
    const lock = acquireProductionLock(path.join(f.root, 'out/.publish-schedule'), { command: 'test-contention', env: {} });
    setTimeout(() => lock.release(), 40);
    return { ok: true, outcome: 'submitted' };
  } });
  f.enable(); f.time(date(10, 20)); assert.equal((await f.scheduler.tick()).reason, 'submitted');
  assert.equal(submits, 1); assert.equal(f.scheduler.view().lastAttempt.state, 'submitted');
  const broken = fixture(t, { getCandidate: async () => { throw new Error('素材读取异常'); } });
  broken.enable(); broken.time(date(10, 20)); assert.equal((await broken.scheduler.tick()).reason, 'error');
  assert.equal(broken.scheduler.view().enabled, false);
  assert.match(broken.scheduler.view().pauseReason, /素材读取异常/);
  assert.equal(createPublishScheduler(broken.deps).view().enabled, false);
});

test('提交用例对实际捕获的账号核对排程授权，拒绝外层检查后的账号竞态', async () => {
  let draftReads = 0, uploads = 0;
  const service = createPublishService({ getCredentials: () => ({ key: 'b', cookies: { SESSDATA: 'fake', bili_jct: 'fake' } }),
    credentialKey: cred => cred.key, getDraft: async () => { draftReads++; },
    createClient: () => { uploads++; }, transaction: { execute: () => { uploads++; } } });
  const result = await service.submit({ id: 'a', confirmed: true, expectedAccountKey: 'a' });
  assert.equal(result.reason, 'account-changed'); assert.equal(draftReads, 0); assert.equal(uploads, 0);
});

test('投稿失败（包括未知结果）暂停，次日也不重试、不换视频绕过', async t => {
  for (const outcome of ['unknown', 'rejected', 'not-submitted']) {
    let count = 0;
    const f = fixture(t, { submitOne: async () => { count++; return { ok: false, outcome, message: 'fixture failure' }; } });
    f.enable(); f.time(date(10, 20)); assert.equal((await f.scheduler.tick()).reason, 'paused');
    assert.equal(f.scheduler.view().enabled, false);
    assert.deepEqual(f.scheduler.view().ids, ['a', 'b']);
    f.time(date(11, 20)); await f.scheduler.tick(); assert.equal(count, 1);
  }
});

test('最后一刻重新制作造成未上传，只跳过当前时点并保持排程等待，不当投稿失败', async t => {
  let calls = 0;
  const f = fixture(t, { submitOne: async () => { calls++; return { ok: false, outcome: 'not-submitted', waiting: true, message: '项目重新制作中' }; } });
  f.enable(); f.time(date(10, 20));
  assert.equal((await f.scheduler.tick()).reason, 'waiting');
  assert.equal(f.scheduler.view().enabled, true); assert.equal(f.scheduler.view().lastAttempt.state, 'waiting');
  assert.deepEqual(f.scheduler.view().ids, ['a', 'b']);
  await f.scheduler.tick(); assert.equal(calls, 1);
});

test('投稿中禁止重入与重新启用；暂停不会取消已开始事务，也不会被成功回执反向开启', async t => {
  let resolveSubmit;
  const f = fixture(t, { submitOne: () => new Promise(resolve => { resolveSubmit = resolve; }) });
  f.enable(); f.time(date(10, 20)); const pending = f.scheduler.tick();
  // getCandidate 会异步让出；等待执行器确实进入事务。
  while (!resolveSubmit) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.scheduler.tick()).reason, 'busy');
  assert.throws(() => f.enable(), /人工核对/);
  const restarted = createPublishScheduler(f.deps);
  assert.equal((await restarted.tick()).reason, 'not-due');
  f.scheduler.save({ enabled: false, revision: f.scheduler.view().revision });
  resolveSubmit({ ok: true, outcome: 'submitted' }); await pending;
  assert.equal(f.scheduler.view().enabled, false); assert.deepEqual(f.scheduler.view().ids, ['b']);
});

test('素材扫描期间暂停/修改/跨过时点，不执行过期快照', async t => {
  let release;
  const f = fixture(t, { getCandidate: id => new Promise(resolve => { release = () => resolve({ id }); }) });
  f.enable(); f.time(date(10, 20)); const pending = f.scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  f.scheduler.save({ revision: f.scheduler.view().revision, enabled: false });
  release(); assert.equal((await pending).reason, 'changed'); assert.deepEqual(f.calls, []);
});

test('关闭调度器后，正在扫描的本轮不再开始新投稿', async t => {
  let release;
  const f = fixture(t, { getCandidate: id => new Promise(resolve => { release = () => resolve({ id }); }) });
  f.enable(); f.time(date(10, 20)); const pending = f.scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  f.scheduler.stop(); release();
  assert.equal((await pending).reason, 'stopped'); assert.deepEqual(f.calls, []);
});

test('关闭发生在动态范围复核期间，也不能随后认领新投稿', async t => {
  let lookups = 0, release;
  const f = fixture(t, { listScopeIds: plan => ++lookups === 2 ? new Promise(resolve => { release = () => resolve(plan.ids); }) : plan.ids });
  f.enable(); f.time(date(10, 20)); const pending = f.scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function'); f.scheduler.stop(); release();
  assert.equal((await pending).reason, 'stopped'); assert.deepEqual(f.calls, []);
});

test('扫描异常碰上长锁竞争，暂停意图不会丢；下一轮先暂停而不是重新投稿', async t => {
  let reads = 0, held;
  const f = fixture(t, { getCandidate: async id => {
    reads++;
    if (reads === 1) {
      held = acquireProductionLock(path.join(f.root, 'out/.publish-schedule'), { command: 'test-contention', env: {} });
      throw new Error('fixture EIO');
    }
    return { id };
  } });
  f.enable(); f.time(date(10, 20));
  try { assert.equal((await f.scheduler.tick()).reason, 'error'); }
  finally { held?.release(); }
  assert.equal((await f.scheduler.tick()).reason, 'paused');
  assert.equal(f.scheduler.view().enabled, false); assert.equal(reads, 1); assert.deepEqual(f.calls, []);
});

test('账号切换或退出会暂停，不继承之前的发布授权', async t => {
  const f = fixture(t); f.enable(); f.account('account-b'); f.time(date(10, 20));
  assert.equal((await f.scheduler.tick()).reason, 'account-changed');
  assert.equal(f.scheduler.view().enabled, false); assert.deepEqual(f.calls, []);
  f.account(null); assert.throws(() => f.enable(), /登录/);
});

test('非发布时间也检查账号变化并暂停，切回原账号不会自动恢复', async t => {
  const f = fixture(t); f.enable(); f.account('account-b');
  assert.equal((await f.scheduler.tick()).reason, 'account-changed');
  f.account('account-a'); f.time(date(10, 20)); await f.scheduler.tick();
  assert.equal(f.scheduler.view().enabled, false); assert.deepEqual(f.calls, []);
});

test('明确确认与乐观版本保护；暂停保留队列和时点；不改旧 schedule.json', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'schedule.json'), '{"publish":{"enabled":true}}');
  assert.throws(() => f.enable({ confirmed: false }), /确认/);
  f.enable(); assert.throws(() => f.enable({ revision: 0 }), /刷新/);
  const state = f.scheduler.save({ revision: f.scheduler.view().revision, enabled: false });
  assert.deepEqual(state.ids, ['a', 'b']); assert.deepEqual(state.times, ['20:00']);
  assert.equal(fs.readFileSync(path.join(f.root, 'schedule.json'), 'utf8'), '{"publish":{"enabled":true}}');
});

test('损坏状态不当成空配置，不继续投稿；遗留 running 不自动恢复，核对后可显式解除', async t => {
  const f = fixture(t); f.enable();
  const file = path.join(f.root, 'out/.publish-schedule/state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.lastAttempt = { attemptId: 'orphan-1', state: 'running', id: 'a', at: date(10, 20) };
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(f.scheduler.view().attemptActive, false);
  f.time(date(11, 20)); assert.equal((await f.scheduler.tick()).reason, 'not-due');
  assert.throws(() => f.enable(), /人工核对/);
  assert.throws(() => f.scheduler.save({ action: 'reconcile', revision: f.scheduler.view().revision, confirmed: false }), /确认/);
  const reconciled = f.scheduler.save({ action: 'reconcile', revision: f.scheduler.view().revision, resolution: 'not-submitted', confirmed: true });
  assert.equal(reconciled.enabled, false);
  assert.equal(reconciled.lastAttempt.state, 'failed');
  assert.equal(reconciled.lastAttempt.outcome, 'interrupted');
  f.enable();
  assert.equal(f.scheduler.view().enabled, true);
  fs.writeFileSync(file, '{bad'); assert.equal((await f.scheduler.tick()).reason, 'error');
  assert.deepEqual(f.calls, []);
});

test('reconcileSubmitted：仅在非运行中同步已完成的手工投稿，正在执行的投稿不可提前解除', async t => {
  let resolveSubmit;
  const f = fixture(t, { submitOne: () => new Promise(resolve => { resolveSubmit = resolve; }) });
  f.enable(); f.time(date(10, 20));
  const pending = f.scheduler.tick();
  while (!resolveSubmit) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scheduler.view().attemptActive, true);
  assert.equal(f.scheduler.reconcileSubmitted({ id: 'a', bvid: 'BV1live00000' }), false);
  assert.throws(() => f.scheduler.save({ action: 'reconcile', revision: f.scheduler.view().revision, resolution: 'submitted', confirmed: true }), /仍在执行中/);
  resolveSubmit({ ok: true, outcome: 'submitted', bvid: 'BV1done00000' });
  await pending;
  assert.equal(f.scheduler.view().attemptActive, false);

  const file = path.join(f.root, 'out/.publish-schedule/state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.lastAttempt = { attemptId: 'orphan-2', state: 'running', id: 'b', at: date(10, 25) };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(f.scheduler.reconcileSubmitted({ id: 'b', bvid: 'BV1manual000', finishedAt: date(10, 30) }), true);
  const after = f.scheduler.view();
  assert.equal(after.lastAttempt.state, 'submitted');
  assert.equal(after.lastAttempt.bvid, 'BV1manual000');
  assert.deepEqual(after.ids, []);
  assert.equal(after.lastSubmittedAt, date(10, 30));
});

test('日历展示七天；已过和已用的时点排除，时间倒拨不重发', () => {
  const now = date(10, 20, 1), plan = { enabled: true, times: ['12:00', '20:00'], activatedAt: date(9, 19), lastSlot: '2026-11-10 20:00' };
  const calendar = upcomingSlots(plan, now);
  assert.equal(calendar.length, 7); assert.deepEqual(calendar[0].times, []);
  assert.deepEqual(calendar[1].times, ['12:00', '20:00']);
  assert.equal(dueSlot(plan, date(10, 12)), null);
  assert.equal(slotAt(date(10, 0)).key, '2026-11-10 00:00');
});

test('每日时点按服务本地时间，不用 UTC 日期；夏令时缺失时点不顺延', () => {
  const url = new URL('../desk/publish-schedule.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { slotAt, upcomingSlots } from ${JSON.stringify(url)};
    assert.equal(slotAt(+new Date(2026, 10, 10, 0, 30)).key, '2026-11-10 00:30');
    const days = upcomingSlots({times:['02:30'],activatedAt:0,lastSlot:''}, +new Date(2026,2,8,0,0));
    assert.deepEqual(days[0].times, []);
    assert.deepEqual(days[1].times, ['02:30']);
  `], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(result.status, 0, result.stderr);
});

test('HTTP 接线独立于默认项目，同源保护仍在，服务关闭清理调度器', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publish-schedule-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let started = 0, stopped = 0, saves = 0;
  const server = startServer(null, 0, { root, publish: {
    startSchedule: () => { started++; }, stopSchedule: () => { stopped++; },
    schedule: () => ({ enabled: false }), saveSchedule: input => { saves++; return input; },
  } });
  await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(started, 1);
    assert.equal((await fetch(base + '/_api/publish/schedule')).status, 200);
    const denied = await fetch(base + '/_api/publish/schedule', { method: 'POST', headers: { origin: 'https://other.example' }, body: '{}' });
    assert.equal(denied.status, 403); assert.equal(saves, 0);
    const saved = await fetch(base + '/_api/publish/schedule', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{"enabled":false}' });
    assert.equal(saved.status, 200); assert.equal(saves, 1);
  } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(stopped, 1);
});
