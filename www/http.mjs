/* 只限制单次等待，不自动重发请求，避免超时后重复派发付费任务。 */
export async function requestJSON(url, { timeoutMs = 15000, allowErrorField = false, ...options } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = options.signal;
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data;
    try { data = await response.json(); } catch { throw new Error(`接口返回无效数据（HTTP ${response.status}）`); }
    // A successful task-status response may carry its task's error, not a transport error.
    if (!response.ok || !allowErrorField && data?.error) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    return data;
  } catch (e) {
    if (controller.signal.aborted) throw new Error('请求等待超时或已取消；未自动重试。提交类请求请先查看任务状态，避免重复提交');
    throw e;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
