/* Only recorded task PIDs / detached child groups are targets. Never infer a
 * parent's process group: CLI ask may share the workbench's group. */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON } from './checkpoint.mjs';

const runPath = project => path.join(project, 'out', '.vh-run.json');
const taskPath = project => path.join(project, 'out', '.vh-task.json');
const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const validPID = pid => Number.isSafeInteger(pid) && pid > 1 && pid <= 2147483647;
const uniquePIDs = values => [...new Set(values.filter(validPID))];
const active = new Set(['starting', 'running', 'cancelling']);
const sameTask = (a, b) => !!a && !!b && a.id === b.id && a.attemptId === b.attemptId;
export const readRunMarker = project => readJSON(runPath(project));

/* Direct CLI tools have no chat task. Only the caller's immediately registered
 * child list is accepted; never infer or signal the caller's inherited group. */
export async function stopRecordedChildren(children, { graceMs = 750, killWaitMs = 1500, pollMs = 25 } = {}) {
  const targets = explicitTargets({ extraChildren: children });
  const records = [...targets.groups].map(pid => ({ pid, group: true })).concat([...targets.pids].map(pid => ({ pid, group: false })));
  if (records.some(child => child.pid === process.pid)) throw new Error('不能把当前进程当作登记子进程取消');
  for (const value of [graceMs, killWaitMs, pollMs]) if (!Number.isFinite(value) || value < 0) throw new Error('取消等待时间无效');
  const remaining = () => records.filter(child => processExists(child.pid, { group: child.group }));
  for (const [signal, wait] of [['SIGTERM', graceMs], ['SIGKILL', killWaitMs]]) {
    for (const child of remaining()) { try { process.kill(child.group ? -child.pid : child.pid, signal); } catch {} }
    const end = Date.now() + wait;
    while (remaining().length && Date.now() < end) await delay(Math.max(1, Math.min(pollMs, end - Date.now())));
    if (!remaining().length) break;
  }
  const live = remaining(); return { stopped: !live.length, remaining: live };
}

export function processExists(pid, { group = false, kill = process.kill } = {}) {
  if (!validPID(pid)) return false;
  try { kill(group ? -pid : pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM is NOT evidence of exit.
}

export function markerMatchesTask(run, task) {
  if (!run) return false;
  if (!task) return true; // Legacy marker-only execution.
  if (run.taskId) return run.taskId === task.id && (!run.attemptId || run.attemptId === task.attemptId);
  return validPID(task.pid) && run.pid === task.pid;
}

function cancellationFor(run, task) {
  const value = task?.cancellation || (markerMatchesTask(run, task) && run?.cancellation);
  if (!value) return null;
  if (task && (value.taskId !== task.id || value.attemptId !== task.attemptId)) return null;
  return value;
}

export function inspectRunProcesses(project, { task = readJSON(taskPath(project)), run = readRunMarker(project), kill = process.kill } = {}) {
  const cancellation = cancellationFor(run, task);
  const pids = uniquePIDs([run?.pid, ...(active.has(task?.status) || cancellation ? [task?.pid] : []), ...(cancellation?.pids || [])]);
  const childPids = uniquePIDs([run?.childPid, ...(cancellation?.childPids || [])]);
  const livePids = pids.filter(pid => processExists(pid, { kill }));
  // The group may outlive its leader. Checking the positive child PID is insufficient.
  const liveChildPids = childPids.filter(pid => processExists(pid, { group: true, kill }) || processExists(pid, { kill }));
  return { task, run, cancellation, pids, childPids, livePids, liveChildPids,
    alive: livePids.length > 0, orphanRunning: livePids.length === 0 && liveChildPids.length > 0,
    busy: livePids.length > 0 || liveChildPids.length > 0 };
}

/* Also safe to call after a normal exit. Never touch archives, a replacement
 * marker, or the marker of a different task/attempt. */
export function clearStoppedRun(project, expected = {}) {
  const task = readJSON(taskPath(project)), run = readRunMarker(project);
  if (!run || !markerMatchesTask(run, task)) return false;
  if ((expected.taskId && run.taskId !== expected.taskId) ||
      (expected.attemptId && run.attemptId !== expected.attemptId) ||
      (expected.pid && run.pid !== expected.pid)) return false;
  const processes = inspectRunProcesses(project, { task, run });
  const finishingSelf = expected.exitingPid === process.pid && run.pid === process.pid &&
    !processes.cancellation && task && !active.has(task.status) &&
    !processes.livePids.some(pid => pid !== process.pid) && !processes.liveChildPids.length;
  if (processes.busy && !finishingSelf) return false;
  fs.unlinkSync(runPath(project));
  return true;
}

/* Synchronous reconciliation lets a restarted server finish a cancellation
 * whose last process exited after the bounded request timed out. */
export function reconcileCancellation(project) {
  let state = inspectRunProcesses(project);
  if (!state.cancellation) {
    if (!state.busy) clearStoppedRun(project);
    return state;
  }
  if (state.busy) {
    if (!state.run && state.cancellation.marker) {
      atomicJSON(runPath(project), { ...state.cancellation.marker, cancelling: true, cancellation: state.cancellation });
      state = inspectRunProcesses(project);
    }
    return state;
  }
  const { task, run } = state;
  if (run && !markerMatchesTask(run, task)) return state;
  clearStoppedRun(project);
  const stopped = inspectRunProcesses(project);
  if (stopped.busy || stopped.run) return stopped;
  const current = readJSON(taskPath(project));
  if (sameTask(current, task)) atomicJSON(taskPath(project), { ...current, status: 'cancelled', cancellation: null,
    error: null, finishedAt: Date.now(), updatedAt: Date.now() });
  return inspectRunProcesses(project);
}

const pending = new Map();
function explicitTargets({ ownedChildGroups = [], extraChildren = [] }) {
  if (!Array.isArray(ownedChildGroups) || !Array.isArray(extraChildren)) throw new Error('取消目标必须是显式登记的进程列表');
  const groups = new Set(), pids = new Set();
  for (const pid of ownedChildGroups) {
    if (!validPID(pid)) throw new Error('ownedChildGroups 必须包含正 PGID（大于 1）');
    groups.add(pid);
  }
  for (const child of extraChildren) {
    const pid = typeof child === 'number' ? child : child?.pid;
    const group = typeof child === 'number' ? true : child?.group;
    if (!validPID(pid) || typeof group !== 'boolean') throw new Error('extraChildren 必须包含正 PGID 或 { pid, group } 记录');
    (group ? groups : pids).add(pid);
  }
  return { groups, pids };
}

/* ownedChildGroups: positive PGIDs from THIS task's registration records.
 * extraChildren accepts the same numbers, or production-lock {pid, group}
 * records. group:false signals only the exact PID. Caller supplies ownership;
 * this module never discovers processes or reads unrelated lock records. */
export function cancelTaskProcesses(project, options = {}) {
  project = path.resolve(project);
  const task = readJSON(taskPath(project));
  if ((options.taskId && options.taskId !== task?.id) || (options.attemptId && options.attemptId !== task?.attemptId)) {
    return Promise.resolve({ cancelled: false, cancelling: false, reason: 'task-changed' });
  }
  let extras;
  try { extras = explicitTargets(options); } catch (error) { return Promise.reject(error); }
  const key = JSON.stringify([project, task?.id, task?.attemptId, options.selfPid]);
  const existing = pending.get(key);
  if (existing) {
    for (const pid of extras.groups) existing.extras.groups.add(pid);
    for (const pid of extras.pids) existing.extras.pids.add(pid);
    return existing.promise;
  }
  const promise = cancelBoundProcesses(project, options, extras).finally(() => pending.delete(key));
  pending.set(key, { promise, extras });
  return promise;
}

async function cancelBoundProcesses(project, { graceMs = 750, killWaitMs = 1500, pollMs = 25, selfPid = null } = {}, extras) {
  for (const value of [graceMs, killWaitMs, pollMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('取消等待时间必须是有限的非负数');
  }
  const initial = inspectRunProcesses(project), originalTask = initial.task, originalRun = initial.run;
  if (originalRun && !markerMatchesTask(originalRun, originalTask)) {
    return { cancelled: false, cancelling: initial.busy, reason: 'marker-mismatch' };
  }
  // A completed task's historical PID is not authority to signal a process.
  if (!originalRun && !initial.cancellation && !active.has(originalTask?.status)) return { cancelled: false, cancelling: false };
  if (!originalTask && !originalRun) return { cancelled: false, cancelling: false };
  if (selfPid !== null && (selfPid !== process.pid || !initial.pids.includes(selfPid))) throw new Error('selfPid 必须是本任务的当前进程');

  const template = originalRun || initial.cancellation?.marker || { pid: originalTask?.pid || null, taskId: originalTask?.id, attemptId: originalTask?.attemptId };
  const snapshot = { taskId: originalTask?.id || originalRun?.taskId || null,
    attemptId: originalTask?.attemptId || originalRun?.attemptId || null,
    requestedAt: initial.cancellation?.requestedAt || Date.now(),
    pids: uniquePIDs([...initial.pids, ...extras.pids]), childPids: uniquePIDs([...initial.childPids, ...extras.groups]),
    marker: { pid: template.pid, taskId: template.taskId, attemptId: template.attemptId,
      childPid: template.childPid || null, startedAt: template.startedAt, mode: template.mode, label: template.label } };
  // Missing markers are restored from this snapshot while cancellation is in
  // progress: old ask versions remove their marker in their exit handler.
  const errors = [];
  const refresh = () => {
    const task = readJSON(taskPath(project)), run = readRunMarker(project);
    if (originalTask ? !sameTask(task, originalTask) : !!task) return null;
    if (run && (!markerMatchesTask(run, task) || run.pid !== template.pid || run.taskId !== template.taskId || run.attemptId !== template.attemptId)) return null;
    snapshot.pids = uniquePIDs([...snapshot.pids, ...extras.pids]);
    snapshot.childPids = uniquePIDs([...snapshot.childPids, ...extras.groups, run?.childPid, ...(task?.cancellation?.childPids || [])]);
    if (task) atomicJSON(taskPath(project), { ...task, status: 'cancelling', cancellation: snapshot, error: null, finishedAt: null, updatedAt: Date.now() });
    atomicJSON(runPath(project), { ...(run || template), cancelling: true, cancellation: snapshot });
    return inspectRunProcesses(project);
  };
  const signal = (pid, group, name) => {
    if (!group && (pid === selfPid || pid === process.pid)) return;
    // A child group containing this process cannot be a detached child of it.
    if (group && pid === process.pid) { errors.push({ pid, group, code: 'SELF_GROUP' }); return; }
    try { process.kill(group ? -pid : pid, name); }
    catch (error) {
      // Compatibility with older non-detached registered children: signal only
      // that exact PID, never its inherited (possibly server-owned) group.
      if (error.code === 'ESRCH' && group) { signal(pid, false, name); return; }
      if (error.code !== 'ESRCH') errors.push({ pid, group, code: error.code || 'UNKNOWN' });
    }
  };
  const done = state => !state.liveChildPids.length && !state.livePids.some(pid => pid !== selfPid);
  let state = refresh();
  if (!state) return { cancelled: false, cancelling: true, reason: 'task-changed' };
  for (const [name, waitMs] of [['SIGTERM', graceMs], ['SIGKILL', killWaitMs]]) {
    const sent = new Set(), deadline = Date.now() + waitMs;
    while (true) {
      state = refresh();
      if (!state) return { cancelled: false, cancelling: true, reason: 'task-changed', errors };
      if (done(state)) break;
      // Children first; the parent can then reap its direct children during grace.
      for (const pid of state.liveChildPids) if (!sent.has(-pid)) { sent.add(-pid); signal(pid, true, name); }
      for (const pid of state.livePids) if (!sent.has(pid)) { sent.add(pid); signal(pid, false, name); }
      if (Date.now() >= deadline) break;
      await delay(Math.max(1, Math.min(pollMs, deadline - Date.now())));
    }
    if (done(state)) break;
  }
  if (selfPid && done(state)) return { cancelled: false, cancelling: true, readyToExit: true, errors };
  if (state.busy) return { cancelled: false, cancelling: true, errors,
    remaining: { pids: state.livePids, childPids: state.liveChildPids } };
  state = reconcileCancellation(project);
  return { cancelled: !state.busy && !state.cancellation, cancelling: state.busy || !!state.cancellation, errors };
}
