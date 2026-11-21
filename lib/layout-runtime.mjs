/* Opt-in content-driven layout. No rewriting existing scenes or clipping text
 * to manufacture a pass. CSS handles font loading and multiline measurements. */
function layoutRuntime() {
  function create(root, options, columns) {
    const { x, y, w, bottom = window.VH_UI?.safeArea?.().bottom ?? window.H, gap = 20, id = '' } = options;
    if (!(root instanceof Element) || ![x, y, w, bottom, gap].every(Number.isFinite) || w <= 0 || bottom <= y || gap < 0 ||
        !Number.isInteger(columns) || columns < 1 || columns > 12) throw new Error('VH_LAYOUT：布局参数无效');
    const el = document.createElement('div');
    if (id) el.setAttribute('data-vh-component', id);
    Object.assign(el.style, { position: 'absolute', left: x + 'px', top: y + 'px', width: w + 'px',
      display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: gap + 'px',
      alignItems: 'start', boxSizing: 'border-box', overflow: 'visible' });
    root.appendChild(el);
    const api = {
      el,
      add(child, { id: childId = '', minHeight = 0 } = {}) {
        if (!(child instanceof Element) || !Number.isFinite(minHeight) || minHeight < 0) throw new Error('VH_LAYOUT：需要元素和有效 minHeight');
        if (childId) child.setAttribute('data-vh-component', childId);
        Object.assign(child.style, { position: 'relative', left: 'auto', top: 'auto', right: 'auto', bottom: 'auto',
          width: '100%', height: 'auto', minWidth: '0', minHeight: minHeight + 'px', boxSizing: 'border-box',
          whiteSpace: 'normal', overflowWrap: 'anywhere' });
        el.appendChild(child);
        return child;
      },
      measure() {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, limit: bottom, ok: r.bottom <= bottom + 2 };
      },
      assertFits() {
        const measured = api.measure();
        if (!measured.ok) throw new Error(`VH_LAYOUT：${id || '容器'}底边 ${Math.round(measured.bottom)} 超过安全线 ${Math.round(bottom)}；需调整布局或分步展示，不得裁字`);
        return measured;
      },
    };
    return api;
  }
  window.VH_LAYOUT = Object.freeze({ version: 1,
    flow: (root, options) => create(root, options, 1),
    grid: (root, options) => create(root, options, options.columns ?? 2) });
}

export const LAYOUT_RUNTIME = '/* vh:layout-runtime */\n(' + layoutRuntime.toString() + ')();\n/* vh:layout-runtime-end */\n';

export function injectLayoutRuntime(html) {
  html = html.replace(/\/\* vh:layout-runtime \*\/[\s\S]*?\/\* vh:layout-runtime-end \*\/\s*/g, '');
  const anchor = html.indexOf('const scenes = [];');
  if (anchor < 0) return html; // Unknown custom generators are not rewritten.
  return html.slice(0, anchor) + LAYOUT_RUNTIME + html.slice(anchor);
}
