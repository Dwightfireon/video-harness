/* Shared preview setup for actual stills. Load the original scene URL so all
 * relative resources keep their meaning; never edit the generated scene.html. */
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';

export async function openPreviewPage(scenePath) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('node 解析不到 playwright —— 请先准备项目依赖'); }
  const browser = await launchBrowser(chromium, {
    headless: true,
    args: ['--force-color-profile=srgb', '--use-gl=angle', '--use-angle=metal',
      '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-lcd-text'],
  });
  // A custom asset barrier can otherwise leave the background task hanging.
  const timer = setTimeout(() => { void browser.close().catch(() => {}); }, 120000);
  const close = async () => { clearTimeout(timer); await browser.close(); };
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(scenePath).href);
    await page.evaluate(() => document.fonts.ready);
    // A known failed readiness barrier is not a successful preview. Unknown
    // custom engines may have no barrier; generation still isn't a review.
    await page.evaluate(async () => {
      if (window.__ready) await window.__ready;
      else if (window.VH_UI?.assetsReady) await window.VH_UI.assetsReady({ strict: true, timeout: 12000 });
    });
    await page.waitForTimeout(200);
    const [width, height] = await page.evaluate(() => [window.W || 1920, window.H || 1080]);
    if (width !== 1920 || height !== 1080) await page.setViewportSize({ width, height });
    return { page, close };
  } catch (error) { await close(); throw error; }
}
