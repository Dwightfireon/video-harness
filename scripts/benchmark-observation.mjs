#!/usr/bin/env node
/* Compare identical DOM probes; no user project, TTS, model or reduced coverage. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { openMeasurementPage } from '../lib/measurement-page.mjs';
import { collectLayoutFrame, observeLayoutBatch, layoutProbeBatches } from '../lib/layout-observation.mjs';
import { layoutTimes } from '../lib/layout-geometry.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-observation-perf-'));
let session;
try {
  const ranges = Array.from({ length: 15 }, (_, i) => [i * 20, (i + 1) * 20]);
  const subs = Array.from({ length: 90 }, (_, i) => ({ s: i * 3.3 + .2, e: i * 3.3 + 2.9, t: 'Example ' + i }));
  fs.writeFileSync(path.join(dir, 'scene.html'), `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:white;color:#111}.scene{position:absolute;inset:0}
    h1{position:absolute;left:140px;top:200px;font:54px sans-serif}
    p{position:absolute;left:140px;top:400px;font:32px sans-serif}</style>
    <div class="scene"><h1>Observation benchmark</h1><p id="value"></p></div><script>
    window.W=1920;window.H=1080;window.renderAt=async t=>{await Promise.resolve();document.getElementById('value').textContent='Current '+t;};
    </script>`);
  session = await openMeasurementPage(path.join(dir, 'scene.html'));
  const probes = layoutTimes(ranges, subs), rows = [];
  const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
  for (const variant of ['serial', 'batch', 'serial', 'batch', 'serial', 'batch']) {
    const start = performance.now(), frames = [];
    if (variant === 'serial') {
      for (const probe of probes) {
        await session.page.evaluate(t => window.renderAt(t), probe.t);
        frames.push({ ...probe, frame: await session.page.evaluate(collectLayoutFrame) });
      }
    } else {
      for (const batch of layoutProbeBatches(probes)) frames.push(...await session.page.evaluate(observeLayoutBatch, batch));
    }
    const row = { variant, ms: Math.round(performance.now() - start), probes: frames.length,
      roundTrips: variant === 'serial' ? probes.length * 2 : layoutProbeBatches(probes).length, sha256: digest(frames) };
    rows.push(row); console.log(JSON.stringify(row));
  }
  if (new Set(rows.map(row => row.sha256)).size !== 1) throw new Error('串行与批量观察不一致，不能认定优化有效');
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify({ scope: '15 scenes, 90 cues, identical observers/probes; not full video timing', rows }, null, 2) + '\n');
} finally { if (session) await session.close(); fs.rmSync(dir, { recursive: true, force: true }); }
