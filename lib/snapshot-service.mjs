/* Bounded, read-only workbench observations. Only concurrent requests for the
 * same project share in-flight work; completed snapshots are never cached.
 * Production, verification and delivery use their own fresh strong checks. */
import { Worker } from 'node:worker_threads';

export function createSnapshotService({ concurrency = 2, timeoutMs = 30000, maxPending = 32 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isInteger(maxPending) || maxPending < concurrency) throw new Error('状态观察器配置无效');
  const slots = new Set(), pending = new Map(), queue = [];
  let closed = false, nextId = 0;
  const failure = (message, code = 503) => Object.assign(new Error(message), { statusCode: code });

  function settle(job, value, error) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (pending.get(job.key) === job) pending.delete(job.key);
    if (error) job.reject(error); else job.resolve(value);
  }
  function discard(slot, error) {
    if (slot.closed) return;
    slot.closed = true;
    const job = slot.job; slot.job = null;
    if (job) settle(job, null, error);
    // Do not start a replacement until termination has actually completed;
    // a timed-out worker may still be unwinding a synchronous probe.
    void slot.worker.terminate().catch(() => {}).finally(() => { slots.delete(slot); pump(); });
  }
  function startWorker() {
    const worker = new Worker(new URL('./snapshot-worker.mjs', import.meta.url));
    const slot = { worker, job: null, closed: false }; slots.add(slot);
    worker.on('message', message => {
      if (slot.closed) return;
      const job = slot.job;
      if (!job || message?.id !== job.id || typeof message.ok !== 'boolean') {
        discard(slot, failure('状态观察器返回异常，未认定状态有效')); return;
      }
      slot.job = null;
      settle(job, message.value, message.ok ? null : failure('项目状态读取失败，未认定状态有效'));
      // A snapshot can import arbitrary project-local timeline modules. Node's
      // ESM cache includes their transitive imports, so even unchanged mtimes
      // cannot safely prove a worker reusable after executing project code.
      // Retire it after each snapshot; delivery checks never import that code.
      if (job.kind === 'snapshot') discard(slot, failure('状态观察器已完成本次快照'));
      else pump();
    });
    worker.on('error', () => discard(slot, failure('项目状态观察器失败，请稍后重试')));
    worker.on('exit', () => discard(slot, failure('项目状态观察器意外退出，请稍后重试')));
    return slot;
  }
  function pump() {
    if (closed) return;
    while (queue.length) {
      let slot = [...slots].find(item => !item.closed && !item.job);
      if (!slot && slots.size < concurrency) {
        try { slot = startWorker(); }
        catch { settle(queue.shift(), null, failure('无法启动项目状态观察器')); continue; }
      }
      if (!slot) break;
      const job = queue.shift(); slot.job = job;
      try { slot.worker.postMessage({ id: job.id, project: job.project, kind: job.kind, mode: job.mode }); }
      catch { discard(slot, failure('项目状态观察器派发失败')); }
    }
  }
  function readRequest(project, kind, mode = '') {
      if (closed) return Promise.reject(failure('工作台已关闭'));
      const key = JSON.stringify([project, kind, mode]);
      const existing = pending.get(key);
      if (existing) return existing.promise;
      if (pending.size >= maxPending) return Promise.reject(failure('状态观察请求过多，请稍后重试', 429));
      const job = { project, kind, mode, key, id: ++nextId };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      // Bound both queue wait and execution; never return a previous success.
      job.timer = setTimeout(() => {
        const slot = [...slots].find(item => item.job === job && !item.closed);
        if (slot) discard(slot, failure('项目状态读取超时，未认定状态有效'));
        else {
          const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
          settle(job, null, failure('项目状态读取超时，未认定状态有效'));
        }
      }, timeoutMs);
      pending.set(key, job); queue.push(job); pump();
      return job.promise;
  }
  return {
    read(project) { return readRequest(project, 'snapshot'); },
    readPublication(project) { return readRequest(project, 'publication'); },
    readDelivery(project, mode) { return readRequest(project, 'delivery', ['project', 'task', 'edit-copy', 'edit-script', 'edit-visual'].includes(mode) ? mode : 'video'); },
    close() {
      if (closed) return;
      closed = true;
      for (const job of pending.values()) settle(job, null, failure('工作台已关闭'));
      queue.length = 0;
      for (const slot of slots) { slot.closed = true; void slot.worker.terminate().catch(() => {}); }
      slots.clear();
    },
  };
}
