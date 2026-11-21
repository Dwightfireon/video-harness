/* 提交/继续失败的持久提示：轮询不能把它清掉，用户也不会只看到一秒。
 * 纯函数，记录与当前任务身份无关；成功提交或显式关闭时才移除。 */
const listeners = new Set();
let failure = null;

export function chatSubmitFailure() { return failure; }

export function recordChatSubmitFailure({ title, message, stopped = false } = {}) {
  failure = { title: String(title || '操作未完成'), message: String(message || ''), stopped: Boolean(stopped), at: Date.now() };
  for (const listener of listeners) { try { listener(failure); } catch {} }
  return failure;
}

export function clearChatSubmitFailure(reason = 'success') {
  if (!failure) return;
  failure = null;
  for (const listener of listeners) { try { listener(null, reason); } catch {} }
}

export function subscribeChatSubmitFailure(listener) {
  listeners.add(listener);
  listener(failure);
  return () => listeners.delete(listener);
}

/* 失败区不再兼作任务状态/断连展示；轮询只写状态区，失败区只由提交结果控制。 */
export function renderChatSubmitFailure(el, value = failure) {
  if (!el) return;
  if (value?.message) {
    el.textContent = value.title + '：' + value.message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}
