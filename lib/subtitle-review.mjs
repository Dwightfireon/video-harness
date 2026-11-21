/* 查实际 DOM 显示内容，而不只核对完整的 SUBS/SRT 源数据。全程无声、无可见窗口。 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { observeSubtitleBatch } from './subtitle-observation.mjs';

export async function reviewSubtitles(project, { requireSubtitles = true } = {}) {
  const { chromium } = await import('playwright');
  const browser = await launchBrowser(chromium, { headless: true, args: ['--mute-audio'] });
  const errors = [], checks = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => errors.push('资源加载失败：' + r.url()));
    page.on('response', r => { if (r.status() >= 400) errors.push('资源响应失败：' + r.status() + ' ' + r.url()); });
    await page.goto(pathToFileURL(path.join(project, 'scene.html')).href);
    await page.evaluate(async () => {
      await document.fonts.ready;
      if (window.__ready) await window.__ready;
      else if (window.VH_UI?.assetsReady) await window.VH_UI.assetsReady();
      if (typeof window.renderAt !== 'function') throw new Error('缺少 renderAt');
      if ([...document.images].some(img => !img.complete || !img.naturalWidth)) throw new Error('图片未成功加载');
    });
    const size = await page.evaluate(() => ({ width: window.W, height: window.H }));
    if (![size.width, size.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('画布 W/H 无效');
    await page.setViewportSize(size);
    const subs = await page.evaluate(() => typeof SUBS !== 'undefined' ? SUBS : []);
    if (!subs.length && requireSubtitles) errors.push('没有可验证字幕');
    // A legacy silent visual project still has to execute its scene runtime.
    if (!subs.length) await page.evaluate(async () => { await window.renderAt(0); });
    const probes = [];
    for (const [i, sub] of subs.entries()) {
      const span = sub.e - sub.s;
      if (!(span > 0)) { errors.push('无效字幕区间：' + (i + 1)); continue; }
      for (const time of [sub.s + Math.min(.02, span / 4), (sub.s + sub.e) / 2, sub.e - Math.min(.02, span / 4)]) {
        probes.push({ cue: i + 1, time, text: sub.t });
      }
    }
    // One renderer round trip per bounded batch, not two per sample. Every
    // sample still awaits renderAt and measures the actual subtitle DOM.
    for (let start = 0; start < probes.length; start += 24) {
      const batch = await page.evaluate(observeSubtitleBatch, probes.slice(start, start + 24));
      checks.push(...batch);
    }
    const failures = checks.filter(c => !c.matches || !c.visible || c.overflow || c.outside);
    return { ok: !errors.length && !failures.length, cues: subs.length, probes: checks.length,
      maxLines: Math.max(0, ...checks.map(c => c.lines || 0)), errors, failures,
      note: '仅检查字幕实际显示、完整性、区间边缘与画布边界；不代替人工听检或逐字语音对齐' };
  } finally { await browser.close(); }
}
