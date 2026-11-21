/* Passed directly to page.evaluate. Keep self-contained: all entry points
 * observe the same text nodes, ancestor visibility, clips and component roles. */
export function collectLayoutFrame() {
  const width = window.W, height = window.H;
  if (![width, height].every(n => Number.isFinite(n) && n > 0 && n <= 8192)) throw new Error('画布 W/H 无效');
  const ignored = el => !!el.closest('#subs,#subbox,#bar,script,style') ||
    !!el.closest('[data-vh-role="decoration"]') && !el.closest('[data-vh-role="decoration"]').textContent.trim();
  const visible = el => {
    for (let p = el; p instanceof Element; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility !== 'visible' || +s.opacity <= 0) return false;
    }
    return true;
  };
  const identity = el => {
    if (el === document.documentElement) return 'html';
    const parts = [];
    for (let p = el; p && p !== document.body; p = p.parentElement)
      parts.unshift([...p.parentElement.children].indexOf(p));
    return 'body/' + parts.join('/');
  };
  const scenes = [...document.querySelectorAll('.scene')];
  const sceneOf = el => { const root = el.closest('.scene'); return root ? scenes.indexOf(root) + 1 : 0; };
  const box = r => ({ x: r.x, y: r.y, w: r.width, h: r.height });
  // Explicit named layers only; an ancestor-wide annotation cannot exempt an
  // entire scene (or all children of a card) from text collision checks.
  const group = el => el.getAttribute('data-vh-overlap') || null;
  let safeBottom = height;
  const subs = document.getElementById('subs') || document.getElementById('subbox');
  if (subs) { const r = subs.getBoundingClientRect(); if (r.height > 0 && r.top > height * .5) safeBottom = Math.min(safeBottom, r.top - 8); }
  if (typeof window.VH_UI?.safeArea === 'function') {
    const bottom = window.VH_UI.safeArea().bottom;
    if (Number.isFinite(bottom) && bottom > height * .4 && bottom <= height) safeBottom = Math.min(safeBottom, bottom);
  }
  const texts = [], components = [], decorations = [], media = [];
  const all = [...document.querySelectorAll('body *')].filter(el => !ignored(el) && visible(el));
  const transparent = color => color === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0*)?\s*\)$/.test(color);
  for (const el of all) {
    const s = getComputedStyle(el), id = identity(el), scene = sceneOf(el), r = el.getBoundingClientRect();
    let opacity = 1; const opacityGroups = [];
    for (let p = el; p instanceof Element; p = p.parentElement) {
      const alpha = +getComputedStyle(p).opacity;
      opacity *= alpha;
      if (alpha < 1) opacityGroups.push({ id: identity(p), opacity: alpha });
    }
    if (parseFloat(s.fontSize) > 0 && !transparent(s.color) && !transparent(s.webkitTextFillColor)) {
      [...el.childNodes].forEach((node, n) => {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return;
        const range = document.createRange(); range.selectNodeContents(node);
        [...range.getClientRects()].forEach((rr, line) => {
          if (rr.width < 1 || rr.height < 1) return;
          let clipped = false;
          for (let p = el; p && p !== document.body; p = p.parentElement) {
            const ps = getComputedStyle(p), pr = p.getBoundingClientRect();
            if (['hidden', 'clip', 'scroll', 'auto'].includes(ps.overflowX) && (rr.left < pr.left - 2 || rr.right > pr.right + 2) ||
                ['hidden', 'clip', 'scroll', 'auto'].includes(ps.overflowY) && (rr.top < pr.top - 2 || rr.bottom > pr.bottom + 2)) clipped = true;
          }
          texts.push({ ...box(rr), id: `${id}/text${n}/line${line}`, scene, owner: id, text: node.textContent.trim().slice(0, 60),
            color: s.color, size: parseFloat(s.fontSize), weight: +s.fontWeight, opacity, opacityGroups, clipped, overlapGroup: group(el) });
        });
      });
    }
    const isMedia = /^(IMG|VIDEO|SVG|CANVAS)$/.test(el.tagName);
    if (isMedia && r.width > 8 && r.height > 8) media.push({ id, scene });
    const panel = el.children.length > 0 && el.textContent.trim() &&
      (!transparent(s.backgroundColor) || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0);
    const declared = el.hasAttribute('data-vh-component');
    const fullBleed = r.width >= width - 6 && r.height >= height - 6;
    if (!fullBleed && !el.textContent.trim() &&
        (parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0) && r.width > 8 && r.height > 8)
      decorations.push({ ...box(r), id, scene, overlapGroup: group(el) });
    if ((isMedia || panel || declared) && !fullBleed && r.width > 8 && r.height > 8 && !el.matches('.scene,#stage')) {
      const ancestors = []; for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) ancestors.push(identity(p));
      components.push({ ...box(r), id, scene, text: el.getAttribute('data-vh-component') || el.textContent.trim().slice(0, 24), ancestors, overlapGroup: group(el) });
    }
  }
  return { width, height, safeBottom, texts, components, decorations, media, declaredScenes: scenes.length };
}

/* Serialize the exact observer, not a second implementation. Each renderAt is
 * awaited before measuring; batching only removes Node↔browser round trips. */
export const LAYOUT_BATCH_SOURCE = `async probes => {
  const collect = (${collectLayoutFrame.toString()});
  const result = [];
  for (const probe of probes) {
    await window.renderAt(probe.t);
    result.push({ ...probe, frame: collect() });
  }
  return result;
}`;
// Playwright treats a string as an expression, not an automatically invoked
// function with its argument. Compile only this trusted, module-owned source.
export const observeLayoutBatch = new Function('return (' + LAYOUT_BATCH_SOURCE + ')')();

export function layoutProbeBatches(probes, stopAfter = new Set()) {
  const batches = []; let batch = [];
  for (const probe of probes) {
    batch.push(probe);
    // Pixel contrast sampling needs the page left at this exact time.
    if (batch.length >= 24 || stopAfter.has(probe.t)) { batches.push(batch); batch = []; }
  }
  if (batch.length) batches.push(batch);
  return batches;
}
