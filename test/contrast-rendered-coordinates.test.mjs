import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { sampleTextContrast } from '../lib/contrast-rendered.mjs';

let browser;
before(async () => { browser = await launchBrowser(chromium, { headless: true }); });
after(async () => { await browser?.close(); });

function instrument(page, overrides = {}) {
  return {
    addStyleTag: page.addStyleTag.bind(page),
    evaluate: page.evaluate.bind(page),
    screenshot: page.screenshot.bind(page),
    ...overrides,
  };
}

async function fixture(t, { dpr = 1, scroll = false, edge = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: dpr });
  t.after(() => context.close());
  const page = await context.newPage();
  const sx = scroll ? 137 : 0, sy = scroll ? 211 : 0;
  const boxes = [
    { id: 'green', x: edge ? 0 : 30, y: 30, w: 40, h: 22, color: 'rgb(99, 192, 138)', background: '#63c08a' },
    { id: 'red', x: 220, y: 120, w: 60, h: 24, color: 'rgb(192, 99, 138)', background: '#c0638a' },
    // No interior grid points: retain the ring fallback in CSS coordinates too.
    { id: 'tiny', x: 240, y: 60, w: 0.5, h: 0.5, color: 'rgb(99, 138, 192)', background: '#638ac0' },
  ].map(box => ({ ...box, scene: 1, text: box.id, size: 32, weight: '400', opacityGroups: [] }));
  await page.setContent(`<style>
    html,body{margin:0;background:white;color:black}
    body{width:1000px;height:1000px}
  </style><div id="group" style="opacity:.5;color:rgb(1, 2, 3)">Visible text</div>${boxes.map(box => {
    const pad = box.id === 'tiny' ? 8 : 0;
    return `<div style="position:absolute;left:${box.x + sx - pad}px;top:${box.y + sy - pad}px;width:${box.w + 2 * pad}px;height:${box.h + 2 * pad}px;background:${box.background}"></div>`;
  }).join('')}`);
  await page.evaluate(({ sx, sy }) => window.scrollTo(sx, sy), { sx, sy });
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, devicePixelRatio]), [sx, sy, dpr]);
  return { page, boxes };
}

for (const dpr of [1, 1.5, 2]) {
  for (const scroll of [false, true]) {
    for (const fallback of [false, true]) {
      test(`contrast coordinates: DPR ${dpr}, scroll ${scroll}, clip failure ${fallback}`, async t => {
        const { page, boxes } = await fixture(t, { dpr, scroll });
        const captures = [];
        const measured = instrument(page, {
          screenshot: async options => {
            captures.push(options);
            if (fallback && options.clip) throw new Error('injected clip failure');
            return page.screenshot(options);
          },
        });
        const findings = await sampleTextContrast(measured, boxes, { t: 1, scene: 1 });
        assert.equal(captures.length, fallback ? 2 : 1);
        assert.deepEqual(captures[0].clip, { x: 20, y: 20, width: 270, height: 134 });
        if (fallback) assert.equal(captures[1].clip, undefined);
        assert.deepEqual(findings.map(f => [f.element, f.background, f.ratio, f.need]),
          boxes.map(box => [box.id, box.background, 1, 3]));
      });
    }
  }
}

test('unclippable edge uses viewport origin and DPR without attempting a clip', async t => {
  const { page, boxes } = await fixture(t, { dpr: 2, edge: true });
  const captures = [];
  const findings = await sampleTextContrast(instrument(page, {
    screenshot: async options => { captures.push(options); return page.screenshot(options); },
  }), boxes);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].clip, undefined);
  assert.deepEqual(findings.map(f => f.background), boxes.map(box => box.background));
});

test('successful sampling restores hiding style and preserves 3 / 4.5 thresholds', async t => {
  const { page, boxes } = await fixture(t);
  const before = await page.locator('style').count();
  const findings = await sampleTextContrast(page, [
    ...boxes,
    { ...boxes[0], id: 'small', size: 18 },
    { ...boxes[0], id: 'bold', size: 19, weight: '600' },
  ]);
  assert.deepEqual(findings.map(f => f.need), [3, 3, 3, 4.5, 3]);
  assert.equal(await page.locator('style').count(), before);
  assert.equal(await page.locator('#group').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)');
});

for (const stage of ['clip evaluate', 'screenshots', 'pixel evaluate', 'opacity screenshot', 'opacity restore']) {
  test(`sampling failure cleans hiding style: ${stage}`, async t => {
    const { page, boxes } = await fixture(t);
    const before = await page.locator('style').count();
    const originalStyle = await page.locator('#group').getAttribute('style');
    const failure = new Error(`injected ${stage} failure`);
    let screenshots = 0;
    const measured = instrument(page, {
      evaluate: async (fn, arg) => {
        if (stage === 'clip evaluate' && arg?.pad === 10) throw failure;
        if (stage === 'pixel evaluate' && arg?.dataUrl) throw failure;
        if (stage === 'opacity restore' && Object.hasOwn(arg || {}, 'originalStyle')) throw failure;
        return page.evaluate(fn, arg);
      },
      screenshot: async options => {
        screenshots++;
        if (stage === 'screenshots' || (stage === 'opacity screenshot' && screenshots > 1)) throw failure;
        return page.screenshot(options);
      },
    });
    const sampled = stage.startsWith('opacity')
      ? [{ ...boxes[0], opacityGroups: [{ id: 'body/0', opacity: 0.5 }] }]
      : boxes;
    await assert.rejects(sampleTextContrast(measured, sampled), error => error === failure);
    assert.equal(await page.locator('style').count(), before);
    assert.equal(await page.locator('#group').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)');
    if (stage !== 'opacity restore') assert.equal(await page.locator('#group').getAttribute('style'), originalStyle);
    if (stage === 'screenshots') assert.equal(screenshots, 2, 'clip and viewport both failed');
    if (stage === 'opacity screenshot') assert.equal(screenshots, 3, 'group clip and viewport both failed');
  });
}
