import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { skillDir } from '../lib/state.mjs';
import { launchBrowser, localChromeInfo } from '../lib/browser.mjs';

// Experiment only: deliberately NOT imported by new/enhance/build. A zero blur
// and no filter need not have the same compositing semantics. Do not promote
// this candidate to a scaffold migration on the strength of a JS microbenchmark.
const template = path.join(skillDir() || '', 'assets/engine.tpl.html');
const available = fs.existsSync(template);
const hash = data => createHash('sha256').update(data).digest('hex');
function pixelDifference(a, b) {
  if (a.equals(b)) return { changedPixels: 0, maxChannelDelta: 0 };
  const decode = png => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { input: png, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr?.toString());
    return r.stdout;
  };
  const [x, y] = [decode(a), decode(b)];
  assert.equal(x.length, y.length);
  let changedPixels = 0, maxChannelDelta = 0;
  for (let i = 0; i < x.length; i += 3) {
    const delta = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]));
    if (delta) changedPixels++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  return { changedPixels, maxChannelDelta };
}
const beforeReveal = 'el.style.filter = `blur(${(1-e)*(blur==null?6:blur)}px)`;';
const beforeEnter = "el.style.filter = o.blur === 0 ? '' : `blur(${(1-e)*(o.blur == null ? 5 : o.blur)}px)`;";
function helpers() {
  const source = fs.readFileSync(template, 'utf8');
  const reveal = source.slice(source.indexOf('function reveal('), source.indexOf('/* ============ 统一入场'));
  const start = source.indexOf('function enter(');
  const enter = source.slice(start, source.indexOf('\n}', start) + 2);
  assert.equal(reveal.split(beforeReveal).length, 2, 'upstream reveal changed; re-evaluate experiment');
  assert.equal(enter.split(beforeEnter).length, 2, 'upstream enter changed; re-evaluate experiment');
  const baseline = reveal + '\n' + enter;
  const candidate = baseline.replace(beforeReveal,
    "el.style.filter = v >= 1 ? 'none' : `blur(${(1-e)*(blur==null?6:blur)}px)`;")
    .replace(beforeEnter,
      "el.style.filter = o.blur === 0 ? '' : p >= 1 ? 'none' : `blur(${(1-e)*(o.blur == null ? 5 : o.blur)}px)`;");
  const prelude = 'const c01=x=>Math.max(0,Math.min(1,x)), eOut3=x=>1-Math.pow(1-x,3), P=(t,s,d)=>c01((t-s)/d), lerp=(a,b,p)=>a+(b-a)*p;\n' +
    'const easeOutBack=t=>{const c1=1.70158,c3=c1+1;return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2)};\n';
  return { source, baseline: prelude + baseline, candidate: prelude + candidate };
}

test('entry filter candidate assignments: exact endpoint, backward/jump replay and unchanged intermediate styles', { skip: !available }, () => {
  const { baseline, candidate } = helpers();
  const contexts = [baseline, candidate].map(source => vm.runInNewContext(source + ';({enter,reveal})'));
  for (const kind of ['enter', 'reveal']) for (const options of [{}, { blur: 0 }, { back: true, s: .8 }, { blur: 12, dur: 1.2 }]) {
    const invoke = (api, el, t) => kind === 'enter' ? api.enter(el, t, .2, options) : api.reveal(el, (t - .2) / .7, 18, options.blur);
    for (const time of [-1, .2, .3, .55, .899, .9, 1.4, 6]) {
      const old = { style: {} }, next = { style: {} };
      invoke(contexts[0], old, time); invoke(contexts[1], next, time);
      assert.equal(next.style.opacity, old.style.opacity); assert.equal(next.style.transform, old.style.transform);
      if (next.style.filter !== 'none') assert.equal(next.style.filter, old.style.filter);
      else assert.equal(old.style.filter, 'blur(0px)');
      const expected = { ...next.style };
      invoke(contexts[1], next, 8); invoke(contexts[1], next, -.5); invoke(contexts[1], next, time);
      assert.deepEqual(next.style, expected, `${kind} replay at ${time}`);
    }
  }
});

function fixture(helpers, mode = 'cards') {
  // Same 1920x1080 / 30fps inputs, fonts and JPEG quality as the renderer.
  // Normal cards exercise both helpers, stagger, scale and blur:0. The separate
  // back-easing fixture characterizes upstream's invalid negative CSS blur:
  // browsers ignore that assignment and can retain a previous frame's value.
  return `<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;background:#eef1e9;color:#192f24;font:32px system-ui}
    #stage{position:relative;width:1920px;height:1080px;padding:70px}
    h1{font:72px Georgia;margin:0 0 36px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
    .card{height:230px;padding:26px;background:#fff;border:1px solid #bbcebd;border-radius:18px;box-shadow:0 8px 24px #18382016}
    b{display:block;font-size:44px;margin-bottom:20px}.bar{height:14px;background:#438462;margin:18px 0}
    .depth{position:absolute;left:450px;top:240px;width:800px;height:500px;perspective:700px}
    .three{width:800px;height:500px;transform-style:preserve-3d;background:#bbb6}
    .front,.back{position:absolute;left:180px;top:120px;width:400px;height:260px}
    .front{background:#e24949;transform:translateZ(100px)}.back{background:#3b73d3;transform:translateZ(-100px)}
    </style><div id="stage">${mode !== 'depth' ? '<h1>入场结束以后 · Rendering fixture</h1><div class="grid">' +
      Array.from({ length: 12 }, (_, i) => `<div class="card"><b>${i + 1}. 确定性画面</b><div class="bar"></div>同一时间，同一结果</div>`).join('') + '</div>' :
      '<div class="depth"><div class="three"><div class="front"></div><div class="back"></div></div></div>'}</div>
    <script>${helpers}
    const nodes=[...document.querySelectorAll('${mode !== 'depth' ? '.card' : '.three'}')];
    window.renderAt=t=>nodes.forEach((el,i)=>{
      if(i%2) reveal(el,(t-i*.04)/.7,18,6);
      else enter(el,t,i*.04,{dur:.7,s:i%4===0?.95:0,back:${mode === 'back-easing' ? 'i%6===0' : 'false'},blur:i===10?0:5});
    });renderAt(0);</script>`;
}

// Explicit opt-in, never a default production gate. Prints raw rounds and visual
// hashes for a caller-owned report. Chrome profiles are always removed; optional
// exported screenshots/report belong to the caller, not the temporary fixture.
test('local Chrome entry-filter experiment: same-input frame render and seek/visual comparison', {
  skip: !available || !process.env.VH_ENTRY_FILTER_BENCH, timeout: 240000,
}, async t => {
  const { source, baseline, candidate } = helpers();
  const startedAt = new Date().toISOString();
  const load = () => ({ loadavg: os.loadavg(), freeMemoryBytes: os.freemem() });
  const initialLoad = load();
  const args = ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none',
    '--use-gl=angle', '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'];
  const browser = await launchBrowser(chromium, { headless: true, args });
  t.after(() => browser.close());
  const pages = [];
  const errors = [];
  for (const body of [baseline, candidate]) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(fixture(body)); await page.evaluate(() => document.fonts.ready);
    pages.push(page);
  }
  const snap = async (page, time) => {
    await page.evaluate(time => window.renderAt(time), time);
    return page.screenshot({ type: 'png' });
  };
  const visual = [];
  for (const mode of ['cards', 'depth', 'back-easing']) {
    for (let i = 0; i < pages.length; i++) {
      await pages[i].goto('about:blank');
      await pages[i].setContent(fixture([baseline, candidate][i], mode));
      await pages[i].evaluate(() => document.fonts.ready);
    }
    for (const time of [0, .3, .699, .7, .9, 1.2, 3]) {
      const images = [];
      const replay = [];
      for (const page of pages) {
        const image = await snap(page, time);
        const style = await page.evaluate(() => nodes.map(el => el.style.cssText));
        await snap(page, 8); await snap(page, 0);
        const repeated = await snap(page, time);
        const repeatedStyle = await page.evaluate(() => nodes.map(el => el.style.cssText));
        const stylesIdentical = JSON.stringify(repeatedStyle) === JSON.stringify(style);
        if (mode !== 'back-easing') assert.deepEqual(repeatedStyle, style, `${mode}: seek styles at ${time}`);
        replay.push({ stylesIdentical, identical: repeated.equals(image), ...pixelDifference(image, repeated), sha256: [image, repeated].map(hash) });
        images.push(image);
      }
      visual.push({ mode, time, identical: images[0].equals(images[1]), ...pixelDifference(...images), sha256: images.map(hash), replay });
      if (time === 1.2 && process.env.VH_ENTRY_FILTER_IMAGES) {
        for (let i = 0; i < images.length; i++) fs.writeFileSync(path.join(process.env.VH_ENTRY_FILTER_IMAGES, `${mode}-${i === 0 ? 'baseline' : 'candidate'}.png`), images[i]);
      }
    }
  }
  for (let i = 0; i < pages.length; i++) {
    await pages[i].goto('about:blank');
    await pages[i].setContent(fixture([baseline, candidate][i]));
    await pages[i].evaluate(() => document.fonts.ready);
  }
  // Warm both pages, then alternate AB/BA to limit startup/order bias. Measure
  // evaluate+full-resolution JPEG only; no encode, audio, disk I/O or claims of
  // full-video speedup. Tail and moving ranges use the same 30fps sample grid.
  const run = async (page, offset, count) => {
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      await page.evaluate(time => window.renderAt(time), offset + i / 30);
      await page.screenshot({ type: 'jpeg', quality: 92 });
    }
    return performance.now() - start;
  };
  for (const page of pages) await run(page, 0, 6);
  const rounds = [];
  for (const [range, offset] of [['entry', 0], ['settled', 2]]) for (let round = 0; round < 6; round++) {
    const ms = [];
    for (const i of round % 2 ? [1, 0] : [0, 1]) ms[i] = await run(pages[i], offset, 30);
    rounds.push({ range, round, baselineMs: ms[0], candidateMs: ms[1], gainPercent: 100 * (1 - ms[1] / ms[0]), load: load() });
  }
  assert.deepEqual(errors, []);
  const median = values => { const sorted = [...values].sort((a,b)=>a-b); return (sorted[2] + sorted[3]) / 2; };
  const summary = ['entry', 'settled'].map(range => {
    const values = rounds.filter(row => row.range === range);
    const baselineMedianMs = median(values.map(row => row.baselineMs));
    const candidateMedianMs = median(values.map(row => row.candidateMs));
    return { range, baselineMedianMs, candidateMedianMs, gainPercent: 100 * (1 - candidateMedianMs / baselineMedianMs),
      pairedGainRangePercent: [Math.min(...values.map(row => row.gainPercent)), Math.max(...values.map(row => row.gainPercent))] };
  });
  const report = { startedAt, endedAt: new Date().toISOString(), chrome: localChromeInfo().version, platform: process.platform, arch: process.arch,
    testSha256: hash(fs.readFileSync(new URL(import.meta.url))), initialLoad, finalLoad: load(),
    loadLimit: 'Shared interactive machine; load averages recorded, other sessions may run offline regressions. Not an isolated-system benchmark.',
    templateSha256: hash(source), helpersSha256: [baseline, candidate].map(hash), viewport: [1920, 1080],
    fps: 30, quality: 92, args, framesPerVariant: 360, summary, rounds, visual, errors,
    defaultEnabled: false,
    note: 'test-only candidate; production scaffold unchanged; capture timings exclude encoding/audio/disk; seek pixel checks are sampled, not a full visual review' };
  // Caller may retain a JSON record outside the automatically cleaned fixture.
  if (process.env.VH_ENTRY_FILTER_REPORT) fs.writeFileSync(process.env.VH_ENTRY_FILTER_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log('ENTRY_FILTER_BENCH ' + JSON.stringify(report));
});
