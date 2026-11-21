import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { sampleTextContrast } from '../lib/contrast-rendered.mjs';

test('对比度截图只读取一次像素缓冲，仍逐文字保留原网格的颜色判定', async t => {
  const browser = await launchBrowser(chromium, { headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  await page.setContent('<style>html,body{margin:0;background:white}</style>');
  await page.evaluate(() => {
    window.pixelReadCalls = 0;
    const original = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) { window.pixelReadCalls++; return original.apply(this, args); };
  });
  const common = { scene: 1, x: 20, y: 20, w: 200, h: 40, size: 32, weight: '400', opacityGroups: [] };
  const findings = await sampleTextContrast(page, [
    { ...common, id: 'clear', text: 'Black', color: 'rgb(0, 0, 0)' },
    { ...common, id: 'faint', text: 'Faint', color: 'rgb(240, 240, 240)' },
  ], { t: 1, scene: 1 });
  assert.equal(await page.evaluate(() => window.pixelReadCalls), 1);
  assert.equal(findings.length, 1); assert.equal(findings[0].element, 'faint');
  assert.equal(findings[0].background, '#ffffff'); assert.equal(findings[0].ratio, 1.14);
});
