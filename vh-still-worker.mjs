/* vh-still-worker.mjs —— server.mjs 的静帧后台工作进程
 *   node vh-still-worker.mjs <project> <sceneCount>
 * 与 vh.mjs stills 相同：每场渲染中点一帧 JPEG 到 out/stills/s-XX.jpg
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const [project, countArg] = process.argv.slice(2);
const count = parseInt(countArg, 10);
if (!project || !count) process.exit(1);

const { chromium } = await import('playwright').catch(() => ({ }));
if (!chromium) process.exit(3);
/* 与 CLI 共用本机 Chrome、沙箱及临时资料目录策略。 */
const stillArgs = ['--force-color-profile=srgb', '--use-gl=angle', '--use-angle=metal',
  '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-lcd-text'];
const browser = await launchBrowser(chromium, { headless: true, args: stillArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(project, 'scene.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const W = await page.evaluate(() => window.W || 1920);
  const H = await page.evaluate(() => window.H || 1080);
  if (W !== 1920 || H !== 1080) await page.setViewportSize({ width: W, height: H });
  const outDir = path.join(project, 'out', 'stills');
  fs.mkdirSync(outDir, { recursive: true });
  const src = fs.readFileSync(path.join(project, 'scene.html'), 'utf8');
  const ranges = [...src.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);
  for (let i = 0; i < Math.min(count, ranges.length); i++) {
    const [a, b] = ranges[i];
    const mid = Math.round(((a + b) / 2) * 10) / 10;
    await page.evaluate(t => window.renderAt(t), mid);
    await page.waitForTimeout(40);
    await page.screenshot({
      path: path.join(outDir, `s-${String(i + 1).padStart(2, '0')}.jpg`),
      type: 'jpeg', quality: 88, animations: 'disabled',
    });
  }
} finally {
  await browser.close();
}
