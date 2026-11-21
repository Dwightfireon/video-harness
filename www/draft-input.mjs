/* 只在用户勾选后存入当前浏览器；不上传，不保存渠道凭证，不自动发送。 */
export function attachDraft({ key, input, checkbox, status, getMeta = () => ({}), restoreMeta = () => {}, storage, maxChars = 200000 }) {
  let timer = null, disposed = false;
  const store = () => storage || globalThis.localStorage;
  const notice = text => { if (status) status.textContent = text; };
  const remove = () => { try { store().removeItem(key); return true; } catch { notice('浏览器不允许操作草稿存储；当前输入仍保留在页面中。'); return false; } };
  function flush() {
    clearTimeout(timer);
    if (disposed || !checkbox.checked) return;
    const text = input.getValue();
    if (text.length > maxChars) { notice(`草稿超过 ${maxChars} 字，未保存新版本；当前输入仍保留，请自行备份。`); return; }
    if (!text) { if (remove()) notice('未发送草稿为空；本机已存内容已清除。'); return; }
    try {
      store().setItem(key, JSON.stringify({ version: 1, text, meta: getMeta(), savedAt: Date.now() }));
      notice('草稿已保存在此浏览器，刷新可恢复；不会自动提交。');
    } catch { notice('草稿未能保存（存储不可用或空间不足）；当前输入仍保留，请自行备份。'); }
  }
  const schedule = () => { clearTimeout(timer); if (checkbox.checked) timer = setTimeout(flush, 350); };
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) flush();
    else { clearTimeout(timer); if (remove()) notice('本机草稿已清除，页面输入未删除；未开启自动保存。'); }
  });
  try {
    const raw = store().getItem(key), saved = raw ? JSON.parse(raw) : null;
    if (saved?.version === 1 && typeof saved.text === 'string' && saved.text.length <= maxChars && saved.meta && typeof saved.meta === 'object') {
      checkbox.checked = true; restoreMeta(saved.meta); input.setValue(saved.text);
      notice('已恢复此浏览器的未发送草稿；请检查后手动提交。');
    } else notice('未开启草稿保存；刷新或关闭页面前请自行备份输入。');
  } catch { notice('无法读取本机草稿；当前输入未受影响，可继续编辑。'); }
  globalThis.addEventListener?.('pagehide', flush);
  return { schedule, flush, clear() { clearTimeout(timer); if (remove()) notice('已提交的本机草稿已清除。'); },
    dispose() { clearTimeout(timer); disposed = true; globalThis.removeEventListener?.('pagehide', flush); } };
}
