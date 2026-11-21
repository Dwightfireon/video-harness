import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMeasurementPage } from '../lib/measurement-page.mjs';
import { collectLayoutFrame, observeLayoutBatch, layoutProbeBatches } from '../lib/layout-observation.mjs';
import { measureLayout } from '../lib/layout-measured.mjs';
import { measureContrast } from '../lib/contrast-rendered.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-layout-batch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'scene.html'), `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:white;color:#111}.scene{position:absolute;inset:0}
    #label{position:absolute;left:20px;top:50px;font:30px sans-serif}</style>
    <div class="scene"><div id="label">Probe</div></div><script>
    window.W=320;window.H=180;const DURATION=30;const SUBS = [{s:0,e:29,t:'Probe'}];
    function addScene(){};addScene(0,30,()=>{});
    window.renderAt=async t=>{await Promise.resolve();if(t===99)throw Error('bad frame');document.querySelector('#label').textContent='Probe '+t;};
    </script>`);
  return dir;
}

test('batched layout observations equal serial observations, await async renders and keep the final frame', async t => {
  const dir = fixture(t), session = await openMeasurementPage(path.join(dir, 'scene.html'));
  t.after(() => session.close());
  const probes = Array.from({ length: 29 }, (_, t) => ({ t, scene: 1 })), expected = [];
  for (const probe of probes) {
    await session.page.evaluate(t => window.renderAt(t), probe.t);
    expected.push({ ...probe, frame: await session.page.evaluate(collectLayoutFrame) });
  }
  const actual = [], batches = layoutProbeBatches(probes, new Set([7, 24]));
  assert.deepEqual(batches.map(b => b.at(-1).t), [7, 24, 28]);
  for (const batch of batches) {
    actual.push(...await session.page.evaluate(observeLayoutBatch, batch));
    assert.equal(await session.page.locator('#label').textContent(), 'Probe ' + batch.at(-1).t);
  }
  assert.deepEqual(actual, expected);
  assert.deepEqual(layoutProbeBatches(probes).map(b => b.length), [24, 5]);
  await assert.rejects(session.page.evaluate(observeLayoutBatch, [{ t: 99, scene: 1 }]), /bad frame/);
});

test('contrast and layout reuse one open session without closing it; another HTML is refused', async t => {
  const dir = fixture(t), session = await openMeasurementPage(path.join(dir, 'scene.html'));
  t.after(() => session.close());
  const contrast = await measureContrast(dir, { session });
  assert.equal(contrast.ok, true); assert.ok(contrast.measured > 0);
  const layout = await measureLayout(dir, { session });
  assert.equal(layout.ok, true); assert.ok(layout.sampled > 10);
  assert.equal(session.page.isClosed(), false);
  await assert.rejects(measureLayout(dir, { session, htmlFile: 'other.html' }).then(result => {
    // A missing other file is a failed observation, not a pass.
    if (!result.ok) throw Error('other HTML not inspected');
  }), /other HTML/);
});
