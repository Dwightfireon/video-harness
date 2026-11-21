/* Shared, pure layout policy. DOM relationships are observed, never guessed
 * from overlap area. Call only with boxes from ONE rendered frame. */
export const LAYOUT_POLICY_VERSION = 3;

export function mergeLayoutFindings(findings) {
  const merged = new Map();
  for (const f of findings) {
    const key = [f.scene, f.kind, f.element, f.other].join('|');
    if (!merged.has(key)) merged.set(key, f);
  }
  return [...merged.values()];
}

export function settledTimes(ranges) {
  return ranges.flatMap(([a, b]) => [a + (b - a) * .55, a + (b - a) * .85]).map(t => +t.toFixed(5));
}

export function activeLayoutFrame(frame, scene) {
  const current = row => !row.scene || row.scene === scene;
  return { ...frame, texts: frame.texts.filter(current), components: frame.components.filter(current),
    decorations: (frame.decorations || []).filter(current) };
}

export function sceneSubjectCount(frame, scene, { singleScene = false } = {}) {
  const belongs = row => row.scene === scene || singleScene && !frame.declaredScenes && !row.scene;
  return [...frame.texts, ...frame.components, ...(frame.media || [])].filter(belongs).length;
}

export function textOverlaps(boxes, { minX = 12, minY = 8 } = {}) {
  const out = [];
  boxes = boxes.map(b => ({ ...b, x: Math.round(b.x), y: Math.round(b.y),
    right: Math.round(b.right ?? b.x + b.w), bottom: Math.round(b.bottom ?? b.y + b.h) }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const p = boxes[i], q = boxes[j];
    if (p.scene && q.scene && p.scene !== q.scene) continue;
    if (p.overlapGroup && p.overlapGroup === q.overlapGroup) continue;
    const ox = Math.min(p.right, q.right) - Math.max(p.x, q.x);
    const oy = Math.min(p.bottom, q.bottom) - Math.max(p.y, q.y);
    if (ox <= minX || oy <= minY) continue;
    out.push({ p, q, ox, oy, area: ox * oy });
  }
  return out.sort((a, b) => b.area - a.area);
}

export function layoutFindings(frame) {
  const { width: W, height: H, safeBottom = H, texts = [], components = [] } = frame;
  if (![W, H, safeBottom].every(Number.isFinite) || W <= 0 || H <= 0) throw new Error('无有效画布尺寸，不能判定布局');
  const findings = [];
  const add = (kind, a, msg, more = {}) => findings.push({ kind, scene: a.scene, element: a.id, text: a.text || '', msg, ...more });
  for (const a of [...texts, ...components]) {
    if (a.clipped) add('text-overflow', a, `「${a.text || a.id}」被容器裁切`);
    if (a.x < -2 || a.y < -2 || a.x + a.w > W + 2 || a.y + a.h > H + 2)
      add('out-of-canvas', a, `「${a.text || a.id}」越出画布`);
    if (a.y + a.h > safeBottom + 2 && a.y < H)
      add('into-subtitle', a, `「${a.text || a.id}」进入字幕/正文安全区底线 ${Math.round(safeBottom)}px`, { bottom: Math.round(a.y + a.h), safe: Math.round(safeBottom) });
  }
  for (const hit of textOverlaps(texts)) add('text-overlap', hit.p,
    `「${hit.p.text}」与「${hit.q.text}」文字重叠（${Math.round(hit.ox)}×${Math.round(hit.oy)}px）`, { other: hit.q.id });
  for (const tx of texts) for (const d of frame.decorations || []) {
    if (tx.scene && d.scene && tx.scene !== d.scene || tx.owner === d.id || tx.owner?.startsWith(d.id + '/') ||
        tx.overlapGroup && tx.overlapGroup === d.overlapGroup) continue;
    const ox = Math.min(tx.x + tx.w, d.x + d.w) - Math.max(tx.x, d.x);
    const oy = Math.min(tx.y + tx.h, d.y + d.h) - Math.max(tx.y, d.y);
    const inside = tx.x >= d.x - 1 && tx.y >= d.y - 1 && tx.x + tx.w <= d.x + d.w + 1 && tx.y + tx.h <= d.y + d.h + 1;
    if (ox > 6 && oy > 6 && !inside) add('text-on-frame', tx,
      `「${tx.text}」跨过独立装饰框边线`, { other: d.id });
  }
  for (let i = 0; i < components.length; i++) for (let j = i + 1; j < components.length; j++) {
    const a = components[i], b = components[j];
    if (a.scene && b.scene && a.scene !== b.scene || a.ancestors.includes(b.id) || b.ancestors.includes(a.id) ||
        a.overlapGroup && a.overlapGroup === b.overlapGroup) continue;
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 8 && oy > 8) add('component-overlap', a,
      `组件「${a.text || a.id}」与「${b.text || b.id}」重叠（${Math.round(ox)}×${Math.round(oy)}px）`, { other: b.id });
  }
  return findings;
}

/* Bounded deterministic probes; no promise of exhaustive frame coverage. Add
 * cue edges because scene-wide percentages miss later reveals. */
export function layoutTimes(ranges, cues = [], { step = 2 } = {}) {
  if (!Number.isFinite(step) || step <= 0) throw new Error('采样间隔必须大于 0');
  return ranges.flatMap(([a, b], i) => {
    if (!Number.isFinite(a + b) || b <= a) throw new Error('没有有效场景采样区间');
    const dur = b - a, values = [a + Math.min(.15, dur / 4), a + Math.min(.6, dur / 3),
      a + Math.min(2.8, dur * .35), a + dur * .55, a + dur * .85, b - Math.min(.05, dur / 4)];
    for (let t = a + step; t < b && values.length < 1000; t += step) values.push(t);
    for (const cue of cues) for (const t of [cue.s - .05, cue.s + .05, cue.e - .05]) if (t > a && t < b) values.push(t);
    return [...new Set(values.filter(t => t > a && t < b).map(t => +t.toFixed(5)).filter(t => t > a && t < b))].sort((x, y) => x - y)
      .map(t => ({ scene: i + 1, t }));
  });
}
