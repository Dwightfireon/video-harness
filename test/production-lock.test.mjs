import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  acquireProductionLock, readProductionLock, registerProductionChild,
  unregisterProductionChild, PRODUCTION_LOCK_DIRECTORY, PRODUCTION_LOCK_TOKEN_ENV,
  PRODUCTION_LOCK_PROJECT_ENV,
} from '../lib/production-lock.mjs';

const moduleURL = new URL('../lib/production-lock.mjs', import.meta.url).href;
const cleanEnv = () => {
  const env = { ...process.env };
  delete env[PRODUCTION_LOCK_TOKEN_ENV];
  delete env[PRODUCTION_LOCK_PROJECT_ENV];
  delete env.NODE_TEST_CONTEXT;
  return env;
};
const workerSource = `
  import { acquireProductionLock, registerProductionChild } from ${JSON.stringify(moduleURL)};
  import { spawn } from 'node:child_process';
  const [project, command] = process.argv.slice(1);
  try {
    const lock = acquireProductionLock(project, { command });
    process.send({ type: 'ready', delegated: lock.delegated, env: {
      VH_PRODUCTION_LOCK_TOKEN: lock.env.VH_PRODUCTION_LOCK_TOKEN,
      VH_PRODUCTION_LOCK_PROJECT: lock.env.VH_PRODUCTION_LOCK_PROJECT,
    }});
    process.on('message', message => {
      if (message === 'release') { lock.release(); process.exit(0); }
      if (message === 'child') {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          env: lock.env, detached: true, stdio: 'ignore',
        });
        registerProductionChild(lock, child.pid, { group: true });
        child.unref();
        process.send({ type: 'child', pid: child.pid });
      }
    });
  } catch (error) {
    process.send({ type: 'blocked', code: error.code, status: error.status });
    process.exit(2);
  }
`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-production-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function worker(t, project, command = 'render', extraEnv = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource, project, command], {
    env: { ...cleanEnv(), ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const queue = [];
  const waiting = [];
  child.on('message', message => waiting.length ? waiting.shift()(message) : queue.push(message));
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    assert.equal(stderr, '', 'isolated child stderr');
  });
  return {
    child, exited,
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker IPC timeout: ' + stderr)), 5000);
        waiting.push(message => { clearTimeout(timer); resolve(message); });
      });
    },
    async release() { child.send('release'); await exited; },
  };
}

async function eventually(fn) {
  const end = Date.now() + 5000;
  do {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < end);
  assert.fail('Condition did not become true');
}

test('two independent CLI processes contend atomically; canonical aliases share identity', { timeout: 15000 }, async t => {
  const project = fixture(t);
  const alias = path.join(project, 'alias');
  fs.symlinkSync(project, alias);
  const a = worker(t, project, 'ask');
  const b = worker(t, alias, 'render');
  const results = await Promise.all([a.next(), b.next()]);
  assert.deepEqual(results.map(r => r.type).sort(), ['blocked', 'ready']);
  const winner = results[0].type === 'ready' ? a : b;
  const status = readProductionLock(alias);
  assert.equal(status.busy, true);
  assert.equal(status.project, fs.realpathSync(project));
  assert.equal(status.owner.pid, winner.child.pid);
  assert.equal(JSON.stringify(status).includes('token'), false);
  await winner.release();
  const next = worker(t, project);
  assert.equal((await next.next()).type, 'ready');
  await next.release();
});

test('delegated CLI gets its own participant, survives owner death, and can delegate again', { timeout: 15000 }, async t => {
  const project = fixture(t);
  const root = worker(t, project, 'ask');
  const ready = await root.next();
  const delegate = worker(t, project, 'voice', ready.env);
  const joined = await delegate.next();
  assert.equal(joined.type, 'ready');
  assert.equal(joined.delegated, true);
  root.child.kill('SIGKILL');
  await root.exited;
  assert.equal(readProductionLock(project).reason, 'participant-alive');
  const unrelated = worker(t, project);
  assert.equal((await unrelated.next()).type, 'blocked');
  const grandchild = worker(t, project, 'measure', joined.env);
  assert.equal((await grandchild.next()).type, 'ready');
  await grandchild.release();
  await delegate.release();
  const recovered = worker(t, project);
  assert.equal((await recovered.next()).type, 'ready');
  await recovered.release();
  const replay = worker(t, project, 'voice', ready.env);
  assert.equal((await replay.next()).code, 'PRODUCTION_LOCK_DELEGATION');
});

test('concurrent delegated processes keep independent participant records without lost updates', { timeout: 15000 }, async t => {
  const project = fixture(t);
  const root = worker(t, project, 'ask');
  const { env } = await root.next();
  const delegates = Array.from({ length: 8 }, () => worker(t, project, 'render', env));
  const ready = await Promise.all(delegates.map(child => child.next()));
  assert.ok(ready.every(message => message.type === 'ready' && message.delegated));
  const dir = path.join(project, PRODUCTION_LOCK_DIRECTORY);
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('participant-')).length, 9);
  await root.release();
  assert.equal(readProductionLock(project).participants.length, 8);
  await Promise.all(delegates.map(child => child.release()));
  assert.equal(readProductionLock(project).busy, false);
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('participant-')).length, 0);
});

test('different projects are independent; foreign/missing/wrong tokens never bypass a lock', async t => {
  const project = fixture(t), other = fixture(t);
  const root = worker(t, project, 'ask');
  const ready = await root.next();
  const second = worker(t, other);
  assert.equal((await second.next()).type, 'ready');
  const foreign = worker(t, other, 'voice', ready.env);
  assert.equal((await foreign.next()).code, 'PRODUCTION_LOCK_DELEGATION');
  for (const env of [
    { ...ready.env, [PRODUCTION_LOCK_TOKEN_ENV]: '0'.repeat(64) },
    { [PRODUCTION_LOCK_PROJECT_ENV]: project },
    { [PRODUCTION_LOCK_TOKEN_ENV]: ready.env[PRODUCTION_LOCK_TOKEN_ENV] },
  ]) {
    const bad = worker(t, project, 'voice', env);
    assert.equal((await bad.next()).code, 'PRODUCTION_LOCK_DELEGATION');
  }
  await root.release();
  await second.release();
});

test('项目改名恢复后只可重建已停用旧锁，仍活跃的跨路径锁必须阻断', async t => {
  const root = fixture(t), old = path.join(root, 'original'), moved = path.join(root, 'restored');
  fs.mkdirSync(old);
  const owner = acquireProductionLock(old, { command: 'test', env: {} });
  fs.renameSync(old, moved);
  assert.equal(readProductionLock(moved).busy, true, '活跃旧锁不能因路径变化被忽略');
  assert.throws(() => acquireProductionLock(moved, { env: {} }), /lock unavailable/i);
  fs.renameSync(moved, old);
  owner.release();
  fs.renameSync(old, moved);
  assert.equal(readProductionLock(moved).reason, 'relocated-idle');
  const replacement = acquireProductionLock(moved, { command: 'test', env: {} });
  assert.equal(readProductionLock(moved).busy, true);
  replacement.release();
  assert.equal(readProductionLock(moved).busy, false);
});

test('dead owner without descendants is reclaimable, but its old capability cannot create a root', async t => {
  const project = fixture(t);
  const root = worker(t, project, 'ask');
  const ready = await root.next();
  root.child.kill('SIGKILL');
  await root.exited;
  assert.equal(readProductionLock(project).busy, false);
  const stale = worker(t, project, 'voice', ready.env);
  assert.equal((await stale.next()).code, 'PRODUCTION_LOCK_DELEGATION');
  const replacement = worker(t, project);
  assert.equal((await replacement.next()).type, 'ready');
  await replacement.release();
  const empty = fixture(t);
  const absent = worker(t, empty, 'voice', { ...ready.env, [PRODUCTION_LOCK_PROJECT_ENV]: empty });
  assert.equal((await absent.next()).code, 'PRODUCTION_LOCK_DELEGATION');
  assert.equal(fs.existsSync(path.join(empty, PRODUCTION_LOCK_DIRECTORY)), false);
});

test('parent SIGKILL with registered detached child stays busy, then becomes reclaimable', { timeout: 15000 }, async t => {
  const project = fixture(t);
  const root = worker(t, project, 'ask');
  const ready = await root.next();
  root.child.send('child');
  const { pid } = await root.next();
  // Only this test's known, isolated process group is signalled.
  let groupFinished = false;
  t.after(() => { if (!groupFinished) { try { process.kill(-pid, 'SIGKILL'); } catch {} } });
  root.child.kill('SIGKILL');
  await root.exited;
  assert.equal(readProductionLock(project).reason, 'child-alive');
  const contender = worker(t, project);
  assert.equal((await contender.next()).type, 'blocked');
  const expired = worker(t, project, 'voice', ready.env);
  assert.equal((await expired.next()).code, 'PRODUCTION_LOCK_DELEGATION', 'a group alone cannot authorize new delegates');
  process.kill(-pid, 'SIGKILL');
  await eventually(() => !readProductionLock(project).busy);
  groupFinished = true;
  const recovered = worker(t, project);
  assert.equal((await recovered.next()).type, 'ready');
  await recovered.release();
});

test('a registration retained after pruning cannot remove a replacement owner or its participants', async t => {
  const project = fixture(t);
  const root = acquireProductionLock(project, { env: cleanEnv() });
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  const registration = registerProductionChild(project, child.pid, { env: root.env });
  await exited;
  root.release(); // Prunes the now-dead child, but registration is still held by the caller.
  const replacement = acquireProductionLock(project, { env: cleanEnv() });
  const dir = path.join(project, PRODUCTION_LOCK_DIRECTORY);
  const before = fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
  assert.equal(registration.unregister(), false);
  assert.equal(root.release(), false);
  assert.deepEqual(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]), before);
  replacement.release();
});

test('dead group leader with live descendants blocks release/recovery; close is not group exit', { timeout: 15000 }, async t => {
  const project = fixture(t);
  const lock = acquireProductionLock(project, { command: 'ask', env: cleanEnv() });
  const source = `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.send({ pid: c.pid });
    c.unref();
    process.disconnect();
  `;
  const leader = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(leader, 'exit');
  const registration = registerProductionChild(lock, leader.pid, { group: true });
  let groupFinished = false;
  t.after(() => { if (!groupFinished) { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} } });
  await once(leader, 'message');
  await exited;
  assert.equal(unregisterProductionChild(registration), false);
  assert.equal(lock.release(), true);
  assert.equal(readProductionLock(project).reason, 'child-alive');
  const contender = worker(t, project);
  assert.equal((await contender.next()).type, 'blocked');
  process.kill(-leader.pid, 'SIGKILL');
  await eventually(() => !readProductionLock(project).busy);
  groupFinished = true;
  assert.equal(registration.unregister(), true);
  const replacement = acquireProductionLock(project, { env: cleanEnv() });
  assert.equal(lock.release(), false);
  assert.equal(registration.unregister(), false);
  replacement.release();
});

test('same-PID handles have distinct participants; root release preserves a live delegate', t => {
  const project = fixture(t);
  const root = acquireProductionLock(project, { command: 'ask --key fixture-not-a-real-secret', env: {
    ...cleanEnv(), FIXTURE_SECRET: 'fixture-not-a-real-secret',
  } });
  const child = acquireProductionLock(project, { command: 'render', env: root.env });
  const dir = path.join(project, PRODUCTION_LOCK_DIRECTORY);
  assert.equal(fs.readdirSync(dir).filter(n => n.startsWith('participant-')).length, 2);
  for (const name of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  const disk = fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('');
  assert.equal(disk.includes(root.env[PRODUCTION_LOCK_TOKEN_ENV]), false);
  assert.equal(disk.includes('fixture-not-a-real-secret'), false);
  assert.equal(readProductionLock(project).owner.command, 'ask');
  root.release();
  assert.equal(readProductionLock(project).reason, 'participant-alive');
  assert.throws(() => acquireProductionLock(project, { env: cleanEnv() }), { code: 'PRODUCTION_LOCK_BUSY' });
  child.release();
  assert.equal(readProductionLock(project).busy, false);
});

test('malformed, incomplete, unknown and symlink metadata are preserved, not reclaimed', t => {
  for (const kind of ['bad-owner', 'missing-owner', 'unknown', 'bad-participant', 'extra-field', 'transaction', 'symlink']) {
    const project = fixture(t);
    const lock = acquireProductionLock(project, { env: cleanEnv() });
    lock.release();
    const dir = path.join(project, PRODUCTION_LOCK_DIRECTORY);
    const owner = path.join(dir, 'owner.json');
    if (kind === 'bad-owner') fs.writeFileSync(owner, '{"pid":');
    if (kind === 'missing-owner') fs.unlinkSync(owner);
    if (kind === 'unknown') fs.writeFileSync(path.join(dir, 'user-notes'), 'keep');
    if (kind === 'bad-participant') fs.writeFileSync(path.join(dir, 'participant-123-00000000-0000-0000-0000-000000000000.json'), '{}', { mode: 0o600 });
    if (kind === 'extra-field') {
      const value = JSON.parse(fs.readFileSync(owner, 'utf8'));
      fs.writeFileSync(owner, JSON.stringify({ ...value, unexpected: 'preserve' }));
    }
    if (kind === 'transaction') fs.mkdirSync(path.join(dir, '.transaction'), { mode: 0o700 });
    if (kind === 'symlink') {
      fs.renameSync(owner, path.join(project, 'saved-owner'));
      fs.symlinkSync(path.join(project, 'saved-owner'), owner);
    }
    const before = fs.readdirSync(dir).sort();
    const contents = new Map(before.filter(n => fs.lstatSync(path.join(dir, n)).isFile()).map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
    assert.equal(readProductionLock(project).busy, true, kind);
    assert.throws(() => acquireProductionLock(project, { env: cleanEnv() }), { code: 'PRODUCTION_LOCK_BUSY' });
    assert.deepEqual(fs.readdirSync(dir).sort(), before, kind);
    for (const [name, text] of contents) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), text, kind);
  }
});

test('EPERM is live, never proof that a registered child or owner exited', t => {
  const project = fixture(t);
  const lock = acquireProductionLock(project, { env: cleanEnv() });
  const registration = registerProductionChild(project, process.pid, { env: lock.env, group: false });
  const originalKill = process.kill;
  try {
    process.kill = () => { const error = new Error('fixture permission denied'); error.code = 'EPERM'; throw error; };
    assert.equal(readProductionLock(project).reason, 'owner-alive');
    assert.equal(registration.unregister(), false);
    lock.release();
    assert.equal(readProductionLock(project).reason, 'child-alive');
    assert.throws(() => acquireProductionLock(project, { env: cleanEnv() }), { code: 'PRODUCTION_LOCK_BUSY' });
  } finally { process.kill = originalKill; }
});
