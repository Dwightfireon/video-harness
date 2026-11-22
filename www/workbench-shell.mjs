/* Navigation & Liquid Glass shell: never reads credentials, starts tasks, or changes project state. */
(() => {
const THEME_KEY = 'vh.ui.theme';
const THEMES = {
  dark: { label: '曜石水银', next: 'light', title: '切换到「冰川白玉」浅色液态玻璃' },
  light: { label: '冰川白玉', next: 'dark', title: '切换到「曜石水银」深色液态玻璃' },
};

const params = new URLSearchParams(window.location.search);
const IS_PANE = params.get('vh_pane') === '1' && window.parent !== window;

function readTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return 'dark';
}

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  if (!IS_PANE) {
    document.documentElement.style.background = next === 'light' ? '#f1f2f4' : '#08090c';
  }
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  const btn = document.getElementById('vhThemeSwitch');
  if (btn) {
    const meta = THEMES[next];
    btn.title = meta.title;
    btn.setAttribute('aria-label', meta.title);
    btn.setAttribute('aria-pressed', String(next === 'dark'));
    const label = btn.querySelector('.vh-theme-label');
    if (label) label.textContent = meta.label;
  }
}

if (IS_PANE) {
  document.documentElement.classList.add('vh-pane-mode');
  document.documentElement.style.background = 'transparent';
}
applyTheme(readTheme());

/* 动态注入独立液态玻璃皮肤层，保持与各页面 HTML/CSS 低耦合。 */
if (!document.querySelector('link[data-vh-liquid-glass]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/_vh/liquid-glass.css';
  link.dataset.vhLiquidGlass = '1';
  document.head.appendChild(link);
}

const icons = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  publish: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--nav-bg)"/><circle cx="15" cy="17" r="3" fill="var(--nav-bg)"/>',
};
const links = [['home', '/', '工作台'], ['publish', '/publish', '发布台'], ['settings', '/settings', '模型设置']];
const pageByPath = { '/': 'home', '/publish': 'publish', '/settings': 'settings' };
const pathByPage = { home: '/', publish: '/publish', settings: '/settings' };
const current = document.body.dataset.page;

/* ---------- 嵌入子视图模式（?vh_pane=1）：隐藏重复侧边栏，透明透出宿主 WebGL 水面 ---------- */
if (IS_PANE) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  /* 把子视图内的顶层跳转与空白处点击水波转发给宿主外壳 */
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#') || anchor.hasAttribute('download')) return;
    try {
      const targetUrl = new URL(anchor.href, window.location.href);
      if (targetUrl.origin !== window.location.origin) return;
      const targetPage = pageByPath[targetUrl.pathname];
      if (targetPage && !targetUrl.search) {
        event.preventDefault();
        window.parent.postMessage({ type: 'vh-switch-page', page: targetPage, hash: targetUrl.hash }, window.location.origin);
      } else {
        /* 项目播放器 /?p=... 或脚本文件直接在顶层打开 */
        event.preventDefault();
        window.top.location.href = targetUrl.href;
      }
    } catch {}
  });
  if (!reducedMotion) {
    const INTERACTIVE_SEL = 'a, button, input, textarea, select, label, summary, [role="tab"]';
    document.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const el = event.target instanceof Element ? event.target : null;
      if (!el || el.closest(INTERACTIVE_SEL)) return;
      const frame = window.frameElement;
      const fr = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
      window.parent.postMessage({ type: 'vh-water-drop', x: fr.left + event.clientX, y: fr.top + event.clientY, strength: 0.85 }, window.location.origin);
    }, { passive: true });
  }
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'vh-set-theme') applyTheme(event.data.theme);
    if (event.data?.type === 'vh-scroll-hash' && event.data.hash) {
      const target = document.querySelector(event.data.hash);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  return;
}

/* 原生 WebGL 物理水面波纹引擎（宿主外壳全局常驻，切页不断层、不重编译、静止 0 开销） */
function createWaterEngine() {
  let engine = null;
  let failed = false;

  const init = () => {
    if (engine || failed) return engine;
    const canvas = document.createElement('canvas');
    canvas.className = 'vh-water-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);

    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true });
    if (!gl) { canvas.remove(); failed = true; return null; }

    const vsSrc = `attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;
    const fsSrc = `
      precision mediump float;
      uniform vec2 u_res;
      uniform float u_time;
      uniform float u_light;
      uniform vec4 u_drops[6];

      float waveHeight(vec2 p) {
        float h = 0.0;
        for (int i = 0; i < 6; i++) {
          vec4 d = u_drops[i];
          if (d.w <= 0.001) continue;
          float age = u_time - d.z;
          if (age < 0.0 || age > 5.2) continue;
          float dist = length(p - d.xy);
          float speed = 240.0;
          float front = age * speed;
          float width = 76.0 + age * 28.0;
          float env = exp(-pow((dist - front) / width, 2.0));
          float decay = exp(-age * 0.58) * smoothstep(0.0, 0.14, age) * smoothstep(5.2, 3.6, age);
          float phase = (dist - front) * 0.072;
          h += sin(phase) * env * decay * d.w;
        }
        return h;
      }

      void main() {
        vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
        float eps = 3.0;
        float hc = waveHeight(p);
        float hx = waveHeight(p + vec2(eps, 0.0)) - hc;
        float hy = waveHeight(p + vec2(0.0, eps)) - hc;
        vec3 n = normalize(vec3(-hx * 16.0, -hy * 16.0, 1.0));
        vec3 lightDir = normalize(vec3(-0.42, -0.58, 0.70));
        vec3 viewDir = vec3(0.0, 0.0, 1.0);
        vec3 halfVec = normalize(lightDir + viewDir);

        float slope = length(vec2(hx, hy));
        float diffuse = max(dot(n, lightDir), 0.0) - max(dot(vec3(0.0, 0.0, 1.0), lightDir), 0.0);
        float spec = pow(max(dot(n, halfVec), 0.0), 42.0) * smoothstep(0.006, 0.045, slope);

        if (u_light > 0.5) {
          float hi = clamp(max(diffuse, 0.0) * 1.45 + spec * 0.85, 0.0, 1.0);
          float sh = clamp(max(-diffuse, 0.0) * 1.15, 0.0, 1.0);
          vec3 col = mix(vec3(0.14, 0.16, 0.20), vec3(1.0), hi / max(hi + sh, 0.001));
          float alpha = clamp((hi * 0.34 + sh * 0.14), 0.0, 0.36);
          gl_FragColor = vec4(col * alpha, alpha);
        } else {
          float hi = clamp(max(diffuse, 0.0) * 1.35 + spec * 0.92, 0.0, 1.0);
          float sh = clamp(max(-diffuse, 0.0) * 0.90, 0.0, 1.0);
          vec3 col = mix(vec3(0.02, 0.03, 0.05), vec3(0.88, 0.92, 0.98), hi / max(hi + sh, 0.001));
          float alpha = clamp((hi * 0.28 + sh * 0.22), 0.0, 0.34);
          gl_FragColor = vec4(col * alpha, alpha);
        }
      }
    `;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) { canvas.remove(); failed = true; return null; }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.remove(); failed = true; return null; }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const locPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uLight = gl.getUniformLocation(prog, 'u_light');
    const uDrops = gl.getUniformLocation(prog, 'u_drops');

    let scale = 0.5;
    const resize = () => {
      scale = Math.min(0.6, 0.5 * (window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.floor(window.innerWidth * scale));
      canvas.height = Math.max(1, Math.floor(window.innerHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize, { passive: true });

    const drops = [];
    let raf = 0;

    const render = () => {
      raf = 0;
      const nowSec = performance.now() / 1000;
      for (let i = drops.length - 1; i >= 0; i--) {
        if (nowSec - drops[i].t > 5.25) drops.splice(i, 1);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!drops.length) return;

      const flat = new Float32Array(24);
      for (let i = 0; i < Math.min(6, drops.length); i++) {
        const d = drops[i];
        flat[i * 4] = d.x * scale;
        flat[i * 4 + 1] = d.y * scale;
        flat[i * 4 + 2] = d.t;
        flat[i * 4 + 3] = d.s;
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, nowSec);
      gl.uniform1f(uLight, document.documentElement.dataset.theme === 'light' ? 1.0 : 0.0);
      gl.uniform4fv(uDrops, flat);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(render);
    };

    engine = {
      drop(x, y, elapsedMs = 0, strength = 1.0) {
        if (drops.length >= 6) drops.shift();
        drops.push({ x, y, t: performance.now() / 1000 - elapsedMs / 1000, s: strength });
        if (!raf) raf = requestAnimationFrame(render);
      },
    };
    return engine;
  };

  const warm = () => init();
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 800 });
  else setTimeout(warm, 200);

  return {
    drop(x, y, elapsedMs = 0, strength = 1.0) {
      init()?.drop(x, y, elapsedMs, strength);
    },
  };
}

if (document.body.classList.contains('workspace-page')) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const water = reducedMotion ? { drop() {} } : createWaterEngine();

  const nav = document.createElement('nav');
  nav.className = 'workspace-nav';
  nav.setAttribute('aria-label', '主导航');
  const activeTheme = THEMES[document.documentElement.dataset.theme] || THEMES.dark;
  nav.innerHTML = `<a href="/" class="workspace-brand" aria-label="映序首页"><span class="workspace-mark" aria-hidden="true"><svg viewBox="0 0 28 28" fill="none"><path d="M7 5h14v18H7zM3 9h4m14 0h4M3 19h4m14 0h4M7 14h14" stroke="currentColor" stroke-width="1.4"/><path d="m12 9 5 3-5 3z" fill="currentColor"/></svg></span><span class="workspace-wordmark">映序<small>文字与影像之间</small></span></a>
    <div><p class="nav-label">WORKSPACE</p><div class="workspace-links">${links.map(([id, href, label]) => `<a href="${href}" data-page-id="${id}"${id === current ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[id]}</svg>${label}</a>`).join('')}</div></div>
    <button type="button" id="vhThemeSwitch" class="vh-theme-switch" title="${activeTheme.title}" aria-label="${activeTheme.title}" aria-pressed="${document.documentElement.dataset.theme === 'dark'}"><span class="vh-theme-dot" aria-hidden="true"></span><span class="vh-theme-label">${activeTheme.label}</span></button>
    <div class="workspace-foot"><strong>本地工作空间</strong>由 OpenCode 驱动<br>专注内容，按自己的节奏创作。</div>`;
  document.body.prepend(nav);

  /* ---------- 常驻多视图保活容器（Keep-Alive SPA Shell） ----------
   * 左侧栏与底层 WebGL 水面永久常驻不销毁；
   * 首次切往其他标签时在后台静默加载，加载完柔和淡入（绝不露旧版白/米黄页）；
   * 之后在「工作台 / 发布台 / 模型设置」间来回切换全是 0ms 显存级瞬切，状态完整保留。 */
  const hostPage = current;
  let activePage = hostPage;
  const panes = new Map(); // pageId -> { iframe, loaded }
  let paneStage = null;

  const ensurePaneStage = () => {
    if (paneStage) return paneStage;
    paneStage = document.createElement('div');
    paneStage.className = 'vh-pane-stage';
    document.body.appendChild(paneStage);
    return paneStage;
  };

  const linkWrap = nav.querySelector('.workspace-links');
  const navItems = linkWrap ? [...linkWrap.querySelectorAll('a')] : [];
  let activeItem = navItems.find(a => a.dataset.pageId === activePage) || navItems[0];
  let glideToNav = () => {};

  const syncNavState = pageId => {
    activePage = pageId;
    for (const a of navItems) {
      if (a.dataset.pageId === pageId) {
        a.setAttribute('aria-current', 'page');
        activeItem = a;
      } else {
        a.removeAttribute('aria-current');
      }
    }
    glideToNav(activeItem);
    const titleMap = { home: '映序 · 创作空间', publish: '映序 · 发布台', settings: '映序 · 模型设置' };
    if (titleMap[pageId]) document.title = titleMap[pageId];
  };

  const revealPane = (pageId, hash = '') => {
    const isHost = pageId === hostPage;
    document.body.classList.toggle('vh-host-hidden', !isHost);
    for (const [id, entry] of panes) {
      entry.iframe.classList.toggle('is-active', id === pageId);
    }
    if (!isHost && hash) {
      panes.get(pageId)?.iframe.contentWindow?.postMessage({ type: 'vh-scroll-hash', hash }, window.location.origin);
    }
  };

  const mountPane = (pageId, { activate = false, hash = '' } = {}) => {
    if (pageId === hostPage || !pathByPage[pageId]) return null;
    let entry = panes.get(pageId);
    if (!entry) {
      const iframe = document.createElement('iframe');
      iframe.className = 'vh-pane-frame';
      iframe.title = links.find(([id]) => id === pageId)?.[2] || pageId;
      iframe.src = pathByPage[pageId] + '?vh_pane=1';
      entry = { iframe, loaded: false };
      panes.set(pageId, entry);
      iframe.addEventListener('load', () => {
        entry.loaded = true;
        iframe.classList.add('is-ready');
        try { iframe.contentWindow?.postMessage({ type: 'vh-set-theme', theme: document.documentElement.dataset.theme }, window.location.origin); } catch {}
        if (activePage === pageId) revealPane(pageId, hash);
      }, { once: true });
      ensurePaneStage().appendChild(iframe);
    }
    if (activate && entry.loaded) revealPane(pageId, hash);
    return entry;
  };

  const switchToPage = (pageId, { push = true, hash = '' } = {}) => {
    if (!pathByPage[pageId]) return;
    if (pageId === activePage) {
      if (pageId === hostPage && window.scrollY > 12) window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
      return;
    }
    syncNavState(pageId);
    if (push) {
      const nextUrl = pathByPage[pageId] + (hash || '');
      if (window.location.pathname + window.location.hash !== nextUrl) {
        try { history.pushState({ pageId }, '', nextUrl); } catch {}
      }
    }
    if (pageId === hostPage) {
      revealPane(hostPage);
    } else {
      const entry = mountPane(pageId, { activate: true, hash });
      if (entry && !entry.loaded) {
        /* 首次冷加载期间先让旧视图退隐为深色透明水面，加载完平滑淡入，绝不闪旧版米黄页 */
        document.body.classList.add('vh-host-hidden');
        for (const [id, item] of panes) item.iframe.classList.toggle('is-active', id === pageId);
      }
    }
  };

  window.addEventListener('popstate', () => {
    const target = pageByPath[window.location.pathname];
    if (target) switchToPage(target, { push: false, hash: window.location.hash });
  });

  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'vh-switch-page' && event.data.page) {
      switchToPage(event.data.page, { push: true, hash: event.data.hash || '' });
    } else if (event.data?.type === 'vh-water-drop') {
      water.drop(event.data.x, event.data.y, 0, event.data.strength || 0.85);
    }
  });

  /* 页面内指向 /publish 或 /settings 的按钮（例如「设置自动制作与发布」「去设置发布 →」）也走丝滑瞬切 */
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.closest('.workspace-nav')) return;
    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#') || anchor.hasAttribute('download')) return;
    try {
      const targetUrl = new URL(anchor.href, window.location.href);
      if (targetUrl.origin !== window.location.origin) return;
      const targetPage = pageByPath[targetUrl.pathname];
      if (targetPage && !targetUrl.search) {
        event.preventDefault();
        switchToPage(targetPage, { push: true, hash: targetUrl.hash });
      }
    } catch {}
  });

  /* 主题切换同步广播到所有已保活的子视图 */
  const toggle = nav.querySelector('#vhThemeSwitch');
  toggle?.addEventListener('click', event => {
    const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    const next = THEMES[cur].next;
    const rect = toggle.getBoundingClientRect();
    const ox = event.clientX || (rect.left + rect.width / 2);
    const oy = event.clientY || (rect.top + rect.height / 2);
    document.documentElement.classList.add('vh-theme-switching');
    applyTheme(next);
    for (const { iframe } of panes.values()) {
      try { iframe.contentWindow?.postMessage({ type: 'vh-set-theme', theme: next }, window.location.origin); } catch {}
    }
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('vh-theme-switching');
      water.drop(ox, oy, 0, 1.0);
    });
  });

  /* 侧边栏导航：点击即走 0ms 保活切换，不重载整页、不闪旧 UI、不断水波 */
  const brand = nav.querySelector('.workspace-brand');
  brand?.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    switchToPage('home');
  });

  for (const item of navItems) {
    const targetId = item.dataset.pageId;
    /* 鼠标悬停到尚未加载的标签（如模型设置）时可提前静默预载（发布台仅在点击时加载，避免提前请求 B 站接口） */
    if (targetId && targetId !== hostPage && targetId !== 'publish') {
      item.addEventListener('pointerenter', () => mountPane(targetId, { activate: false }), { once: true });
    }
    item.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (targetId) switchToPage(targetId);
    });
  }

  if (!reducedMotion) {
    /* 1. 侧边栏液态水珠滑轨（按真实时间 dt 步进，120Hz 屏幕下从容流动） */
    if (linkWrap && activeItem) {
      const pill = document.createElement('span');
      pill.className = 'vh-nav-liquid';
      pill.setAttribute('aria-hidden', 'true');
      linkWrap.prepend(pill);
      linkWrap.classList.add('vh-nav-fluid');

      let targetEl = activeItem;
      let curX = 0, curY = 0, curW = 0, curH = 0;
      let vx = 0, vy = 0, vw = 0, vh = 0;
      let springRaf = 0, lastNow = 0;
      let initialized = false;

      const measure = el => {
        const pr = linkWrap.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height };
      };

      const paintPill = (sx = 1, sy = 1) => {
        pill.style.width = curW.toFixed(2) + 'px';
        pill.style.height = curH.toFixed(2) + 'px';
        pill.style.transform = `translate3d(${curX.toFixed(2)}px, ${curY.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      };

      const snapTo = el => {
        const m = measure(el);
        curX = m.x; curY = m.y; curW = m.w; curH = m.h;
        vx = vy = vw = vh = 0;
        paintPill(1, 1);
        initialized = true;
      };

      const stepSpring = now => {
        springRaf = 0;
        if (!targetEl) return;
        const dt = lastNow ? Math.min(2.2, Math.max(0.25, (now - lastNow) / 16.667)) : 1;
        lastNow = now;
        const m = measure(targetEl);
        const k = 0.052 * dt;
        const d = Math.pow(0.82, dt);
        vx = (vx + (m.x - curX) * k) * d;
        vy = (vy + (m.y - curY) * k) * d;
        vw = (vw + (m.w - curW) * k) * d;
        vh = (vh + (m.h - curH) * k) * d;
        curX += vx * dt; curY += vy * dt; curW += vw * dt; curH += vh * dt;

        const speedY = Math.abs(vy), speedX = Math.abs(vx);
        const stretchY = 1 + Math.min(0.14, speedY * 0.018) - Math.min(0.04, speedX * 0.004);
        const stretchX = 1 + Math.min(0.10, speedX * 0.012) - Math.min(0.05, speedY * 0.006);
        paintPill(stretchX, stretchY);

        const moving = Math.abs(m.x - curX) > 0.12 || Math.abs(m.y - curY) > 0.12 ||
          Math.abs(m.w - curW) > 0.12 || Math.abs(m.h - curH) > 0.12 ||
          Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05;
        if (moving) springRaf = requestAnimationFrame(stepSpring);
        else { lastNow = 0; curX = m.x; curY = m.y; curW = m.w; curH = m.h; vx = vy = vw = vh = 0; paintPill(1, 1); }
      };

      const glideTo = el => {
        if (!el) return;
        targetEl = el;
        if (!initialized) { snapTo(el); return; }
        if (!springRaf) { lastNow = 0; springRaf = requestAnimationFrame(stepSpring); }
      };
      glideToNav = glideTo;

      snapTo(activeItem);
      requestAnimationFrame(() => snapTo(activeItem));
      window.addEventListener('resize', () => { if (targetEl) snapTo(targetEl); }, { passive: true });

      for (const item of navItems) {
        item.addEventListener('pointerenter', () => glideTo(item));
        item.addEventListener('focus', () => glideTo(item));
        item.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          glideTo(item);
          pill.classList.add('is-pressed');
          water.drop(event.clientX, event.clientY, 0, 1.0);
        });
      }
      linkWrap.addEventListener('pointermove', event => {
        if (event.pointerType === 'touch') return;
        const r = pill.getBoundingClientRect();
        pill.style.setProperty('--lx', (event.clientX - r.left).toFixed(1) + 'px');
        pill.style.setProperty('--ly', (event.clientY - r.top).toFixed(1) + 'px');
      }, { passive: true });
      linkWrap.addEventListener('pointerleave', () => {
        pill.classList.remove('is-pressed');
        glideTo(activeItem);
      });
      window.addEventListener('pointerup', () => pill.classList.remove('is-pressed'), { passive: true });
    }

    /* 2. 点击网页任意空白背景也能荡起真实的底层静水波纹（不挡输入和选字） */
    const INTERACTIVE_SEL = 'a, button, input, textarea, select, label, summary, [role="tab"], .workspace-nav';
    document.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const el = event.target instanceof Element ? event.target : null;
      if (!el || el.closest(INTERACTIVE_SEL)) return;
      water.drop(event.clientX, event.clientY, 0, 0.85);
    }, { passive: true });

    /* 3. 玻璃卡片光标镜面水光跟随 */
    const GLASS_SEL = '.newbox.composer, #list .card, .discovery-topic, .settings-page .card, .queue-body .timing-card';
    let frame = 0, lastEvent = null, activeCard = null;
    const paintGlint = () => {
      frame = 0;
      if (!lastEvent) return;
      const target = lastEvent.target instanceof Element ? lastEvent.target.closest(GLASS_SEL) : null;
      if (activeCard && activeCard !== target) {
        activeCard.style.removeProperty('--mx');
        activeCard.style.removeProperty('--my');
      }
      activeCard = target;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      target.style.setProperty('--mx', (lastEvent.clientX - rect.left).toFixed(1) + 'px');
      target.style.setProperty('--my', (lastEvent.clientY - rect.top).toFixed(1) + 'px');
    };
    document.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch') return;
      lastEvent = event;
      if (!frame) frame = requestAnimationFrame(paintGlint);
    }, { passive: true });
    document.addEventListener('pointerleave', () => {
      if (activeCard) {
        activeCard.style.removeProperty('--mx');
        activeCard.style.removeProperty('--my');
        activeCard = null;
      }
    });
  }
}
})();
