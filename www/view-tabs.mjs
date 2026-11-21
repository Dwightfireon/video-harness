/* 只切换已有视图，不读取业务状态，也不销毁输入与组件。 */
export function attachViewTabs(root) {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const panels = new Map(tabs.map(tab => [tab.getAttribute('aria-controls'), root.querySelector('#' + tab.getAttribute('aria-controls'))]));
  const listeners = [];
  function select(id, { focus = false } = {}) {
    if (!panels.get(id)) return false;
    for (const tab of tabs) {
      const selected = tab.getAttribute('aria-controls') === id;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      panels.get(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    return true;
  }
  tabs.forEach((tab, index) => {
    const click = () => select(tab.getAttribute('aria-controls'));
    const keydown = event => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
      if (next == null) return;
      event.preventDefault(); select(tabs[next].getAttribute('aria-controls'), { focus: true });
    };
    tab.addEventListener('click', click); tab.addEventListener('keydown', keydown);
    listeners.push(() => { tab.removeEventListener('click', click); tab.removeEventListener('keydown', keydown); });
  });
  const active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true') || tabs[0];
  if (active) select(active.getAttribute('aria-controls'));
  return { select, dispose() { listeners.forEach(remove => remove()); } };
}
