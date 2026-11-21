/** Cross-process, project-realpath production lock (Node built-ins only).
 *
 * acquireProductionLock(project, { command: 'ask', env: process.env }) is synchronous.
 * Hold its handle for the ENTIRE task; finally call handle.release(). Pass handle.env
 * to child CLIs. VH_PRODUCTION_LOCK_TOKEN is a random task capability, and
 * VH_PRODUCTION_LOCK_PROJECT is the canonical project path. Both must match; an
 * invalid/stale capability NEVER falls back to acquiring a fresh root lock.
 * Only the capability's SHA-256 digest is persisted. command is an action label,
 * NOT argv, a prompt, or credentials. Status/errors never expose capabilities.
 *
 * const child = spawn(bin, args, { env: lock.env, detached: true });
 * const registration = registerProductionChild(lock, child.pid, { group: true });
 * child.on('close', () => registration.unregister());
 * // Do not yield between spawn and registration. Registration is synchronous.
 * // A still-live group makes unregister() return false, retaining its evidence.
 * registerProductionChild(project, pid, { group: true, env: lock.env }) also works.
 *
 * Participants/children have separate files; all metadata transitions are guarded
 * by atomic mkdir. The directory persists between tasks, avoiding unlink/rename
 * ABA races with contenders. Interrupted metadata transactions, malformed files,
 * symlinks, and unknown files fail CLOSED and require manual inspection. A moved
 * project's otherwise valid old-path record is reclaimable only when no owner,
 * participant or child remains active; a new lock always binds the new realpath.
 * There is
 * no age-based eviction, PID killing, recursive removal, or exit-hook cleanup.
 * PID reuse and EPERM conservatively count as alive. Group tracking is POSIX-only;
 * descendants that deliberately leave a registered process group are not tracked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const PRODUCTION_LOCK_DIRECTORY = '.vh-production.lock';
export const PRODUCTION_LOCK_TOKEN_ENV = 'VH_PRODUCTION_LOCK_TOKEN';
export const PRODUCTION_LOCK_PROJECT_ENV = 'VH_PRODUCTION_LOCK_PROJECT';
const OWNER = 'owner.json';
const GUARD = '.transaction';
const handles = new WeakMap();
const registrations = new WeakMap();
const pause = new Int32Array(new SharedArrayBuffer(4));
const digest = token => createHash('sha256').update(token).digest('hex');
const pidOK = pid => Number.isSafeInteger(pid) && pid >= 1 && pid <= 2147483647;
const idOK = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const tokenOK = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
const timeOK = s => typeof s === 'string' && Number.isFinite(Date.parse(s));
const keysOK = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const label = command => {
  const first = String(command ?? 'production').trim().split(/\s+/)[0];
  return /^[a-z][a-z0-9:_-]{0,63}$/i.test(first) ? first : 'production';
};
const canonical = project => {
  const real = fs.realpathSync(project);
  if (!fs.statSync(real).isDirectory()) throw new Error('Production project must be a directory');
  return real;
};
const location = project => path.join(project, PRODUCTION_LOCK_DIRECTORY);
const invalid = () => { throw new Error('Invalid production lock metadata'); };

export class ProductionLockError extends Error {
  constructor(code, status) {
    super(`Production lock unavailable: ${status.reason}`);
    this.name = 'ProductionLockError';
    this.code = code;
    this.status = status;
  }
}
const fail = (project, reason, code = 'PRODUCTION_LOCK_BUSY') => {
  throw new ProductionLockError(code, { busy: true, reason, project });
};

function alive(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function checkDirectory(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) ||
      (process.getuid && st.uid !== process.getuid())) invalid();
}

function readJSON(file) {
  // O_NONBLOCK prevents an unexpected FIFO/device from hanging a metadata read.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || st.size > 16384 ||
        (process.getuid && st.uid !== process.getuid())) invalid();
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

function writeNew(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function writeOwner(dir, owner) {
  // A crash leaving the temporary file is deliberately not auto-repaired.
  const temp = path.join(dir, `owner-${randomUUID()}.tmp`);
  writeNew(temp, owner);
  fs.renameSync(temp, path.join(dir, OWNER));
}

function snapshot(project, guarded = false, recover = true) {
  const dir = location(project);
  checkDirectory(dir);
  const names = fs.readdirSync(dir);
  if (!guarded && names.includes(GUARD)) {
    if (!recover) return { transaction: true };
    /* 清理成功后必须重新快照，否则会把"刚刚清理掉的门"继续报成事务中。
     * 清理失败/不确定时才保持阻断。 */
    const recovered = recoverAbandonedGate(project, dir);
    if (!recovered) return { transaction: true };
    return snapshot(project, false);
  }
  if (!names.includes(OWNER)) invalid();
  const owner = readJSON(path.join(dir, OWNER));
  if (!keysOK(owner, 'version,project,token,pid,command,started,released') ||
      owner.version !== 1 || typeof owner.project !== 'string' || !path.isAbsolute(owner.project) || !pidOK(owner.pid) ||
      !tokenOK(owner.token) || !timeOK(owner.started) || label(owner.command) !== owner.command ||
      typeof owner.released !== 'boolean') invalid();
  const records = [];
  for (const name of names) {
    if (name === OWNER || (guarded && name === GUARD)) continue;
    const match = /^(participant|child)-(\d+)-([a-f0-9-]{36})\.json$/.exec(name);
    if (!match) invalid();
    const record = readJSON(path.join(dir, name));
    const fields = 'version,project,token,kind,pid,id,started' + (match[1] === 'child' ? ',group,registeredBy' : '');
    if (!keysOK(record, fields) || record.version !== 1 || record.kind !== match[1] || record.pid !== +match[2] ||
        record.id !== match[3] || !idOK(record.id) || !pidOK(record.pid) ||
        record.token !== owner.token || record.project !== owner.project || !timeOK(record.started) ||
        (record.kind === 'child' && (!pidOK(record.registeredBy) || typeof record.group !== 'boolean' ||
          (record.group && (record.pid <= 1 || process.platform === 'win32'))))) invalid();
    records.push({ ...record, name, alive: alive(record.pid, record.group === true) });
  }
  if (!guarded) {
    // Detect a concurrent completed transaction too, not just an extant gate.
    // In particular, never report an old idle generation as a new root starts.
    const after = fs.readdirSync(dir);
    if (after.includes(GUARD) || after.sort().join('\n') !== names.sort().join('\n')) return { transaction: true };
    const current = readJSON(path.join(dir, OWNER));
    if (JSON.stringify(current) !== JSON.stringify(owner)) return { transaction: true };
  }
  const ownerAlive = alive(owner.pid);
  const ownerActive = !owner.released && ownerAlive;
  const relocated = owner.project !== project;
  // Old lock records move with a project. Never accept an active foreign owner
  // or participant under a different path; it could still be writing there.
  if (relocated && (ownerActive || records.some(record => record.alive))) invalid();
  return { owner, records, ownerAlive, ownerActive, relocated };
}

function publicStatus(project, state) {
  if (state.transaction) return { busy: true, reason: 'metadata-transaction', project };
  const { owner, records, ownerAlive, ownerActive } = state;
  const participants = records.filter(r => r.kind === 'participant' && r.alive).map(r => ({ pid: r.pid }));
  const children = records.filter(r => r.kind === 'child' && r.alive).map(r => ({ pid: r.pid, group: r.group }));
  const busy = ownerActive || participants.length > 0 || children.length > 0;
  return {
    busy, reason: ownerActive ? 'owner-alive' : participants.length ? 'participant-alive' : children.length ? 'child-alive' : state.relocated ? 'relocated-idle' : 'stale',
    project, owner: { pid: owner.pid, command: owner.command, started: owner.started, released: owner.released, alive: ownerAlive, active: ownerActive },
    participants, children,
  };
}

/** Read-only, best-effort status, never a substitute for acquire(). No tokens. */
export function readProductionLock(project, { recover = true } = {}) {
  const real = canonical(project);
  const dir = location(real);
  try { fs.lstatSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return { busy: false, reason: 'unlocked', project: real };
    return { busy: true, reason: 'invalid-lock', project: real };
  }
  try { return publicStatus(real, snapshot(real, false, recover)); }
  catch { return { busy: true, reason: 'invalid-lock', project: real }; }
}

/* 仅本进程真实且仍有效的句柄能豁免自己的租约；不能通过 PID 或调用方传 true 冒充。 */
export function ownsProductionLock(handle, project) {
  const h = handles.get(handle);
  if (!h || h.released) return false;
  try {
    if (canonical(project) !== h.project) return false;
    const state = snapshot(h.project, false, false);
    return !state.transaction && state.owner.token === h.auth.hash &&
      state.records.some(record => record.id === h.participant.id && record.alive);
  } catch { return false; }
}

function guarded(project, fn) {
  const dir = location(project);
  try { checkDirectory(dir); } catch { fail(project, 'invalid-lock'); }
  const gate = path.join(dir, GUARD);
  const until = Date.now() + 500;
  for (;;) {
    try { fs.mkdirSync(gate, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') fail(project, 'invalid-lock');
      if (Date.now() >= until) fail(project, 'metadata-transaction');
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try { return fn(dir); }
  finally { fs.rmdirSync(gate); } // Only the empty gate made by this call.
}

function checkedSnapshot(project) {
  try { return snapshot(project, true); }
  catch { fail(project, 'invalid-lock'); }
}

function capability(project, env) {
  const token = env[PRODUCTION_LOCK_TOKEN_ENV];
  const inheritedProject = env[PRODUCTION_LOCK_PROJECT_ENV];
  if (token === undefined && inheritedProject === undefined) return null;
  let match = false;
  try { match = canonical(inheritedProject) === project; } catch {}
  if (!tokenOK(token) || !match) fail(project, 'invalid-delegation', 'PRODUCTION_LOCK_DELEGATION');
  return { token, hash: digest(token) };
}

function authorize(project, state, auth) {
  if (!auth || auth.hash !== state.owner.token ||
      !(state.ownerActive || state.records.some(r => r.kind === 'participant' && r.alive))) {
    fail(project, 'invalid-delegation', 'PRODUCTION_LOCK_DELEGATION');
  }
}

function recordFor(project, hash, kind, pid, extra = {}) {
  const id = randomUUID();
  return {
    version: 1, project, token: hash, kind, pid, id,
    started: new Date().toISOString(), ...extra,
  };
}
const filename = record => `${record.kind}-${record.pid}-${record.id}.json`;
function pruneDead(dir, state) {
  for (const record of state.records) {
    // Probe again immediately before deleting; EPERM/unknown is never dead.
    if (!alive(record.pid, record.group === true)) fs.unlinkSync(path.join(dir, record.name));
  }
}

/* 一个只进不出的元数据门会把项目永久锁死：进程全部退出后仍然报
 * "metadata-transaction"，用户任何操作都做不了（真实事故：强杀执行器后
 * 项目再也无法继续）。可证明的"遗弃门"才清理，条件全部满足：
 *   ① 门目录为空（不是正在写的事务，没有半截 temp 文件）；
 *   ② 所有登记进程都已退出，且有登记（空目录里凭空出现的门不算）；
 *   ③ 门存在时间超过事务上限（500ms 的 guarded 临界区早该结束）。
 * 任一不确定就保持阻断，不猜。 */
const ABANDONED_GATE_AGE_MS = 30000;
function recoverAbandonedGate(project, dir) {
  let gate;
  try {
    gate = fs.lstatSync(path.join(dir, GUARD));
    if (!gate.isDirectory() || gate.isSymbolicLink()) return false;
    const age = Date.now() - gate.mtimeMs;
    if (!Number.isFinite(age) || age < ABANDONED_GATE_AGE_MS) return false;
    if (fs.readdirSync(path.join(dir, GUARD)).length) return false;
    const names = fs.readdirSync(dir).filter(name => name !== GUARD);
    if (!names.length || !names.includes(OWNER)) return false;
    const snapshotWithoutGate = snapshot(project, true);
    /* 只拦"仍活跃"的 owner（未释放且进程活着），以及任何活着的 participant/child。
     * 已 release 的 owner 保留在登记里是正常状态，它的进程活着并不代表门有主
     * （同一进程内 acquire → release 后强杀，就是事故现场）。 */
    if (snapshotWithoutGate.ownerActive) return false;
    if (snapshotWithoutGate.records.some(record => record.alive)) return false;
    fs.rmdirSync(path.join(dir, GUARD));
    return true; // 已清理：调用方必须重新快照，得到真实状态
  } catch { return false; }
}

export function acquireProductionLock(project, { command = 'production', env = process.env } = {}) {
  const real = canonical(project);
  const dir = location(real);
  let auth = capability(real, env);
  let created = false;
  if (!auth) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } else {
    try { checkDirectory(dir); } catch { fail(real, 'invalid-delegation', 'PRODUCTION_LOCK_DELEGATION'); }
  }
  return guarded(real, () => {
    let state;
    const delegated = !!auth;
    if (created) {
      if (fs.readdirSync(dir).some(name => name !== GUARD)) fail(real, 'invalid-lock');
    } else {
      state = checkedSnapshot(real);
      if (auth) authorize(real, state, auth);
      else {
        const status = publicStatus(real, state);
        if (status.busy) throw new ProductionLockError('PRODUCTION_LOCK_BUSY', status);
        pruneDead(dir, state);
        // A failed/uncertain death probe must not be followed by a new owner.
        state = checkedSnapshot(real);
        const checked = publicStatus(real, state);
        if (checked.busy || state.records.length) throw new ProductionLockError('PRODUCTION_LOCK_BUSY', checked);
      }
    }
    if (!auth) {
      const token = randomBytes(32).toString('hex');
      auth = { token, hash: digest(token) };
      const owner = {
        version: 1, project: real, token: auth.hash, pid: process.pid,
        command: label(command), started: new Date().toISOString(), released: false,
      };
      writeOwner(dir, owner);
    }
    const participant = recordFor(real, auth.hash, 'participant', process.pid);
    writeNew(path.join(dir, filename(participant)), participant);
    const handle = {
      project: real, pid: process.pid, delegated,
      env: { ...env, [PRODUCTION_LOCK_TOKEN_ENV]: auth.token, [PRODUCTION_LOCK_PROJECT_ENV]: real },
      release() { return release(handle); },
    };
    handles.set(handle, { project: real, auth, participant, delegated, released: false });
    return handle;
  });
}

function release(handle) {
  const h = handles.get(handle);
  if (!h || h.released) return false;
  return guarded(h.project, dir => {
    const state = checkedSnapshot(h.project);
    // A stale handle must never touch a replacement task's metadata.
    if (state.owner.token !== h.auth.hash) return false;
    const own = state.records.find(r => r.id === h.participant.id && r.pid === process.pid);
    if (own) fs.unlinkSync(path.join(dir, own.name)); // Explicit withdrawal, not a liveness guess.
    if (!h.delegated && state.owner.pid === process.pid) writeOwner(dir, { ...state.owner, released: true });
    pruneDead(dir, state);
    h.released = true;
    return true;
  });
}

/** Returns {project,pid,group,unregister()}; only unregister after actual exit. */
export function registerProductionChild(handleOrProject, pid, { group = false, env = process.env } = {}) {
  if (!pidOK(pid) || (group && (pid <= 1 || process.platform === 'win32')) || typeof group !== 'boolean') {
    throw new TypeError('Invalid production child PID/process group');
  }
  const h = handles.get(handleOrProject);
  if (h?.released) fail(h.project, 'released-handle', 'PRODUCTION_LOCK_DELEGATION');
  const real = h ? h.project : canonical(handleOrProject);
  const auth = h ? h.auth : capability(real, env);
  return guarded(real, dir => {
    const state = checkedSnapshot(real);
    authorize(real, state, auth);
    const record = recordFor(real, auth.hash, 'child', pid, { group, registeredBy: process.pid });
    writeNew(path.join(dir, filename(record)), record);
    const registration = { project: real, pid, group, unregister() { return unregisterProductionChild(registration); } };
    registrations.set(registration, { project: real, auth, record });
    return registration;
  });
}

/** Idempotent; false means already unregistered, alive/unknown, or a new task. */
export function unregisterProductionChild(registration) {
  const r = registrations.get(registration);
  if (!r) return false;
  return guarded(r.project, dir => {
    const state = checkedSnapshot(r.project);
    if (state.owner.token !== r.auth.hash) return false;
    const entry = state.records.find(record => record.id === r.record.id);
    if (entry) {
      if (alive(entry.pid, entry.group)) return false;
      fs.unlinkSync(path.join(dir, entry.name));
    }
    registrations.delete(registration);
    return true;
  });
}
