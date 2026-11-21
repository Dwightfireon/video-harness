/* Serialized directly into the page: bounded callers retain every cue probe,
 * await asynchronous renderAt, and inspect real DOM after each render. */
export async function observeSubtitleBatch(samples) {
  const results = [];
  for (const { cue, time, text } of samples) {
    await window.renderAt(time);
    const state = (() => {
      const el = document.querySelector('#subbox'); if (!el) return { missing: true };
      let visible = true; for (let p = el; p instanceof Element; p = p.parentElement) {
        const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity <= 0) visible = false;
      }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        for (let p = walker.currentNode.parentElement; p instanceof Element; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.display === 'none' || s.visibility !== 'visible' || +s.opacity <= 0) visible = false;
        }
        const s = getComputedStyle(walker.currentNode.parentElement);
        const transparent = color => color === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0*)?\s*\)$/.test(color);
        if (parseFloat(s.fontSize) <= 0 || transparent(s.color) || transparent(s.webkitTextFillColor)) visible = false;
      }
      const r = el.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el);
      return { text: el.textContent, visible, lines: el.children.length || 1,
        overflow: !r.width || !r.height || el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2,
        outside: r.x < 0 || r.y < 0 || r.right > (window.W || 1920) || r.bottom > (window.H || 1080) || [...range.getClientRects()].some(t =>
          t.left < r.left - 2 || t.right > r.right + 2 || t.top < r.top - 2 || t.bottom > r.bottom + 2) };
    })();
    results.push({ cue, time, matches: !state.missing && state.text.replace(/\s/g, '') === text.replace(/\s/g, ''), ...state });
  }
  return results;
}
