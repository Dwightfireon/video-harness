/* One bounded browser session can serve multiple real checks of the same HTML.
 * No persisted pass cache or TTL: callers still inspect current rendered content. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';

export async function openMeasurementPage(file) {
  const { chromium } = await import('playwright');
  const browser = await launchBrowser(chromium, { headless: true, timeout: 30000 });
  const errors = [];
  const timer = setTimeout(() => { void browser.close().catch(() => {}); }, 120000);
  const close = async () => { clearTimeout(timer); await browser.close(); };
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => errors.push('资源加载失败：' + r.url()));
    page.on('response', r => { if (r.status() >= 400) errors.push('资源响应失败：' + r.status()); });
    await page.goto(pathToFileURL(file).href);
    const size = await page.evaluate(() => ({ width: window.W, height: window.H }));
    if (![size.width, size.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('画布 W/H 无效');
    await page.setViewportSize(size);
    await page.evaluate(async () => {
      await document.fonts.ready;
      if (window.__ready) await window.__ready;
      else if (window.VH_UI?.assetsReady) await window.VH_UI.assetsReady();
      if (typeof window.renderAt !== 'function') throw new Error('缺少 renderAt');
      if ([...document.images].some(img => !img.complete || !img.naturalWidth)) throw new Error('图片未成功加载');
    });
    return { page, errors, file: path.resolve(file), close };
  } catch (error) { await close(); throw error; }
}
