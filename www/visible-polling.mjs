/* 仅调度只读刷新：后台暂停，回到前台立即读；不缓存结果、不派发 POST。
 * 显式 refresh() 在后台也可用，同一刷新在途时只等待它，不再开一条循环。
 * 调用方负责 UI/校验与请求超时（requestJSON）。 */
export function visiblePolling(run, { intervalMs, doc = document, onError = () => {} } = {}) {
  let timer = null, active = null, disposed = false, wake = false, hidden = doc.hidden;
  const clear = () => { clearTimeout(timer); timer = null; };
  function background() { void refresh(true).catch(onError); }
  function finished() {
    active = null;
    if (disposed || doc.hidden) return;
    if (wake) { wake = false; background(); }
    else timer = setTimeout(background, intervalMs);
  }
  function refresh(automatic = false) {
    if (disposed) return Promise.resolve();
    clear();
    if (active) return active;
    active = Promise.resolve().then(() => {
      if (!disposed && (!automatic || !doc.hidden)) return run();
    }).then(
      result => { finished(); return result; },
      error => { finished(); throw error; },
    );
    return active;
  }
  function visibility() {
    if (hidden === doc.hidden) return;
    hidden = doc.hidden; clear();
    if (hidden) wake = false;
    else if (active) wake = true; // wait for the old read, then refresh without overlap
    else background();
  }
  doc.addEventListener('visibilitychange', visibility);
  if (!hidden) background();
  return { refresh: () => refresh(), dispose() { disposed = true; clear(); doc.removeEventListener('visibilitychange', visibility); } };
}
