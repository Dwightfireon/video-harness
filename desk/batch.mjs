/* 批量投稿队列：纯逻辑，不依赖 Electron、B 站客户端或文件系统。
 *
 * 为什么要单独一层：批量发布是「把已经确认过的单个投稿动作重复 N 次」，
 * 判断规则必须和单条发布一致，但节奏、顺序、停止条件要单独可见、可测。
 *
 * 硬约束：
 *   - 不自动重试。任何一条失败就停下，保留已提交的结果，不猜未知状态。
 *   - 每条之间至少 MIN_INTERVAL_MS，防止连发触发风控。
 *   - 只在用户显式点了「自动发布」并给出确认后才执行。
 */

export const MIN_INTERVAL_MS = 1500;
export const MAX_INTERVAL_MS = 120000;
export const DEFAULT_INTERVAL_MS = 3000;

export function normalizeInterval(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(value * 1000)));
}

/* 队列只接受显式列出的项目 id，不去扫目录替用户决定发什么。 */
export function buildQueue(ids) {
  if (!Array.isArray(ids)) throw new Error('批量发布需要项目 id 列表');
  const seen = new Set();
  const queue = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('项目 id 不能为空');
    const key = id.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(key);
  }
  if (!queue.length) throw new Error('批量发布队列是空的');
  return queue;
}

/* 每条的结果形状与单条投稿一致，外加 index/total 供界面显示进度。 */
export function batchStep(results, id, outcome, total) {
  const entry = { index: results.length + 1, total, id, ...outcome };
  results.push(entry);
  return entry;
}

/* 停止判断：失败即停，不继续发后面的（避免同一种阻塞刷满失败记录）。 */
export function shouldStop(entry) {
  return !entry.ok;
}

export function summarize(results) {
  const ok = results.filter(item => item.ok);
  const failed = results.filter(item => !item.ok);
  return {
    submitted: ok.map(item => ({ id: item.id, bvid: item.bvid, url: item.url })),
    failed: failed.map(item => ({ id: item.id, outcome: item.outcome, message: item.message })),
    ok: failed.length === 0,
  };
}

/* 执行器：submitOne(id) 由调用方注入（主进程用它接单条投稿用例）。
 * sleep 也注入，测试不需要真的等待。 */
export async function runBatch({ ids, intervalMs = DEFAULT_INTERVAL_MS, submitOne, onStep = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), shouldCancel = () => false }) {
  const queue = buildQueue(ids);
  const wait = normalizeInterval(intervalMs / 1000);
  const results = [];
  let cancelled = false;
  for (const id of queue) {
    if (shouldCancel()) {
      // 中止不是一次"提交失败"：不写进 results，避免被当成已尝试过。
      cancelled = true;
      onStep({ id, index: results.length + 1, total: queue.length, ok: false, outcome: 'cancelled', cancelled: true });
      break;
    }
    let outcome;
    try { outcome = await submitOne(id); }
    catch (error) { outcome = { ok: false, outcome: 'unknown', message: error.message }; }
    const entry = batchStep(results, id, outcome, queue.length);
    onStep(entry);
    if (shouldStop(entry)) break;
    if (results.length < queue.length) await sleep(wait);
  }
  return { queue, results, cancelled, ...summarize(results) };
}
