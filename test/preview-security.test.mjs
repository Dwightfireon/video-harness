import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { startServer } from '../lib/server.mjs';
import { openSafeFile, byteRange } from '../lib/public-files.mjs';

async function fixture(t, scene = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-preview-security-'));
  const project = path.join(root, 'projects', 'fixture');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.mkdirSync(path.join(project, 'assets'));
  fs.mkdirSync(path.join(project, 'materials'));
  for (const [name, value] of Object.entries({
    'PROJECT.json': '{"name":"security fixture"}', '脚本.md': '## S1 · 测试\n1. 测试旁白。\n',
    'scenes.src.js': '// author source', '发布文案.md': '# fixture copy',
    'scene.html': scene || '<!doctype html><script>const W=1080,H=1920,DURATION=20;const SUBS=[];window.renderAt=t=>document.body.dataset.time=t;</script>',
    'out/video-voice.mp4': '0123456789', 'out/subtitles.srt': '1\n00:00:00,000 --> 00:00:01,000\ntest\n',
    'assets/style.css': 'body{background-color:rgb(1,2,3)}',
    'assets/module.js': 'document.body.dataset.moduleLoaded="yes";',
    'assets/pixel.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
    'materials/data.json': '{"ok":true}',
  })) fs.writeFileSync(path.join(project, name), value);
  let submits = 0;
  const server = startServer(project, 0, { root, home: path.join(root, 'home'), providerInfo: () => [],
    publish: { submit: async () => { submits++; return { ok: true }; } } });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      const chunks = []; res.on('error', reject); res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  return { root, project, origin, port, request, submits: () => submits };
}

test('static scope, hidden/private files, symlink components and exact Host/Origin', async t => {
  const f = await fixture(t), base = '/projects/fixture/';
  fs.writeFileSync(path.join(f.root, '.env'), 'fixture-secret');
  fs.writeFileSync(path.join(f.root, 'vh.config.json'), '{}');
  fs.mkdirSync(path.join(f.root, 'lib')); fs.writeFileSync(path.join(f.root, 'lib/internal.mjs'), 'private repo source');
  fs.writeFileSync(path.join(f.project, 'out/.vh-state.json'), '{}');
  fs.mkdirSync(path.join(f.project, 'node_modules')); fs.writeFileSync(path.join(f.project, 'node_modules/leak.js'), 'secret');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-preview-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'leak.txt'), 'outside');
  fs.symlinkSync(path.join(outside, 'leak.txt'), path.join(f.project, 'assets/link.txt'));
  fs.symlinkSync(outside, path.join(f.project, 'assets/dir-link'));
  fs.symlinkSync(path.join(f.project, 'assets'), path.join(f.project, 'materials/internal-link'));
  for (const url of ['/.env', '/%2eenv', '/vh.config.json', '/lib/internal.mjs', '/package.json', base + 'out/.vh-state.json', base + 'node_modules/leak.js', base + 'assets/link.txt', base + 'assets/dir-link/leak.txt', base + 'materials/internal-link/style.css']) {
    const result = await f.request(url); assert.ok([403, 404].includes(result.status), `${url}: ${result.status}`); assert.ok(!result.body.includes('outside'));
  }
  for (const host of ['evil.example:' + f.port, '127.0.0.1.evil:' + f.port, '127.0.0.1:' + (f.port + 1), '127.0.0.1:99999', 'localhost.:foo', 'localhost@evil.example']) {
    for (const url of ['/', base + 'scene.html', '/_api/projects']) assert.equal((await f.request(url, { headers: { host } })).status, 403);
  }
  for (const origin of ['null', 'http://127.0.0.1:' + (f.port + 1), 'http://localhost:' + f.port, 'https://127.0.0.1:' + f.port, 'https://evil.example']) {
    assert.equal((await f.request('/_api/publish/submit', { method: 'POST', headers: { origin }, body: '{"confirmed":true}' })).status, 403);
    assert.equal((await f.request('/_api/projects', { headers: { origin } })).status, 403);
  }
  assert.equal((await f.request('/_api/publish/submit', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403);
  assert.equal(f.submits(), 0);
  assert.equal((await f.request('/_api/publish/submit', { method: 'POST', headers: { origin: f.origin }, body: '{}' })).status, 200);
  assert.equal((await f.request('/_api/publish/submit', { method: 'POST', body: '{}' })).status, 200);
  assert.equal(f.submits(), 2); // fake service only; explicit same-origin and CLI still work
  for (const name of ['scene.html', '脚本.md', '发布文案.md', 'scenes.src.js', 'out/video-voice.mp4', 'out/subtitles.srt', 'materials/data.json']) assert.equal((await f.request(base + encodeURI(name))).status, 200, name);
  fs.mkdirSync(path.join(f.root, 'demo/fixture'), { recursive: true }); fs.writeFileSync(path.join(f.root, 'demo/fixture/index.html'), '<h1>demo</h1>');
  assert.equal((await f.request('/demo/fixture/index.html')).status, 200);
  assert.match((await f.request(base + 'scene.html')).headers['content-security-policy'], /sandbox allow-scripts;/);
  assert.equal((await f.request(base + 'assets/style.css', { headers: { origin: 'null' } })).headers['access-control-allow-origin'], '*');
  assert.equal((await f.request('/_api/projects')).headers['access-control-allow-origin'], undefined);
  assert.equal((await f.request('/_vh/.hidden')).status, 403);
  assert.equal((await f.request('/%ZZ')).status, 400);
});

test('safe open pins the file; Range/suffix/HEAD/error boundaries do not crash server', async t => {
  const f = await fixture(t), url = '/projects/fixture/out/video-voice.mp4';
  const opened = openSafeFile(fs.realpathSync(f.root), 'projects/fixture/out/video-voice.mp4');
  fs.renameSync(path.join(f.project, 'out/video-voice.mp4'), path.join(f.project, 'out/original.mp4'));
  fs.symlinkSync(path.join(f.project, '脚本.md'), path.join(f.project, 'out/video-voice.mp4'));
  assert.equal(fs.readFileSync(opened.fd, 'utf8'), '0123456789'); fs.closeSync(opened.fd);
  assert.equal((await f.request(url)).status, 403);
  fs.unlinkSync(path.join(f.project, 'out/video-voice.mp4')); fs.renameSync(path.join(f.project, 'out/original.mp4'), path.join(f.project, 'out/video-voice.mp4'));
  for (const [range, expected, contentRange] of [['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-', '89', 'bytes 8-9/10'], ['bytes=8-200', '89', 'bytes 8-9/10']]) {
    const r = await f.request(url, { headers: { range } }); assert.equal(r.status, 206); assert.equal(r.body, expected); assert.equal(r.headers['content-range'], contentRange);
    const head = await f.request(url, { method: 'HEAD', headers: { range } }); assert.equal(head.status, 206); assert.equal(head.body, ''); assert.equal(+head.headers['content-length'], expected.length);
  }
  for (const range of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'garbage', 'bytes=0-1,4-5', 'bytes=999999999999999999999999999-']) {
    const r = await f.request(url, { headers: { range } }); assert.equal(r.status, 416, range); assert.equal(r.headers['content-range'], 'bytes */10');
  }
  fs.writeFileSync(path.join(f.project, 'out/empty.mp4'), '');
  assert.equal((await f.request('/projects/fixture/out/empty.mp4', { headers: { range: 'bytes=0-' } })).status, 416);
  assert.equal((await f.request(url, { method: 'HEAD' })).body, '');
  // Simulate an asynchronous filesystem stream error without touching user files.
  const original = fs.createReadStream;
  fs.createReadStream = (...args) => { const stream = original(...args); queueMicrotask(() => stream.destroy(new Error('fixture read failure'))); return stream; };
  try { await f.request(url).catch(() => {}); } finally { fs.createReadStream = original; }
  assert.equal((await f.request(url)).body, '0123456789');
  assert.equal(byteRange('bytes=1-0', 10), false);
});

test('real panel: opaque malicious scene cannot alter parent or submit; render/seek/play/size/assets survive', { timeout: 30000 }, async t => {
  const scene = `<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head><body>
    <img id="pixel" src="assets/pixel.svg"><script type="module" src="assets/module.js"></script>
    <script>const W=1080,H=1920,DURATION=20;const SUBS=[];
      window.renderAt=t=>document.body.dataset.time=t;
      try { parent.document.querySelector('#pname').textContent='OWNED'; document.body.dataset.parentAccess='allowed'; } catch { document.body.dataset.parentAccess='blocked'; }
      Promise.allSettled([
        fetch('/_api/publish/submit',{method:'POST',headers:{'content-type':'application/json'},body:'{"confirmed":true}'}),
        fetch('/_api/publish/submit',{method:'POST',mode:'no-cors',body:'{"confirmed":true}'}),
        fetch('/_api/projects'),
        fetch('materials/data.json').then(r=>r.json()).then(v=>document.body.dataset.assetFetch=v.ok?'yes':'no')
      ]).then(()=>document.body.dataset.probesDone='yes');
      const img=new Image();img.src='/_api/projects';
    </script></body></html>`;
  const f = await fixture(t, scene), browser = await launchBrowser(chromium, { headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  // State observation is fixture-only; security-sensitive HTTP requests are NOT mocked.
  await page.route('**/_api/state?*', route => route.fulfill({ json: { name: 'security fixture', stale: {}, scenes: [{ i: 1, start: 0, end: 20, text: 'test' }], subs: [], duration: 20, videos: [], sceneM: 1, stillsCount: 0 } }));
  await page.goto(f.origin + '/?p=projects%2Ffixture');
  await page.waitForFunction(() => document.querySelector('#frame').style.width === '1080px' && document.querySelector('#reloading').classList.contains('hidden'));
  const inner = page.frames().find(frame => frame.url().includes('/scene.html'));
  assert.ok(inner);
  await inner.waitForFunction(() => document.body.dataset.probesDone === 'yes' && document.body.dataset.moduleLoaded === 'yes');
  assert.equal(await inner.evaluate(() => document.body.dataset.parentAccess), 'blocked');
  assert.equal(await inner.evaluate(() => self.origin), 'null');
  assert.equal(await inner.evaluate(() => document.body.dataset.assetFetch), 'yes');
  assert.equal(await inner.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(1, 2, 3)');
  assert.equal(await inner.evaluate(() => document.querySelector('#pixel').naturalWidth), 2);
  assert.equal(await page.locator('#pname').textContent(), '← security fixture');
  assert.equal(f.submits(), 0);
  assert.equal(await page.locator('#frame').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await page.evaluate(() => { try { return !!document.querySelector('#frame').contentWindow.document; } catch { return false; } }), false);
  // Real scrub transport -> postMessage -> renderAt, not a test-only invocation.
  await page.locator('#scrub').evaluate(el => { el.value = 500; el.dispatchEvent(new Event('input')); });
  await inner.waitForFunction(() => +document.body.dataset.time === 10);
  await page.click('#play');
  await inner.waitForFunction(() => +document.body.dataset.time > 10.05);
  await page.click('#play');
  const paused = await inner.evaluate(() => +document.body.dataset.time);
  await page.waitForTimeout(150); assert.equal(await inner.evaluate(() => +document.body.dataset.time), paused);
  await page.click('#reload');
  await page.waitForFunction(() => document.querySelector('#reloading').classList.contains('hidden'));
  assert.ok(Math.abs(await inner.evaluate(() => +document.body.dataset.time) - paused) < 0.1);
  // Even direct navigation gets a server-side sandbox (iframe attribute alone is insufficient).
  const direct = await browser.newPage(); await direct.goto(f.origin + '/projects/fixture/scene.html');
  await direct.waitForFunction(() => document.body.dataset.probesDone === 'yes');
  assert.equal(await direct.evaluate(() => self.origin), 'null'); assert.equal(f.submits(), 0);
  assert.deepEqual(errors, []);
});
