import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sceneFrameIntervals, performanceRendererSource } from '../lib/renderer-performance-upgrade.mjs';
import { repairRenderer } from '../lib/renderer-upgrade.mjs';
import { skillDir } from '../lib/state.mjs';

test('disjoint selections keep fade padding, merge adjacent padded ranges, clamp and round', () => {
  const ranges = [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]];
  assert.deepEqual(sceneFrameIntervals([1, 5], ranges, [0.1, 0.2, 0.3, 0.4, 0.1], 10, 30), [[0, 66], [237, 300]]);
  assert.deepEqual(sceneFrameIntervals([3, 2, 2], ranges, [0.1, 0.2, 0.3, 0.4, 0.1], 10, 30), [[51, 192]]);
  assert.deepEqual(sceneFrameIntervals([1, 5], ranges, [], 10, 30), [[0, 60], [240, 300]]);
  // No neighbouring scene: do not invent a 0.45s fade beyond the timeline.
  assert.deepEqual(sceneFrameIntervals([1], [[0, 5]], [], 5, 30), [[0, 150]]);
});

test('unknown templates never receive performance edits', () => {
  assert.equal(performanceRendererSource('const launchArgs = []; // custom'), null);
});

const template = process.env.VH_RENDERER_TEMPLATE || path.join(skillDir() || '', 'assets/render.mjs');
const hasTemplate = !!template && fs.existsSync(template);
test('approved template migration: exact backup, idempotency, syntax and customization refusal', { skip: !hasTemplate }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-render-perf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = fs.readFileSync(template, 'utf8');
  assert.ok(performanceRendererSource(original), 'supply an approved complete scaffold');
  assert.equal(performanceRendererSource(original + '\n// custom'), null);
  fs.writeFileSync(path.join(dir, 'render.mjs'), original);
  const result = repairRenderer(dir);
  assert.equal(result.kind, 'performance');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
  assert.equal(repairRenderer(dir).changed, false);
  const syntax = spawnSync(process.execPath, ['--check', path.join(dir, 'render.mjs')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

// Optional real Chromium/ffmpeg fixture benchmark. It is deliberately NOT a
// production project: the fixture substitutes only the external editorial gate
// with an explicit no-op, so no vh quality/baseline receipt is manufactured.
test('real-media fixture: sparse frames, identical decoded output, phase records and failure', {
  skip: !hasTemplate || !process.env.VH_RENDERER_BENCH, timeout: 240000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-render-bench-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  let old = fs.readFileSync(template, 'utf8');
  // The old fallback bug is orthogonal to the range comparison.
  old = old.replace('chromium.launch({ ...launchArgs, executablePath: localBrowser })',
    'chromium.launch({ args: launchArgs, executablePath: localBrowser }) /* vh:chrome-args-v1 */');
  const upgraded = performanceRendererSource(old);
  assert.ok(upgraded);
  const run = (cmd, args, cwd) => {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  const html = color => `<!doctype html><style>body{margin:0;background:#123456}#box{position:absolute;width:600px;height:600px;background:${color}}</style><div id="box"></div><script>
window.W=1920;window.H=1080;window.DURATION=5;
const scenes = [];
function addScene(a,b,fn,fade){scenes.push([a,b,fn,fade])}
addScene(0,1,()=>{},0.1);addScene(1,2,()=>{},0.1);addScene(2,3,()=>{},0.1);addScene(3,4,()=>{},0.1);addScene(4,5,()=>{},0.1);
window.renderAt=t=>{document.querySelector('#box').style.transform='translateX('+Math.round(t*180)+'px)'; document.querySelector('#box').style.background=t<1.1||t>=3.9?'${color}':'#ffcc44'};
</script>`;
  const results = [];
  for (const [label, source] of [['old', old], ['new', upgraded]]) {
    const dir = path.join(root, label); fs.mkdirSync(dir);
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
    // Explicit test-only gate substitution; never applied by the upgrader.
    fs.writeFileSync(path.join(dir, 'render.mjs'), source.replace("if (gate) {", "if (false && gate) {"));
    fs.writeFileSync(path.join(dir, 'scene.html'), html('#ee3344'));
    run(process.execPath, ['render.mjs'], dir);
    const frames = path.join(dir, 'out/frames');
    const before = new Map(fs.readdirSync(frames).map(f => [f, fs.statSync(path.join(frames, f)).mtimeMs]));
    fs.writeFileSync(path.join(dir, 'scene.html'), html('#33ee44'));
    // Keep the shared prefix constant; change only renderAt below scenes marker.
    const src = fs.readFileSync(path.join(dir, 'scene.html'), 'utf8').replace('background:#33ee44}', 'background:#ee3344}');
    fs.writeFileSync(path.join(dir, 'scene.html'), src);
    const started = performance.now();
    const result = run(process.execPath, ['render.mjs', '--scenes', '1,5'], dir);
    const changed = [...before].filter(([f, stamp]) => fs.statSync(path.join(frames, f)).mtimeMs !== stamp).map(([f]) => Number(f.slice(0, -4)));
    const hash = run('ffmpeg', ['-v', 'error', '-i', 'out/video.mp4', '-f', 'hash', '-hash', 'sha256', '-'], dir).stdout.trim();
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'out/video.mp4'], dir).stdout).streams[0];
    assert.equal(probe.width, 1920); assert.equal(probe.height, 1080);
    assert.equal(probe.r_frame_rate, '30/1'); assert.equal(Number(probe.nb_frames), 150);
    results.push({ label, elapsedMs: performance.now() - started, frames: changed.length, hash });
    if (label === 'new') {
      assert.deepEqual(changed, [...Array(33).keys(), ...Array.from({length: 33}, (_, i) => 117 + i)]);
      const events = result.stdout.split('\n').filter(l => l.startsWith('VH_RENDER_STAGE ')).map(l => JSON.parse(l.slice(16)));
      assert.deepEqual(events.map(e => [e.stage, e.ok]), [['screenshot', true], ['encode', true], ['concat', true]]);
      assert.equal(events[0].frames, 66);
      assert.equal(new Set(events.map(e => e.runId)).size, 1);
      // Encoding failure must not report successful encoding/concatenation.
      const failed = spawnSync(process.execPath, ['render.mjs', '--scenes', '1,5', '--preset', 'invalid-fixture-preset'], {cwd: dir, encoding:'utf8', timeout:90000});
      assert.notEqual(failed.status, 0);
      const failedEvents = failed.stdout.split('\n').filter(l => l.startsWith('VH_RENDER_STAGE ')).map(l => JSON.parse(l.slice(16)));
      assert.deepEqual(failedEvents.map(e => [e.stage, e.ok]), [['screenshot', true], ['encode', false]]);
      results.at(-1).stages = events;
    } else assert.equal(changed.length, 150);
  }
  assert.equal(results[0].hash, results[1].hash);
  console.log('RENDERER_BENCH ' + JSON.stringify(results));
});
