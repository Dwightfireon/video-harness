/* Navigation only: never reads credentials, starts tasks, or changes project state. */
const icons = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  publish: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--nav-bg)"/><circle cx="15" cy="17" r="3" fill="var(--nav-bg)"/>',
};
const links = [['home', '/', '工作台'], ['publish', '/publish', '发布台'], ['settings', '/settings', '模型设置']];
const current = document.body.dataset.page;
if (document.body.classList.contains('workspace-page')) {
  const nav = document.createElement('nav');
  nav.className = 'workspace-nav';
  nav.setAttribute('aria-label', '主导航');
  nav.innerHTML = `<a href="/" class="workspace-brand" aria-label="映序首页"><span class="workspace-mark" aria-hidden="true"><svg viewBox="0 0 28 28" fill="none"><path d="M7 5h14v18H7zM3 9h4m14 0h4M3 19h4m14 0h4M7 14h14" stroke="currentColor" stroke-width="1.4"/><path d="m12 9 5 3-5 3z" fill="currentColor"/></svg></span><span class="workspace-wordmark">映序<small>文字与影像之间</small></span></a>
    <div><p class="nav-label">WORKSPACE</p><div class="workspace-links">${links.map(([id, href, label]) => `<a href="${href}"${id === current ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[id]}</svg>${label}</a>`).join('')}</div></div>
    <div class="workspace-foot"><strong>本地工作空间</strong>由 OpenCode 驱动<br>专注内容，按自己的节奏创作。</div>`;
  document.body.prepend(nav);
}
