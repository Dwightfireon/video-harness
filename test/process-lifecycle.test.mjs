import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { beginTask, readTask, updateTask, taskStatus, resumeTask } from '../lib/task-status.mjs';
import { cancelTaskProcesses, processExists, inspectRunProcesses, clearStoppedRun, readRunMarker } from '../lib/process-lifecycle.mjs';
import { startServer } from '../lib/server.mjs';
import { taskDir } from '../lib/checkpoint.mjs';
import { acquireProductionLock, registerProductionChild, PRODUCTION_LOCK_DIRECTORY } from '../lib/production-lock.mjs';

const lifecycleURL = new URL('../lib/process-lifecycle.mjs', import.meta.url).href;
const productionLockURL = new URL('../lib/production-lock.mjs', import.meta.url).href;

async function until(check, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(15); }
  throw new Error('fixture process did not reach expected state');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cancel-'));
  const project = path.join(root, 'projects', 'fixture');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(worker, `
    const fs = require('node:fs'), {spawn} = require('node:child_process');
    const [role, marker, behavior] = process.argv.slice(2);
    if (role === 'leaf') {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000); process.send({ready: true});
    } else if (role === 'leader') {
      const leaf = spawn(process.execPath, [__filename, 'leaf'], {stdio:['ignore','ignore','ignore','ipc']});
      leaf.once('message', () => process.send({leafPid: leaf.pid}));
      process.on('message', m => { if (m === 'exit') process.exit(0); });
      process.on('SIGTERM', () => { if (behavior !== 'ignore') process.exit(0); });
      setInterval(() => {}, 1000);
    } else if (role === 'parent') {
      const child = spawn(process.execPath, [__filename, 'leader', marker, behavior], {detached: true, stdio:['ignore','ignore','ignore','ipc']});
      child.once('message', m => process.send({childPid: child.pid, ...m}));
      process.on('message', async m => {
        if (m === 'leader-exit') child.send('exit'); if (m === 'exit') process.exit(0);
        if (m === 'self-cancel') {
          const {cancelTaskProcesses} = await import(${JSON.stringify(lifecycleURL)});
          const result = await cancelTaskProcesses(require('node:path').dirname(require('node:path').dirname(marker)), {selfPid: process.pid, graceMs: 30, killWaitMs: 3000});
          process.send(result);
        }
      });
      process.on('SIGTERM', () => {
        if (behavior === 'ignore') return;
        if (behavior === 'legacy-delete') { try { fs.unlinkSync(marker); } catch {} }
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    } else if (role === 'production-owner' || role === 'production-participant') {
      import(${JSON.stringify(productionLockURL)}).then(({acquireProductionLock}) => {
        const project = require('node:path').dirname(require('node:path').dirname(marker));
        acquireProductionLock(project, {command:'render'});
        process.on('message', m => { if (m === 'exit') process.exit(0); });
        setInterval(() => {}, 1000); process.send({ready:true});
      });
    } else {
      process.on('SIGTERM', () => { if (behavior !== 'ignore') process.exit(0); });
      process.on('message', m => { if (m === 'exit') process.exit(0); });
      setInterval(() => {}, 1000); process.send({ready: true});
    }
  `);
  const owned = [], groups = [];
  // No process discovery: cleanup only the fresh PIDs produced by this fixture.
  t.after(async () => {
    for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    for (const cp of owned) { try { cp.kill('SIGKILL'); } catch {} }
    await Promise.all(owned.filter(cp => cp.exitCode === null && cp.signalCode === null).map(cp => once(cp, 'exit')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function workerProcess(role = 'plain', behavior = 'normal', extraEnv = {}) {
    const cp = spawn(process.execPath, [worker, role, path.join(project, 'out/.vh-run.json'), behavior], {
      detached: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ...extraEnv, HOME: path.join(root, 'home') },
    });
    owned.push(cp);
    const [info] = await once(cp, 'message');
    if (info.childPid) groups.push(info.childPid);
    return { cp, ...info };
  }
  function bind(cp, childPid = null) {
    const task = beginTask(project, 'isolated cancellation fixture', 'edit');
    updateTask(project, task.id, { pid: cp.pid, status: 'running' }, task.attemptId);
    const marker = { pid: cp.pid, childPid, taskId: task.id, attemptId: task.attemptId };
    fs.writeFileSync(path.join(project, 'out/.vh-run.json'), JSON.stringify(marker));
    return task;
  }
  return { root, project, workerProcess, bind };
}

test('SIGTERM → grace → SIGKILL: non-detached parent and ignoring descendants; legacy deletion cannot lose ownership', { timeout: 12000 }, async t => {
  const f = fixture(t), parent = await f.workerProcess('parent', 'legacy-delete');
  const sentinel = await f.workerProcess(); // Same process group as parent / test runner.
  f.bind(parent.cp, parent.childPid);
  const archive = path.join(taskDir(f.project, 'historical'), 'task.json');
  fs.mkdirSync(path.dirname(archive), { recursive: true }); fs.writeFileSync(archive, 'historical record');
  const started = Date.now();
  const result = await cancelTaskProcesses(f.project, { graceMs: 150, killWaitMs: 3000 });
  assert.equal(result.cancelled, true, JSON.stringify(result));
  assert.equal(result.cancelling, false);
  assert.ok(Date.now() - started >= 140, 'ignoring leaf requires escalation after grace');
  assert.equal(processExists(parent.cp.pid), false);
  assert.equal(processExists(parent.childPid, { group: true }), false);
  assert.equal(processExists(parent.leafPid), false);
  assert.equal(processExists(sentinel.cp.pid), true, 'must not signal the parent/server group');
  assert.equal(readRunMarker(f.project), null);
  assert.equal(readTask(f.project).status, 'cancelled');
  assert.equal(fs.readFileSync(archive, 'utf8'), 'historical record');
});

test('group leader exited: negative-group probe still blocks dispatch and cancellation kills the recorded group', { timeout: 12000 }, async t => {
  const f = fixture(t), parent = await f.workerProcess('parent');
  const task = f.bind(parent.cp, parent.childPid);
  parent.cp.send('leader-exit');
  await until(() => !processExists(parent.childPid));
  parent.cp.send('exit'); await once(parent.cp, 'exit');
  assert.equal(processExists(parent.childPid, { group: true }), true);
  assert.equal(taskStatus(f.project).orphanRunning, true);
  assert.throws(() => beginTask(f.project, 'must not start', 'edit'), /执行进程/);
  assert.throws(() => resumeTask(f.project), /执行进程/);
  const result = await cancelTaskProcesses(f.project, { taskId: task.id, attemptId: task.attemptId, graceMs: 30, killWaitMs: 3000 });
  assert.equal(result.cancelled, true, JSON.stringify(result));
  assert.equal(processExists(parent.leafPid), false);
});

test('bounded timeout persists marker; restart/status blocks retry/new/steering until actual exit', { timeout: 12000 }, async t => {
  const f = fixture(t), parent = await f.workerProcess('parent', 'ignore');
  const task = f.bind(parent.cp, parent.childPid);
  const result = await cancelTaskProcesses(f.project, { graceMs: 0, killWaitMs: 0 });
  assert.equal(result.cancelled, false);
  assert.equal(result.cancelling, true);
  assert.ok(readRunMarker(f.project)?.cancellation);
  // Restart with a replacement recorded fixture process still alive. This
  // represents a late exit/permission-blocked process, without touching OS ACLs.
  const blocker = await f.workerProcess('plain', 'ignore');
  const current = readTask(f.project);
  const cancellation = { ...current.cancellation, pids: [blocker.cp.pid], childPids: [] };
  updateTask(f.project, task.id, { status: 'cancelled', pid: blocker.cp.pid, cancellation }, task.attemptId);
  fs.unlinkSync(path.join(f.project, 'out/.vh-run.json'));
  let providerChecks = 0;
  const servers = [];
  t.after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  async function start() {
    const server = startServer(f.project, 0, { root: f.root, home: path.join(f.root, 'home'), providerInfo: () => { providerChecks++; return []; } });
    servers.push(server); await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  const first = await start();
  assert.equal((await (await fetch(first + '/_api/chat/status')).json()).status, 'cancelling');
  assert.ok(readRunMarker(f.project), 'status restores marker removed by old parent');
  servers[0].closeAllConnections(); await new Promise(resolve => servers[0].close(resolve)); servers.shift();
  const restarted = await start();
  for (const route of ['/_api/chat/resume', '/_api/chat/retry', '/_api/chat']) {
    const response = await fetch(restarted + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'no duplicate', intent: 'new' }) });
    assert.equal(response.status, 409);
  }
  assert.equal((await fetch(restarted + '/_api/chat', { method: 'POST', body: '{"message":"no steering"}' })).status, 409);
  assert.equal(providerChecks, 0);
  blocker.cp.send('exit'); await once(blocker.cp, 'exit');
  await until(() => !processExists(parent.childPid, { group: true }) && !processExists(parent.cp.pid));
  const status = taskStatus(f.project);
  assert.equal(status.status, 'cancelled'); assert.equal(status.running, false);
  assert.equal(readRunMarker(f.project), null);
  assert.equal(status.canResume, true);
});

test('normal exit removes only the stopped matching marker; historical task PID is never a cancellation target', async t => {
  const f = fixture(t), parent = await f.workerProcess();
  const task = f.bind(parent.cp);
  assert.equal(clearStoppedRun(f.project), false);
  updateTask(f.project, task.id, { status: 'completed' }, task.attemptId);
  parent.cp.send('exit'); await once(parent.cp, 'exit');
  assert.equal(taskStatus(f.project).status, 'completed');
  assert.equal(readRunMarker(f.project), null);
  const sentinel = await f.workerProcess();
  updateTask(f.project, task.id, { pid: sentinel.cp.pid }, task.attemptId);
  assert.deepEqual(await cancelTaskProcesses(f.project), { cancelled: false, cancelling: false });
  assert.equal(processExists(sentinel.cp.pid), true);
});

test('self cancellation waits for children but retains marker until the owner itself has exited', { timeout: 12000 }, async t => {
  const f = fixture(t), parent = await f.workerProcess('parent', 'ignore');
  f.bind(parent.cp, parent.childPid);
  const reply = once(parent.cp, 'message'); parent.cp.send('self-cancel');
  const [result] = await reply;
  assert.equal(result.readyToExit, true, JSON.stringify(result));
  assert.equal(result.cancelled, false); assert.equal(result.cancelling, true);
  assert.equal(processExists(parent.cp.pid), true);
  assert.equal(processExists(parent.childPid, { group: true }), false);
  assert.equal(readTask(f.project).status, 'cancelling'); assert.ok(readRunMarker(f.project));
  parent.cp.send('exit'); await once(parent.cp, 'exit');
  assert.equal(taskStatus(f.project).status, 'cancelled'); assert.equal(readRunMarker(f.project), null);
});

test('HTTP cancel returns actual completion, without killing an unrelated task', { timeout: 12000 }, async t => {
  const f = fixture(t), parent = await f.workerProcess('parent', 'legacy-delete'), unrelated = await f.workerProcess();
  f.bind(parent.cp, parent.childPid);
  const server = startServer(f.project, 0, { root: f.root, home: path.join(f.root, 'home') });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port + '/_api/chat/cancel';
  const response = await fetch(url, { method: 'POST' });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.cancelled, true, JSON.stringify(result));
  assert.equal(result.cancelling, false); assert.equal(readRunMarker(f.project), null);
  assert.equal(processExists(unrelated.cp.pid), true);
  assert.deepEqual(await (await fetch(url, { method: 'POST' })).json(), { cancelled: false, cancelling: false });
});

test('HTTP cancellation permission failure reports cancelling and keeps the real isolated task blocked across restart', { timeout: 12000 }, async t => {
  const f = fixture(t), parent = await f.workerProcess('parent', 'ignore');
  f.bind(parent.cp, parent.childPid);
  const servers = [];
  t.after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  async function start() {
    const server = startServer(f.project, 0, { root: f.root, home: path.join(f.root, 'home') });
    servers.push(server); await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  const first = await start(), nativeKill = process.kill;
  // Fault injection is restricted to fresh fixture PIDs, never another task.
  const denied = new Set([parent.cp.pid, parent.childPid, -parent.childPid]);
  try {
    process.kill = (pid, signal) => {
      if (denied.has(pid)) throw Object.assign(new Error('fixture EPERM'), { code: 'EPERM' });
      return nativeKill(pid, signal);
    };
    const result = await (await fetch(first + '/_api/chat/cancel', { method: 'POST' })).json();
    assert.equal(result.cancelled, false); assert.equal(result.cancelling, true);
    assert.ok(result.errors.some(error => error.code === 'EPERM'));
    assert.ok(readRunMarker(f.project)); assert.equal(readTask(f.project).status, 'cancelling');
    servers[0].closeAllConnections(); await new Promise(resolve => servers[0].close(resolve)); servers.shift();
    const restarted = await start();
    assert.equal((await (await fetch(restarted + '/_api/chat/status')).json()).status, 'cancelling');
    assert.equal((await fetch(restarted + '/_api/chat/resume', { method: 'POST' })).status, 409);
  } finally { process.kill = nativeKill; }
  assert.equal((await cancelTaskProcesses(f.project, { graceMs: 20, killWaitMs: 3000 })).cancelled, true);
});

test('mismatched attempts and replacement markers are preserved and never signalled', async t => {
  const f = fixture(t), parent = await f.workerProcess(), sentinel = await f.workerProcess();
  const task = f.bind(parent.cp);
  const marker = { pid: sentinel.cp.pid, childPid: null, taskId: task.id, attemptId: 'different-attempt' };
  fs.writeFileSync(path.join(f.project, 'out/.vh-run.json'), JSON.stringify(marker));
  const before = fs.readFileSync(path.join(f.project, 'out/.vh-run.json'), 'utf8');
  assert.equal((await cancelTaskProcesses(f.project)).reason, 'marker-mismatch');
  assert.equal((await cancelTaskProcesses(f.project, { taskId: task.id, attemptId: 'stale' })).reason, 'task-changed');
  assert.equal(clearStoppedRun(f.project), false);
  assert.equal(processExists(parent.cp.pid), true); assert.equal(processExists(sentinel.cp.pid), true);
  assert.equal(fs.readFileSync(path.join(f.project, 'out/.vh-run.json'), 'utf8'), before);
  assert.equal(taskStatus(f.project).running, true);
});

test('explicit owned groups / production-lock child records persist across leader exit and bounded cancellation', { timeout: 12000 }, async t => {
  const f = fixture(t), root = await f.workerProcess(), stage = await f.workerProcess('parent'), extra = await f.workerProcess('parent');
  const task = f.bind(root.cp); // Stage groups are owned records, not marker.childPid.
  stage.cp.send('leader-exit'); extra.cp.send('leader-exit');
  await until(() => !processExists(stage.childPid) && !processExists(extra.childPid));
  const result = await cancelTaskProcesses(f.project, { taskId: task.id, attemptId: task.attemptId,
    graceMs: 0, killWaitMs: 0, ownedChildGroups: [stage.childPid],
    extraChildren: [{ pid: extra.childPid, group: true }, { pid: extra.cp.pid, group: false }] });
  assert.equal(result.cancelling, true);
  const snapshot = readTask(f.project).cancellation;
  assert.ok(snapshot.childPids.includes(stage.childPid)); assert.ok(snapshot.childPids.includes(extra.childPid));
  assert.ok(snapshot.pids.includes(extra.cp.pid));
  await until(() => !processExists(stage.childPid, { group: true }) && !processExists(extra.childPid, { group: true }));
  assert.equal(taskStatus(f.project).status, 'cancelled');
  assert.equal(processExists(stage.cp.pid), true, 'unlisted parent/participant is never swept');
  await assert.rejects(cancelTaskProcesses(f.project, { ownedChildGroups: [-stage.childPid] }), /正 PGID/);
});

test('permission errors and unknown probe failures are not proof of death (PID and group)', () => {
  for (const group of [false, true]) {
    for (const code of ['EPERM', 'EACCES', 'UNKNOWN', 'ESRCH']) {
      const kill = (pid, signal) => { assert.equal(pid, group ? -12345 : 12345); assert.equal(signal, 0); throw Object.assign(new Error('fixture'), { code }); };
      assert.equal(processExists(12345, { group, kill }), code !== 'ESRCH');
    }
  }
  assert.equal(inspectRunProcesses('/does-not-exist', { task: null, run: { pid: -1, childPid: 0 } }).busy, false);
});

test('production status ignores only our own owner/participant; other participants and child groups still block', { timeout: 12000 }, async t => {
  const f = fixture(t), lock = acquireProductionLock(f.project, { command: 'ask', env: {} });
  const participant = acquireProductionLock(f.project, { command: 'render', env: lock.env });
  try {
    assert.equal(taskStatus(f.project).productionBusy, false);
    assert.equal(taskStatus(f.project).running, false);
    const task = beginTask(f.project, 'own owner must not deadlock ask', 'edit');
    updateTask(f.project, task.id, { status: 'completed' }, task.attemptId);
    const other = await f.workerProcess('production-participant', 'normal', lock.env);
    assert.equal(taskStatus(f.project).productionBusy, true);
    assert.equal(taskStatus(f.project).running, true);
    assert.throws(() => beginTask(f.project, 'blocked by other participant', 'edit'), /执行进程/);
    other.cp.send('exit'); await once(other.cp, 'exit');
    assert.equal(taskStatus(f.project).productionBusy, false);
    const stage = await f.workerProcess('parent');
    const registration = registerProductionChild(lock, stage.childPid, { group: true });
    stage.cp.send('leader-exit'); await until(() => !processExists(stage.childPid));
    assert.equal(registration.unregister(), false, 'leader exit cannot unregister surviving group');
    assert.equal(taskStatus(f.project).productionBusy, true);
    process.kill(-stage.childPid, 'SIGKILL');
    await until(() => !processExists(stage.childPid, { group: true }));
    assert.equal(registration.unregister(), true);
    assert.equal(taskStatus(f.project).productionBusy, false);
  } finally { participant.release(); lock.release(); }
  assert.ok(fs.existsSync(path.join(f.project, PRODUCTION_LOCK_DIRECTORY)), 'lifecycle never removes the shared lock directory');
});

test('direct CLI without a chat task blocks HTTP dispatch, deletion, cleaning and format; cancel does not kill it', { timeout: 12000 }, async t => {
  const f = fixture(t), owner = await f.workerProcess('production-owner');
  const status = taskStatus(f.project);
  assert.equal(status.taskId, null); assert.equal(status.taskRunning, false);
  assert.equal(status.productionBusy, true); assert.equal(status.running, true);
  assert.match(status.label, /命令行正在制作/); assert.equal(status.error.kind, 'production');
  const server = startServer(f.project, 0, { root: f.root, home: path.join(f.root, 'home'), providerInfo: () => [] });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['/_api/chat', '/_api/chat/resume', '/_api/chat/retry', '/_api/clean', '/_api/remove?p=projects%2Ffixture', '/_api/format', '/_api/publish/target']) {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'do not dispatch', intent: 'new', aspectRatio: '9:16', target: 'video' }) });
    assert.equal(response.status, 409, route);
  }
  assert.equal((await fetch(url + '/_api/chat', { method: 'POST', body: '{"message":"not a steering target"}' })).status, 409);
  const cancelled = await (await fetch(url + '/_api/chat/cancel', { method: 'POST' })).json();
  assert.equal(cancelled.cancelled, false); assert.equal(cancelled.productionBusy, true);
  assert.equal(processExists(owner.cp.pid), true);
  assert.equal(readTask(f.project), null); assert.ok(fs.existsSync(f.project));
  owner.cp.send('exit'); await once(owner.cp, 'exit');
  assert.equal(taskStatus(f.project).productionBusy, false);
  assert.ok(fs.existsSync(path.join(f.project, PRODUCTION_LOCK_DIRECTORY)));
});

test('bad production metadata and metadata transactions fail closed even for our own owner', t => {
  const f = fixture(t), lock = acquireProductionLock(f.project, { command: 'ask', env: {} });
  const dir = path.join(f.project, PRODUCTION_LOCK_DIRECTORY), transaction = path.join(dir, '.transaction');
  try {
    fs.mkdirSync(transaction, { mode: 0o700 });
    assert.equal(taskStatus(f.project).productionBusy, true);
    assert.equal(taskStatus(f.project).productionLock.reason, 'metadata-transaction');
    assert.throws(() => beginTask(f.project, 'blocked by transaction', 'edit'), /执行进程/);
    fs.rmdirSync(transaction);
    assert.equal(taskStatus(f.project).productionBusy, false);
  } finally { lock.release(); }
  fs.writeFileSync(path.join(dir, 'owner.json'), '{broken', { mode: 0o600 });
  const status = taskStatus(f.project);
  assert.equal(status.productionBusy, true); assert.equal(status.productionLock.reason, 'invalid-lock');
  assert.equal(status.running, true);
});
