/* 实测对比度：在真实浏览器里渲染每一场，取文字元素的实际计算样式，
 * 并从**真实截图像素**采样它周围的底色，再按 WCAG 算对比度。
 *
 * 为什么必须实测：
 *  1) 静态读 `var(--x,#fallback)` 会误判 —— CSS 变量存在时回退值不生效。
 *     真实事故：场景写 `var(--ink,#eef1f6)` 想要浅字，引擎把 --ink 定义成深色，
 *     深字压在深卡上（1.2:1），静态检查全部放行。
 *  2) 只看 backgroundColor 也会误判 —— 纸底是渐变(backgroundImage)，
 *     backgroundColor 是透明的，会一路 fallthrough 到 body 的 #111。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openMeasurementPage } from './measurement-page.mjs';
import { contrastRatio } from './contrast.mjs';
import { collectLayoutFrame } from './layout-observation.mjs';
import { parseSceneRanges } from './state.mjs';
import { maskJS } from './js-mask.mjs';
import { settledTimes, activeLayoutFrame, sceneSubjectCount } from './layout-geometry.mjs';

const parseRgb = value => {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(String(value));
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
};
const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export function composite(fg, bg) {
  const a = fg.a ?? 1;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

/* 把截图里"字本身"的像素抹掉：字色透明、字影关掉，其余（背景/底块/边框）原样。
 * 这样采样到的是文字真正压在上面的那一层，而不是它旁边的环境。 */
const HIDE_TEXT_CSS = `*,*::before,*::after{color:transparent!important;
  -webkit-text-fill-color:transparent!important;text-shadow:none!important;
  -webkit-text-stroke-color:transparent!important}`;

/* 在页面里解码截图，并在**元素矩形内部**（文字已抹掉的版本）采样底色，取众数。
 *
 * 为什么必须在矩形内部采：
 *  真实事故，数字徽章（深字 #0d1016 写在绿底 #63c08a 上，实际 12:1 很清楚）
 *  被判成 1.1:1 —— 因为旧实现只采元素**外面**一圈像素，拿到的是卡片深底，
 *  等于把"深字压深卡"。凡是自带底色的元素（徽章、按钮、色块）全被误报。 */
const SAMPLE_FN = async ({ dataUrl, boxes, offsetX, offsetY, width, height }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const W = cv.width, H = cv.height;
  // Rectangles/origins are CSS pixels; screenshots use device pixels by default.
  // Derive the scale from this capture, including any device-pixel rounding.
  const scaleX = W / width, scaleY = H / height;
  const pixels = ctx.getImageData(0, 0, W, H).data;
  const at = (x, y) => {
    const px = Math.max(0, Math.min(W - 1, Math.round((x - offsetX) * scaleX)));
    const py = Math.max(0, Math.min(H - 1, Math.round((y - offsetY) * scaleY)));
    const at = (py * W + px) * 4;
    return { r: pixels[at], g: pixels[at + 1], b: pixels[at + 2] };
  };
  const mode = pts => {
    const buckets = new Map();
    for (const p of pts) {
      const k = (p.r >> 3) + ',' + (p.g >> 3) + ',' + (p.b >> 3);
      const cur = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n++; cur.r += p.r; cur.g += p.g; cur.b += p.b;
      buckets.set(k, cur);
    }
    let best = null;
    for (const v of buckets.values()) if (!best || v.n > best.n) best = v;
    return best ? { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) } : null;
  };
  return boxes.map(box => {
    const { x, y, w, h } = box;
    // ① 矩形内部网格：文字已抹掉，采到的就是它自己的底色（或底下的纸/卡片）
    const inner = [];
    const step = Math.max(2, Math.min(w, h) / 8);
    for (let dx = 1; dx < w; dx += step) for (let dy = 1; dy < h; dy += step) inner.push(at(x + dx, y + dy));
    const inside = mode(inner);
    if (inside) return inside;
    // ② 退化情形（元素比像素还小）：退回原来的环带采样
    const ring = [];
    for (const dx of [0.1, 0.3, 0.5, 0.7, 0.9]) ring.push(at(x + w * dx, y - 6), at(x + w * dx, y + h + 6));
    for (const dy of [0.2, 0.5, 0.8]) ring.push(at(x - 6, y + h * dy), at(x + w + 6, y + h * dy));
    return mode(ring);
  });
};

export async function sampleTextContrast(page, boxes, { t, scene } = {}) {
  if (!boxes.length) return [];
  const style = await page.addStyleTag({ content: HIDE_TEXT_CSS });
  let bgs;
  const outside = new Map();
  try {
    /* Screenshot only the union of the measured boxes plus slack for the
     * ring/inside sampling below. A full-viewport PNG of a 1080p scene is ~1.2 MB
     * and costs ~250 ms; the text union is typically 55–75% of that area and
     * measures ~1.7x faster with identical sampled colours. Playwright's clip
     * without fullPage uses viewport coordinates, just like the box rectangles;
     * adding scroll offsets would capture the wrong region (or an empty one). */
    const pad = 10;
    const { clip, viewport } = await page.evaluate(({ boxes, pad }) => {
      // Keep the whole clip inside the viewport: Playwright otherwise trims it,
      // so its actual dimensions would no longer match our sampling transform.
      const vw = window.innerWidth, vh = window.innerHeight;
      const viewport = { width: vw, height: vh };
      const xs = boxes.map(b => b.x), ys = boxes.map(b => b.y);
      const rights = boxes.map(b => b.x + b.w), bottoms = boxes.map(b => b.y + b.h);
      if (!xs.length || ![...xs, ...ys, ...rights, ...bottoms].every(Number.isFinite)) return { clip: null, viewport };
      const left = Math.floor(Math.min(...xs) - pad);
      const top = Math.floor(Math.min(...ys) - pad);
      const right = Math.ceil(Math.max(...rights) + pad);
      const bottom = Math.ceil(Math.max(...bottoms) + pad);
      if (!(right > left && bottom > top) || left < 0 || top < 0 || right > vw || bottom > vh) return { clip: null, viewport };
      return { clip: { x: left, y: top, width: right - left, height: bottom - top }, viewport };
    }, { boxes: boxes.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h })), pad });
    const sample = async () => {
      let plain, capturedClip = clip;
      if (capturedClip) {
        try {
          plain = await page.screenshot({ type: 'png', animations: 'disabled', clip });
        } catch {
          capturedClip = null;
          plain = await page.screenshot({ type: 'png', animations: 'disabled' });
        }
      } else plain = await page.screenshot({ type: 'png', animations: 'disabled' });
      return page.evaluate(SAMPLE_FN, { dataUrl: 'data:image/png;base64,' + plain.toString('base64'), boxes,
        offsetX: capturedClip ? capturedClip.x : 0, offsetY: capturedClip ? capturedClip.y : 0,
        width: capturedClip ? capturedClip.width : viewport.width,
        height: capturedClip ? capturedClip.height : viewport.height });
    };
    bgs = await sample();
    // Opacity composites a WHOLE group (including its background), not just
    // glyphs over the already-composited background. Observe the backdrop with
    // each translucent group removed, then compose inner → outer exactly once.
    for (const id of new Set(boxes.flatMap(row => (row.opacityGroups || []).map(g => g.id)))) {
      const original = await page.evaluate(id => {
        const el = id === 'html' ? document.documentElement : id.split('/').slice(1).filter(Boolean)
          .reduce((p, n) => p?.children[Number(n)], document.body);
        if (!el) throw new Error('透明分组在采样期间改变');
        const originalStyle = el.getAttribute('style');
        el.style.setProperty('opacity', '0', 'important'); return { originalStyle };
      }, id);
      try { outside.set(id, await sample()); }
      finally {
        await page.evaluate(({ id, originalStyle }) => {
          const el = id === 'html' ? document.documentElement : id.split('/').slice(1).filter(Boolean)
            .reduce((p, n) => p?.children[Number(n)], document.body);
          if (!el) throw new Error('透明分组在采样期间改变');
          if (originalStyle === null) el.removeAttribute('style'); else el.setAttribute('style', originalStyle);
        }, { id, ...original });
      }
    }
  } finally { await style.evaluate(el => el.remove()); }
  const findings = [];
  boxes.forEach((row, i) => {
    const bgSample = bgs[i], fg = parseRgb(row.color);
    if (!bgSample || !fg) throw new Error('无法核验文字色或背景像素');
    let transmission = 1;
    const contribution = { r: 0, g: 0, b: 0 };
    for (const group of row.opacityGroups || []) {
      const background = outside.get(group.id)?.[i];
      if (!background) throw new Error('透明分组缺少背景采样');
      for (const channel of ['r', 'g', 'b']) contribution[channel] += transmission * (1 - group.opacity) * background[channel];
      transmission *= group.opacity;
    }
    const opaque = Object.fromEntries(['r', 'g', 'b'].map(channel => [channel, fg[channel] * transmission + contribution[channel]]));
    const seen = composite({ ...opaque, a: fg.a }, bgSample);
    const ratio = contrastRatio(hex(seen), hex(bgSample));
    if (!Number.isFinite(ratio)) throw new Error('对比度采样无效');
    const need = row.size >= 24 || (+row.weight >= 600 && row.size >= 19) ? 3 : 4.5;
    if (ratio < need) findings.push({ kind: 'contrast-rendered', t, scene: row.scene || scene, element: row.id,
      text: row.text, color: hex(seen), background: hex(bgSample), size: row.size, ratio: +ratio.toFixed(2), need,
      msg: `第 ${row.scene || scene || '?'} 场「${row.text.slice(0, 24)}」实测对比度只有 ${ratio.toFixed(2)}:1（需 ${need}:1）—— 成片里会看不清`,
      fix: '按实际底色改字色；深色卡片上要显式给浅色字，不能靠 var(--ink) 的浅色回退值。' });
  });
  return findings;
}

export async function measureContrast(project, { at = null, session = null } = {}) {
  const scene = path.join(project, 'scene.html');
  if (!fs.existsSync(scene)) return { ok: false, findings: [], note: '没有 scene.html' };

  const html = fs.readFileSync(scene, 'utf8');
  const { ranges } = parseSceneRanges(maskJS(html));
  // 每场取后段两帧：入场动画期间透明度低，不能当最终可读性
  const times = at != null ? [Number(at)] : settledTimes(ranges);
  if (!times.length || times.some(t => !Number.isFinite(t) || !ranges.some(([a, b]) => t >= a && t < b)))
    return { ok: false, findings: [], sampled: 0, note: '没有有效场景采样时间，不能视为对比度通过' };

  if (session && session.file !== path.resolve(scene)) throw new Error('不能复用其他 HTML 的浏览器测量会话');
  const owned = !session;
  session ||= await openMeasurementPage(scene);
  const { page, errors } = session;
  const findings = [], evidence = new Map();
  let measured = 0;
  try {
    for (const t of times) {
      await page.evaluate(tt => window.renderAt(tt), t);
      const sceneNo = ranges.findIndex(([a, b]) => t >= a && t < b) + 1;
      const frame = activeLayoutFrame(await page.evaluate(collectLayoutFrame), sceneNo);
      const boxes = frame.texts;
      evidence.set(sceneNo, (evidence.get(sceneNo) || 0) + sceneSubjectCount(frame, sceneNo, { singleScene: ranges.length === 1 }));
      measured += boxes.length;
      findings.push(...await sampleTextContrast(page, boxes, { t, scene: sceneNo }));
    }
    if (errors.length) throw new Error(errors.slice(0, 3).join('；'));
    for (const [scene, count] of evidence) if (!count) findings.push({ kind: 'empty-scene', scene, text: '', color: '', background: '', element: 'scene-' + scene,
      msg: `第 ${scene} 场未观测到正文或主体，不能借用其他场/全局文字的对比度证据` });
  } finally { if (owned) await session.close(); }

  const merged = new Map();
  for (const f of findings) {
    const key = f.scene + '|' + f.element + '|' + f.color + '|' + f.background;
    const prev = merged.get(key);
    if (!prev || f.ratio < prev.ratio) merged.set(key, f);
  }
  const list = [...merged.values()].sort((a, b) => a.ratio - b.ratio);
  return { ok: list.length === 0, findings: list, sampled: times.length, measured, subjects: [...evidence.values()].reduce((a,b)=>a+b,0), sceneEvidence: Object.fromEntries(evidence),
    note: '按真实截图像素采样每个文字周围的底色；字幕层不参与测量。' };
}
