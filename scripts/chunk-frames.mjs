// 分块截图：每块重启浏览器，规避长片连续截图导致渲染进程内存耗尽。
// 只负责把帧写进 out/frames，不编码、不动 scene.html。编码交给 render.mjs --encode-only。
// 用法：node scripts/chunk-frames.mjs <项目目录> [--from 帧号] [--to 帧号] [--chunk 4000]
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const project = process.argv[2];
if (!project) { console.error('用法：node scripts/chunk-frames.mjs <项目目录> [--from n] [--to n] [--chunk n]'); process.exit(2); }
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

const sceneHtml = path.resolve(project, 'scene.html');
const frames = path.resolve(project, 'out/frames');
const FPS = 30, CHUNK = Number(arg('chunk', 3000));
fs.mkdirSync(frames, { recursive: true });

const { launchBrowser, closeLaunchedBrowsers } = await import('../lib/browser.mjs');

// 读总时长与画布
const probe = await launchBrowser(chromium);
const probePage = await probe.newPage({ viewport: { width: 1920, height: 1080 } });
await probePage.goto(pathToFileURL(sceneHtml).href, { waitUntil: 'load' });
await probePage.waitForFunction(() => typeof window.renderAt === 'function');
const DURATION = await probePage.evaluate(() => window.DURATION);
const W = await probePage.evaluate(() => window.W);
const H = await probePage.evaluate(() => window.H);
await probePage.close();
await closeLaunchedBrowsers();
const total = Math.round(DURATION * FPS);

const from = Number(arg('from', 0));
const to = Math.min(total, Number(arg('to', total)));
console.log(`共 ${total} 帧（${W}x${H}），本次 ${from}–${to}，每块 ${CHUNK} 帧`);

let done = 0;
const t0 = Date.now();
for (let a = from; a < to; a += CHUNK) {
  const b = Math.min(to, a + CHUNK);
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(sceneHtml).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => typeof window.renderAt === 'function');
    for (let i = a; i < b; i++) {
      await page.evaluate(tt => window.renderAt(tt), i / FPS);
      await page.screenshot({
        path: path.join(frames, String(i).padStart(5, '0') + '.jpg'),
        type: 'jpeg', quality: 92, animations: 'disabled',
      });
      done++;
      if (done % 120 === 0) {
        const el = (Date.now() - t0) / 1000;
        process.stdout.write(`\r  ${done}/${to - from}  用时 ${el.toFixed(0)}s  剩余 ~${(el / done * (to - from - done)).toFixed(0)}s   `);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n  块 ${a}–${b} 完成`);
}
console.log(`\n全部完成：${done} 帧`);
