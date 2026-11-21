import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { launchBrowser } from '../lib/browser.mjs';
import { FRAME_RUNTIME, injectFrameRuntime } from '../lib/frame-runtime.mjs';
import { RUNTIME_FOR_TPL, incrementalTransitionError, inject } from '../lib/transition.mjs';
import { normalizeGeneratedMetadata } from '../lib/generator-metadata.mjs';
import { parseSceneBodies, fnv1a } from '../lib/state.mjs';

const source = fs.readFileSync(new URL('../assets/fx-block.html', import.meta.url), 'utf8');
const element = () => ({ style: {}, children: [], appendChild(el) { this.children.push(el); } });
function runtime(overrides = {}) {
  const context = { window: { W: 1920, H: 1080 }, W: 1920, H: 1080, mk: element,
    document: { readyState: 'loading', addEventListener() {}, createElement() {
      return { ...element(), getContext() { return { clearRect() {} }; } };
    } }, setTimeout, clearTimeout };
  Object.assign(context, overrides);
  vm.runInNewContext(source, context);
  return context.window;
}
const shots = [{ at: 0, px: 960, py: 540, k: 1 }, { at: 6, move: 2, px: 1000, py: 540, k: 2 }];

test('镜头 apply：直达、跨保持区、倒播与新实例相同', () => {
  const w = runtime(), st = w.VH_UI.oneTake(element(), shots);
  for (const t of [0, 10, 0, 5, 10, 0]) {
    st.apply(t);
    const direct = w.VH_UI.oneTake(element(), shots); direct.apply(t);
    assert.equal(st.world.style.transform, direct.world.style.transform, 'oneTake at ' + t);
  }
  const el = element();
  for (const t of [0, 10, 0, 5, 10, 0]) {
    w.FX.cameraShot(shots, t).apply(el);
    const direct = element(); w.FX.cameraShot(shots, t).apply(direct);
    assert.equal(el.style.transform, direct.style.transform, 'cameraShot at ' + t);
  }
});

test('oneTake apply 使用与 captionSide 相同的世界尺寸选项', () => {
  const w = runtime(), opt = { vw: 1080, vh: 1920 };
  const st = w.VH_UI.oneTake(element(), [{ at: 0, k: 2 }], opt);
  const expected = w.VH_UI.cameraShotValue([{ at: 0, k: 2 }], 0, opt);
  st.apply(0);
  assert.equal(st.world.style.transform, `translate(${expected.tx}px, ${expected.ty}px) scale(${expected.k})`);
});

test('fxCanvas：同 slot 的规范时间与采样历史无关（包括负时间）', () => {
  const w = runtime(); let painted;
  const canvas = w.FX.fxCanvas(element(), { fps: 20, draw(ctx, t) { painted = t; } });
  canvas.render(.001); canvas.render(.02); const first = painted;
  canvas.render(1); canvas.render(.02); assert.equal(painted, first); assert.equal(painted, 0);
  canvas.render(-.01); assert.equal(painted, -.05);
  assert.throws(() => w.FX.fxCanvas(element(), { fps: 0 }), /fps/);
});

test('growTo：保留单位，倒播归位，零时长不生成 NaN，混合单位拒绝', () => {
  const w = runtime(), el = element(), mo = w.VH_MOTION;
  for (const unit of ['%', 'px', 'rem', 'vw']) {
    mo.growTo(el, 5, { w: '100' + unit }); assert.equal(el.style.width, '100' + unit);
    mo.growTo(el, -1, { w: '100' + unit }); assert.equal(el.style.width, '0' + unit);
  }
  mo.growTo(el, 1, { at: 1, dur: 0, w: 240 }); assert.equal(el.style.width, '240px');
  mo.countTo(el, 1, { at: 1, dur: 0, to: 10 }); assert.equal(el.textContent, '10');
  mo.slideTo(el, 1, { at: 1, dur: 0, x: 80 }); assert.match(el.style.transform, /80\.00px/);
  assert.throws(() => mo.growTo(el, 1, { from: '10px', w: '100%' }), /单位/);
});

test('cut：精确在场景起点切换，不能提前显示下一场', () => {
  const scenes = [0, 10].map(start => ({ start, end: start + 10, root: element(), render() {} }));
  const context = { scenes, window: { W: 1920, DURATION: 20, renderAt() {}, __vhTrans: [{ k: 'cut' }, { k: 'cut' }] },
    document: { readyState: 'complete', getElementById() { return null; } }, setTimeout(fn) { fn(); } };
  vm.runInNewContext(RUNTIME_FOR_TPL, context);
  for (const t of [9.6, 10, 9.999, 15, 0]) {
    context.window.renderAt(t);
    assert.equal(scenes[1].root.style.display, t >= 10 ? 'block' : 'none');
  }
});

test('frame runtime：等待素材，不在加载结束时异步回零；保留转场标记', async () => {
  let release; const asset = new Promise(resolve => { release = resolve; }); const seen = [];
  const original = t => { seen.push(t); }; original.__vhTrans = true;
  const context = { window: { renderAt: original, VH_UI: { assetsReady: () => asset } },
    document: { readyState: 'complete' } };
  vm.runInNewContext(FRAME_RUNTIME, context);
  const first = context.window.renderAt(0), latest = context.window.renderAt(9);
  assert.deepEqual(seen, []); release(); await Promise.all([first, latest]);
  assert.deepEqual(seen, [9]); assert.equal(context.window.renderAt.__vhTrans, true);
});

test('frame runtime：page.evaluate 的返回 Promise 等待当帧视频解码', async () => {
  let release, finished = false;
  const media = new Promise(resolve => { release = resolve; });
  const context = { window: { renderAt() { this.__vhMediaPending.add(media); }, __vhMediaPending: new Set() },
    document: { readyState: 'complete' } };
  vm.runInNewContext(FRAME_RUNTIME, context); await context.window.__ready;
  const frame = context.window.renderAt(4).then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); release(); await frame; assert.equal(finished, true);
});

test('素材超时包括 decode 阶段；请求和解码永不完成也会有限失败', { timeout: 1000 }, async () => {
  for (const complete of [true, false]) {
    const img = { complete, naturalWidth: complete ? 1 : 0, decode: () => new Promise(() => {}),
      addEventListener() {}, removeEventListener() {} };
    const w = runtime({ document: { readyState: 'loading', addEventListener() {}, images: [img], querySelectorAll: () => [] } });
    await assert.rejects(w.VH_UI.assetsReady({ strict: true, timeout: 10 }), /素材加载/);
  }
});

test('生成后处理：无源注释不吞 author boundary 换行，且重复处理幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-normalize-empty-'));
  try {
    fs.writeFileSync(path.join(dir, 'scenes.src.js'), 'root=>({render(t){}})');
    const html = 'const scenes = [];\n// author boundary\n\naddScene(0,10,root=>({}));';
    const file = path.join(dir, 'scene.html'); fs.writeFileSync(file, html);
    assert.equal(normalizeGeneratedMetadata(dir), false); assert.equal(normalizeGeneratedMetadata(dir), false);
    assert.equal(fs.readFileSync(file, 'utf8'), html);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('生成出口：幂等安装屏障和转场表，旧首帧 gate 不残留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-frame-'));
  try {
    fs.writeFileSync(path.join(dir, 'scenes.src.js'), '// @transition wipe\n// @transition-dur 1.2\nroot => ({render(t){}})');
    const html = 'const scenes = [];\naddScene(0,10,root=>({}));\nwindow.DURATION = DURATION;\n' +
      '/* vh:assets-gate */\n(function(){ window.__ready = Promise.resolve(); })();\nwindow.renderAt(0);';
    fs.writeFileSync(path.join(dir, 'scene.html'), html);
    assert.equal(normalizeGeneratedMetadata(dir), true); assert.equal(normalizeGeneratedMetadata(dir), false);
    const result = fs.readFileSync(path.join(dir, 'scene.html'), 'utf8');
    assert.equal(result.includes('vh:assets-gate'), false);
    assert.match(result, /"k":"wipe","d":1.2/);
    assert.equal(injectFrameRuntime(result), result);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('共享转场表/帧屏障变化不能只使最后一场失效；普通单场改稿仍局部失效', () => {
  const html = 'const scenes = [];\naddScene(0,10,root=>({}));\naddScene(10,20,root=>({}));\n' +
    'window.__vhTrans = [{"k":"fade","d":null},{"k":"cut","d":null}];\n' + FRAME_RUNTIME;
  const baseline = parseSceneBodies(html).map(fnv1a);
  for (const next of [html.replace('"fade"', '"wipe"'), html.replace('let ready = false', 'let ready = true')]) {
    assert.ok(parseSceneBodies(next).every((body, i) => fnv1a(body) !== baseline[i]));
  }
  const local = parseSceneBodies(html.replace('addScene(0,10,root=>({}))', 'addScene(0,10,root=>({changed:1}))')).map(fnv1a);
  assert.notEqual(local[0], baseline[0]); assert.equal(local[1], baseline[1]);
  assert.match(incrementalTransitionError(html.replace('"d":null', '"d":1.2')), /0.45/);
  assert.equal(incrementalTransitionError(html), null);
});

test('转场注入：升级旧块先备份，保留其后的作者代码，再次注入幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trans-upgrade-'));
  try {
    const old = RUNTIME_FOR_TPL.replace('s.transition === \'cut\' ? 0 : ', '').replace('/* vh:transitions-end */', '');
    const filename = path.join(dir, 'engine.tpl.html'); fs.writeFileSync(filename, old + '\nconst authorTail = 42;');
    const result = inject(dir); assert.equal(result.updated, true);
    assert.equal(fs.readFileSync(path.join(dir, result.backup), 'utf8'), old + '\nconst authorTail = 42;');
    assert.match(fs.readFileSync(filename, 'utf8'), /const authorTail = 42;/);
    assert.equal(inject(dir).already, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('真实浏览器视频：直达、倒播、快速改目标、结尾冻结均等待正确颜色帧', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-video-frame-')); let browser, server;
  try {
    const video = path.join(dir, 'colors.mp4');
    const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=10:d=1',
      '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=10:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const html = '<script>const W=64,H=64;window.W=W;window.H=H;\n' +
      'function mk(){return document.createElement("div")} function abs(el){return el}\n' + source + '\n' +
      'const v=VH_UI.videoEl(document.body,"colors.mp4",0,0,64,64);\n' +
      'window.renderAt=t=>{v.seek(t)};\nwindow.renderAt(0);</script>';
    fs.writeFileSync(path.join(dir, 'scene.html'), '<body>' + injectFrameRuntime(html));
    server = createServer((req, res) => {
      const media = req.url === '/colors.mp4';
      const bytes = fs.readFileSync(path.join(dir, media ? 'colors.mp4' : 'scene.html'));
      res.setHeader('Content-Type', media ? 'video/mp4' : 'text/html; charset=utf-8');
      if (media) res.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (media && range) {
        const start = +range[1], end = range[2] ? Math.min(+range[2], bytes.length - 1) : bytes.length - 1;
        res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
        res.setHeader('Content-Length', end - start + 1); res.end(bytes.subarray(start, end + 1));
      } else { res.setHeader('Content-Length', bytes.length); res.end(bytes); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { chromium } = await import('playwright'); browser = await launchBrowser(chromium, { headless: true });
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/scene.html`);
    for (const t of [1.5, .2, 1.2, 9, .1]) {
      try { await page.evaluate(t => window.renderAt(t), t); }
      catch (error) {
        const state = await page.evaluate(() => { const v = document.querySelector('video'); return { t: v.currentTime, duration: v.duration, seeking: v.seeking, ready: v.readyState }; });
        throw new Error(`seek ${t}: ${JSON.stringify(state)}: ${error.message}`);
      }
      const screenshot = await page.locator('video').screenshot();
      const pixel = await page.evaluate(async url => {
        const image = new Image(); image.src = url; await image.decode();
        const c = document.createElement('canvas'); c.width = c.height = 1;
        const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      }, 'data:image/png;base64,' + screenshot.toString('base64'));
      assert.ok(t >= 1 ? pixel[2] > 200 && pixel[0] < 30 : pixel[0] > 200 && pixel[2] < 30, `t=${t}: ${pixel}`);
    }
    await page.evaluate(async () => { const a = window.renderAt(.1); const b = window.renderAt(1.5); await Promise.all([a, b]); });
    assert.equal(await page.evaluate(() => document.querySelector('video').seeking), false);
    assert.equal(await page.evaluate(() => window.__vhMediaPending.size), 0);
    const second = await browser.newPage(); await second.goto(page.url());
    for (const t of [.2, 1.5, .2]) {
      await Promise.all([page.evaluate(t => window.renderAt(t), t), second.evaluate(t => window.renderAt(t), t)]);
      const a = await page.locator('video').screenshot(), b = await second.locator('video').screenshot();
      assert.ok(a.equals(b), '不同 worker/采样历史的截图应一致，t=' + t);
    }
    await assert.rejects(page.evaluate(async () => {
      const image = new Image(); image.src = '/bad.png'; document.body.appendChild(image);
      await window.VH_UI.assetsReady({ strict: true, timeout: 100 });
    }), /素材加载/);
    await page.evaluate(async () => {
      const v = document.querySelector('video');
      const error = new Promise(resolve => v.addEventListener('error', resolve, { once: true }));
      v.src = '/bad.mp4'; await error;
    });
    await assert.rejects(page.evaluate(() => window.renderAt(1)), /视频素材未能就绪/);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
