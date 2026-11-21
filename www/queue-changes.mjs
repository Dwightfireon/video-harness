/* 实例级订阅，不是全局事件总线。只通知队列成员/关联变化，不认识任何面板。 */
export function createQueueChanges() {
  const listeners = new Set();
  let previous = null;
  return {
    update(items) {
      const key = JSON.stringify(items.map(item => [item.id, item.discoveryId || null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      if (key === previous) return;
      const initialized = previous !== null;
      previous = key;
      if (initialized) for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
