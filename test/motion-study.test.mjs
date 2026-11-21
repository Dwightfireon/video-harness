import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as F from '../lib/film.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { createStudy, duration, subs, travelPose } from '../demo/motion-polish-20261023/study.mjs';

const root = new URL('../', import.meta.url);
const demo = new URL('demo/motion-polish-20261023/', root);
const study = createStudy(F);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('motion study: shared data, sentence-level cues, exact arrival counts, terminal holds', () => {
  assert.equal(duration, 22);
  for (const b of study.beats) {
    assert.equal(subs.filter(s => s.t === b.cue.text).length, 1);
    assert.equal(b.cue.edge, 's');
  }
  for (const d of study.deliveries) {
    const before = study.sample(d.end - 1e-6), landed = study.sample(d.end);
    assert.equal(landed[d.lane], before[d.lane] + 1);
    assert.equal(before.files.find(f => f.id === d.id).landed, false);
    assert.equal(landed.files.find(f => f.id === d.id).landed, true);
    assert.ok(Math.abs(landed.files.find(f => f.id === d.id).progress - 1) < 1e-9);
  }
  for (const time of [0, 2.99, 3, 8, 9.149999, 9.15, 10.55, 11.95, 14.5, 16.2999, 16.3, 18, 22]) {
    const a = study.sample(time, 'after'), b = study.sample(time, 'before');
    for (const key of ['subtitle', 'full', 'delta', 'updated']) assert.deepEqual(a[key], b[key]);
    assert.equal(a.files.filter(f => f.updated).length, time >= 3 ? 2 : 0, '02 is marked once in each independent comparison lane');
  }
  assert.equal(study.sample(22).full, 3); assert.equal(study.sample(22).delta, 1);
  assert.equal(study.sample(11.95).full, 3, '编译末帧到达后，计数不能因重复计算小数晚一瞬间');
  assert.equal(study.sample(16.3).delta, 1);
  assert.deepEqual(study.sample(18).files, study.sample(22).files);
  assert.deepEqual(study.sample(18).poses, study.sample(22).poses);
  assert.throws(() => study.sample(NaN), /有限/);
});

test('motion study: route head and object share a geometric trajectory, not unrelated progress', () => {
  for (const distance of [300, 622, -300]) for (const channel of [94, -110]) {
    const v = Math.abs(channel), h = Math.abs(distance), total = v * 2 + h;
    for (let i = 0; i <= 100; i++) {
      const pose = travelPose(F, i / 100, distance, channel), walked = pose.trace * total;
      const x = walked <= v ? 0 : walked <= v + h ? Math.sign(distance) * (walked - v) : distance;
      const y = walked <= v ? Math.sign(channel) * walked : walked <= v + h ? channel : Math.sign(channel) * (total - walked);
      assert.ok(Math.abs(x - pose.x) < 1e-8 && Math.abs(y - pose.y) < 1e-8);
    }
  }
});

test('motion study: build is standalone and inlines current film runtime', async () => {
  execFileSync(process.execPath, ['scripts/build-motion-study.mjs'], { cwd: root });
  const html = await readFile(new URL('index.html', demo), 'utf8');
  assert.ok(html.includes(F.browserSource()));
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|\bfetch\s*\(/i);
  assert.doesNotMatch(html, /\/\* INLINE_/);
  assert.match(html, /机制示意，无旁白，未人工试听/);
});

test('motion study: offline browser, ordered/shuffled pixels, DOM identity, state boundaries, desktop + mobile', { timeout: 120_000 }, async () => {
  const { chromium } = await import('playwright');
  execFileSync(process.execPath, ['scripts/build-motion-study.mjs'], { cwd: root });
  const browser = await launchBrowser(chromium, { headless: true });
  const results = { runtime: 'pending', screenshotChecks: [], stateChecks: [], collisionChecks: [], routeChecks: [], readabilityChecks: [], layouts: [], externalRequests: [], errors: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => results.errors.push(e.message));
    await page.route(/^https?:/, route => { results.externalRequests.push(route.request().url()); return route.abort(); });
    await page.goto(new URL('index.html', demo).href);
    await page.evaluate(() => document.fonts.ready);
    results.runtime = await page.evaluate(() => window.motionStudy.compiled ? 'compileMotion' : 'smooth/phase preview');
    assert.equal(results.runtime, 'compileMotion');
    await page.evaluate(() => { window.__originalFileNodes = [...document.querySelectorAll('[data-file-id]')]; });
    const times = [0, 3.3, 8.6, 11.95, 14.5, 15.4, 18, 22];
    for (const aspect of ['landscape', 'portrait']) {
      for (const mode of ['before', 'after']) {
        await page.evaluate(({ aspect, mode }) => { window.motionStudy.setAspect(aspect); window.motionStudy.setMode(mode); }, { aspect, mode });
        const stage = page.locator('#stage'), ordered = new Map();
        for (const time of times) {
          await page.evaluate(t => window.renderAt(t), time);
          ordered.set(time, hash(await stage.screenshot({ animations: 'disabled' })));
        }
        for (const time of [15.4, 0, 22, 8.6, 14.5, 3.3, 18, 11.95]) {
          await page.evaluate(t => window.renderAt(t), time);
          const actual = hash(await stage.screenshot({ animations: 'disabled' }));
          assert.equal(actual, ordered.get(time), `${aspect}/${mode}/${time}: shuffled seek pixels must match`);
          results.screenshotChecks.push({ aspect, mode, time, sha256: actual, identical: true });
        }
        for (const d of study.deliveries) {
          for (const offset of [-1e-5, 0]) {
            const expected = study.sample(d.end + offset, mode);
            const actual = await page.evaluate(t => {
              const s = window.renderAt(t);
              return { full: s.full, delta: s.delta, subtitle: document.getElementById('subtitle').textContent,
                landed: [...document.querySelectorAll('[data-landed="true"]')].map(n => n.dataset.fileId) };
            }, d.end + offset);
            assert.equal(actual.full, expected.full); assert.equal(actual.delta, expected.delta);
            assert.equal(actual.subtitle, expected.subtitle);
            assert.deepEqual(actual.landed, expected.files.filter(f => f.landed).map(f => f.id));
            results.stateChecks.push({ aspect, mode, time: d.end + offset, full: actual.full, delta: actual.delta });
          }
        }
        await page.evaluate(() => window.renderAt(18));
        const held = hash(await stage.screenshot());
        await page.evaluate(() => window.renderAt(21.5));
        assert.equal(hash(await stage.screenshot()), held, 'final plate must stay pixel-still');
        await page.evaluate(() => window.renderAt(15.4));
        await stage.screenshot({ path: new URL(`${aspect}-${mode}.png`, demo).pathname });
      }
    }
    assert.equal(await page.evaluate(() => window.__originalFileNodes.every((node, i) => node === document.querySelectorAll('[data-file-id]')[i])), true);
    for (const aspect of ['landscape', 'portrait']) {
      const content = [];
      for (const mode of ['before', 'after']) {
        content.push(await page.evaluate(({ aspect, mode }) => {
          window.motionStudy.setAspect(aspect); window.motionStudy.setMode(mode); window.renderAt(18);
          return [...document.querySelectorAll('#scene text')].map(n => n.textContent);
        }, { aspect, mode }));
      }
      assert.deepEqual(content[0], content[1], 'both treatments have exactly the same visible text content');
      assert.equal(content[0].filter(t => t === '本次发送').length, 2);
      assert.equal(content[0].filter(t => t === '本次接收').length, 2);
      assert.ok(content[0].includes('仅展示本次传输副本，未画接收端已有目录；'));
      assert.ok(content[0].includes('发送不会删除源文件。'));
    }
    for (const aspect of ['landscape', 'portrait']) {
      const collisions = await page.evaluate(aspect => {
        window.motionStudy.setAspect(aspect); window.motionStudy.setMode('after');
        const hits = []; let maxRouteError = 0;
        for (let frame = 0; frame <= 660; frame++) {
          window.renderAt(frame / 30);
          const nodes = [...document.querySelectorAll('[data-file-id]')].filter(n => Number(n.getAttribute('opacity')) > 0.01)
            .map(n => ({ id: n.dataset.fileId, b: n.getBoundingClientRect() }));
          for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            if (Math.min(a.b.right, b.b.right) - Math.max(a.b.left, b.b.left) > 0.5 &&
                 Math.min(a.b.bottom, b.b.bottom) - Math.max(a.b.top, b.b.top) > 0.5) hits.push({ frame, a: a.id, b: b.id });
          }
          for (const file of window.motionStudyState.files.filter(f => f.moving)) {
            const path = document.querySelector(`#lane-${file.lane} .path`);
            const progress = 1 - Number(path.getAttribute('stroke-dashoffset'));
            const tip = path.getPointAtLength(path.getTotalLength() * progress);
            const screen = new DOMPoint(tip.x, tip.y).matrixTransform(path.getScreenCTM());
            const rect = document.querySelector(`#file-${file.id} rect`).getBoundingClientRect();
            maxRouteError = Math.max(maxRouteError, Math.hypot(screen.x - (rect.left + rect.width / 2), screen.y - (rect.top + rect.height / 2)));
          }
        }
        return { hits, maxRouteError };
      }, aspect);
      assert.deepEqual(collisions.hits, [], 'files must not cross through neighboring unit blocks');
      assert.ok(collisions.maxRouteError < .1, '路径笔尖应跟随文件中心，不各走各的：' + collisions.maxRouteError);
      results.collisionChecks.push({ aspect, frames: 661, fileOverlaps: 0 });
      results.routeChecks.push({ aspect, frames: 661, maxHeadErrorPx: collisions.maxRouteError });
    }
    await page.evaluate(() => { window.motionStudy.setAspect('landscape'); window.renderAt(9.15); });
    await page.locator('#before').click(); assert.equal(await page.evaluate(() => window.motionStudyState.t), 9.15);
    await page.locator('#after').click(); assert.equal(await page.evaluate(() => window.motionStudyState.t), 9.15);
    await page.locator('#next').click(); assert.ok(Math.abs(await page.evaluate(() => window.motionStudyState.t) - 9.2) < 1e-9);
    await page.locator('#seek').fill('14.5');
    assert.ok(Math.abs(await page.evaluate(() => window.motionStudyState.t) - 14.5) < 1 / 30);
    await page.locator('#play').click(); await page.waitForTimeout(120); await page.locator('#play').click();
    const stopped = await page.evaluate(() => window.motionStudyState.t);
    assert.ok(stopped > 14.5); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.motionStudyState.t), stopped);
    await page.locator('#restart').click(); await page.waitForTimeout(90); await page.locator('#play').click();
    assert.ok(await page.evaluate(() => window.motionStudyState.t < 1));
    for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const aspect of ['landscape', 'portrait']) {
        await page.evaluate(aspect => { window.motionStudy.setAspect(aspect); window.renderAt(18); }, aspect);
        const layout = await page.evaluate(() => {
          const stage = document.getElementById('stage').getBoundingClientRect();
          const svg = document.getElementById('scene'), box = svg.viewBox.baseVal;
          const texts = [...svg.querySelectorAll('text')].filter(n => getComputedStyle(n).visibility !== 'hidden').map(n => ({ text: n.textContent, b: n.getBBox() }));
          return { bodyWidth: document.documentElement.scrollWidth, windowWidth: innerWidth, stageWidth: stage.width,
            clippedTexts: texts.filter(({ b }) => b.x < -0.5 || b.y < -0.5 || b.x + b.width > box.width + 0.5 || b.y + b.height > box.height + 0.5).map(n => n.text) };
        });
        assert.ok(layout.bodyWidth <= viewport.width, 'no horizontal page overflow');
        assert.deepEqual(layout.clippedTexts, [], 'no SVG text clipping');
        results.layouts.push({ viewport, aspect, ...layout });
        if (viewport.width === 390 && aspect === 'portrait') {
          for (const mode of ['before', 'after']) {
            const readability = await page.evaluate(mode => {
              window.motionStudy.setMode(mode); window.renderAt(18);
              const keys = [...document.querySelectorAll('#scene [data-readable]')];
              const sizes = keys.map(n => {
                const m = n.getScreenCTM();
                return { text: n.textContent, role: n.dataset.readable,
                  cssPx: parseFloat(getComputedStyle(n).fontSize) * Math.hypot(m.c, m.d) };
              });
              const overlaps = [];
              // Measure real viewport boxes, including transforms, not just SVG-unit bboxes.
              for (const time of [0.8, 3.3, 6.7, 8.6, 11.95, 13.2, 15.4, 18, 22]) {
                window.renderAt(time);
                const visible = keys.filter(n => {
                  for (let p = n; p && p !== document.getElementById('scene'); p = p.parentElement)
                    if (Number(getComputedStyle(p).opacity) <= 0.01) return false;
                  return true;
                }).map(n => ({ text: n.textContent, b: n.getBoundingClientRect() }));
                for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
                  const a = visible[i], b = visible[j];
                  if (Math.min(a.b.right, b.b.right) - Math.max(a.b.left, b.b.left) > 0.5 &&
                      Math.min(a.b.bottom, b.b.bottom) - Math.max(a.b.top, b.b.top) > 0.5)
                    overlaps.push({ time, a: a.text, b: b.text });
                }
              }
              window.renderAt(18);
              return { sizes, overlaps };
            }, mode);
            for (const item of readability.sizes) {
              const minimum = item.role === 'file-number' ? 13 : item.role === 'subtitle' ? 12 : 10;
              assert.ok(item.cssPx >= minimum, `${mode}: ${item.text} is ${item.cssPx.toFixed(2)} CSS px; need ${minimum}`);
            }
            assert.deepEqual(readability.overlaps, [], 'mobile portrait key labels must not overlap');
            results.readabilityChecks.push({ viewport, aspect, mode, ...readability });
          }
        }
        await page.screenshot({ path: new URL(`${viewport.width === 390 ? 'mobile' : 'desktop'}-${aspect}.png`, demo).pathname, fullPage: true });
      }
    }
    assert.deepEqual(results.errors, []); assert.deepEqual(results.externalRequests, []);
    results.passed = true;
  } finally {
    await browser.close();
    await writeFile(new URL('browser-validation.json', demo), JSON.stringify(results, null, 2) + '\n');
  }
});
