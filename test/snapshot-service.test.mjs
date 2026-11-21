import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createSnapshotService } from '../lib/snapshot-service.mjs';
import { startServer, workbenchTaskStatus } from '../lib/server.mjs';
import { snapshot } from '../lib/state.mjs';
import { deliverableState, projectDeliveryState } from '../lib/deliverable.mjs';
import { beginTask, updateTask, taskStatus } from '../lib/task-status.mjs';

function fixture(t, waitMs = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-snapshot-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  for (const [name, text] of Object.entries({
    'PROJECT.json': '{}', '脚本.md': '## S1 · 测试\n1. 第一句。\n', 'scenes.src.js': '//---\nroot => ({})',
    'scene.html': 'const DURATION=1; const scenes = []; addScene(0,1,root=>({}));', 'timing.json': '{}',
    'timeline.mjs': `import fs from 'node:fs';
      export const scriptGroups = () => [];
      export function validateTiming() {
        fs.appendFileSync(new URL('./calls.txt', import.meta.url), 'x');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${waitMs});
        return { subs: [], total: 1 };
      }`,
  })) fs.writeFileSync(path.join(project, name), text);
  return { root, project, calls: path.join(project, 'calls.txt') };
}

async function waitFor(check) {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(10); }
  throw new Error('等待测试工作进程超时');
}

test('full snapshot runs off the HTTP event loop, keeping unrelated requests responsive', async t => {
  const { root, project, calls } = fixture(t, 1000);
  const server = startServer(project, 0, { root });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  let finished = false;
  const state = fetch(url + '/_api/state').then(async r => { assert.equal(r.status, 200); return r.json(); }).finally(() => { finished = true; });
  await waitFor(() => fs.existsSync(calls));
  const format = await fetch(url + '/_api/format');
  assert.equal(format.status, 200);
  assert.equal(finished, false, 'timing validator is still running, but the HTTP server answered');
  assert.equal((await state).name, 'project');
});

test('overlapping same-project reads share work; the next read recomputes current state', async t => {
  const { project, calls } = fixture(t, 300), service = createSnapshotService();
  t.after(() => service.close());
  const first = service.read(project);
  await waitFor(() => fs.existsSync(calls));
  const second = service.read(project);
  assert.equal(first, second);
  const original = await first;
  assert.equal(fs.readFileSync(calls, 'utf8'), 'x');
  fs.writeFileSync(path.join(project, 'scene.html'), 'const DURATION=2; const scenes = []; addScene(0,2,root=>({}));');
  const fresh = await service.read(project);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'xx');
  assert.equal(original.duration, 1); assert.equal(fresh.duration, 2);
  assert.deepEqual(fresh, await snapshot(project), 'worker preserves the existing full snapshot contract');
});

test('each snapshot reloads timeline and transitive imports, including same-mtime edits', async t => {
  const { project } = fixture(t), service = createSnapshotService({ concurrency: 1 });
  t.after(() => service.close());
  const timeline = path.join(project, 'timeline.mjs'), helper = path.join(project, 'helper.mjs');
  fs.writeFileSync(helper, 'export const total = 1;');
  fs.writeFileSync(timeline, "import { total } from './helper.mjs'; export const scriptGroups=()=>[]; export const validateTiming=()=>({subs:[],total});");
  const originalHelperTime = fs.statSync(helper).mtime;
  assert.equal((await service.read(project)).timing.total, 1);
  fs.writeFileSync(helper, 'export const total = 2;');
  fs.utimesSync(helper, originalHelperTime, originalHelperTime);
  assert.equal((await service.read(project)).timing.total, 2, 'transitive project module is not reused');
  const originalTimelineTime = fs.statSync(timeline).mtime;
  fs.writeFileSync(timeline, 'export const scriptGroups=()=>[]; export const validateTiming=()=>{throw new Error("modified validator")};');
  fs.utimesSync(timeline, originalTimelineTime, originalTimelineTime);
  const changed = (await service.read(project)).timing;
  assert.equal(changed.state, 'invalid'); assert.match(changed.note, /modified validator/);
});

test('timeout is an error, never a successful old snapshot; the pool recovers', async t => {
  const slow = fixture(t, 3000), fast = fixture(t), service = createSnapshotService({ concurrency: 1, timeoutMs: 800 });
  t.after(() => service.close());
  await assert.rejects(service.read(slow.project), /超时/);
  assert.equal((await service.read(fast.project)).name, 'project');
});

test('closing the service rejects pending work and does not reuse a result', async t => {
  const { project, calls } = fixture(t, 1500), service = createSnapshotService();
  const running = service.read(project);
  await waitFor(() => fs.existsSync(calls));
  service.close();
  await assert.rejects(running, /关闭/);
  await assert.rejects(service.read(project), /关闭/);
});

test('delivery observations preserve both existing contracts and are fresh on every call', async t => {
  const { project } = fixture(t), service = createSnapshotService();
  t.after(() => service.close());
  assert.deepEqual(await service.readDelivery(project, 'video'), deliverableState(project));
  assert.deepEqual(await service.readDelivery(project, 'project'), projectDeliveryState(project));
  fs.writeFileSync(path.join(project, '发布文案.md'), '不合格文案');
  assert.deepEqual(await service.readDelivery(project, 'project'), projectDeliveryState(project));
});

test('task transitions during background delivery check cannot inherit the old result', async t => {
  const { project } = fixture(t), task = beginTask(project, '测试', 'article');
  updateTask(project, task.id, { status: 'completed' });
  let resolve;
  const runtime = { snapshots: { readDelivery: () => new Promise(r => { resolve = r; }) } };
  const checking = workbenchTaskStatus(project, runtime);
  updateTask(project, task.id, { status: 'starting' });
  resolve({ stale: false });
  const active = await checking;
  assert.equal(active.status, 'starting'); assert.equal(active.deliverableStale, null);
  updateTask(project, task.id, { status: 'completed' });
  const checkingAgain = workbenchTaskStatus(project, runtime);
  updateTask(project, task.id, { status: 'failed' });
  resolve({ stale: false });
  const changed = await checkingAgain;
  assert.equal(changed.status, 'failed'); assert.match(changed.deliverableStale, /待重新核验/);
  assert.ok(taskStatus(project).deliverableStale, 'actual missing deliverable remains stale');
});

test('worker queue is bounded and closes without leaving queued requests', async t => {
  const first = fixture(t, 2000), second = fixture(t), third = fixture(t);
  const service = createSnapshotService({ concurrency: 1, maxPending: 2 });
  const active = service.read(first.project); await waitFor(() => fs.existsSync(first.calls));
  const queued = service.read(second.project);
  await assert.rejects(service.read(third.project), /请求过多/);
  service.close();
  const results = await Promise.allSettled([active, queued]);
  assert.ok(results.every(r => r.status === 'rejected' && /关闭/.test(r.reason.message)));
});
