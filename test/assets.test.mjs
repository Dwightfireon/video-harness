import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { add, list, check, imageSize, parseCsv, chartSvg, assetsDir } from '../lib/assets.mjs';

/* 真实素材：为什么值得测
   纯 CSS 画的框"能看懂"但观众不会"相信"。素材接入最危险的地方是
   **引用了不存在的文件却完全不报错**——画面上一片空白，检查全绿。
   这里锁定：能收进来、能查出缺失、能出真图表。 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-asset-'));

/* 造一张最小 PNG（1x1 也行，只为验证尺寸解析） */
function makePng(p, w = 1280, h = 800) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
}

test('asset：收进项目 assets/，重名自动加序号', () => {
  const d = tmp();
  const src = path.join(d, 'shot.png');
  makePng(src);
  const a1 = add(d, src);
  const a2 = add(d, src);
  assert.equal(a1.rel, 'assets/shot.png');
  assert.equal(a2.rel, 'assets/shot-2.png');
  assert.equal(a1.size.w, 1280);
  assert.equal(a1.size.h, 800);
});

test('asset：解析 PNG 尺寸', () => {
  const d = tmp();
  const p = path.join(d, 'x.png');
  makePng(p, 1920, 1080);
  const s = imageSize(p);
  assert.deepEqual([s.w, s.h, s.type], [1920, 1080, 'png']);
});

test('asset：引用了不存在的文件 → 报 missing（不是静默空白）', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'scenes.src.js'),
    `root => { VH_UI.shotEl(root, 'assets/nope.png', 0,0,100,100); return {}; }`, 'utf8');
  const r = check(d);
  assert.ok(r.findings.some(f => f.kind === 'missing'), JSON.stringify(r.findings));
  assert.match(r.findings[0].msg, /nope\.png/);
});

test('asset：引用的文件都在 → 不报 missing', () => {
  const d = tmp();
  fs.mkdirSync(assetsDir(d), { recursive: true });
  makePng(path.join(assetsDir(d), 'ok.png'));
  fs.writeFileSync(path.join(d, 'scenes.src.js'),
    `root => { VH_UI.shotEl(root, 'assets/ok.png', 0,0,100,100); return {}; }`, 'utf8');
  const r = check(d);
  assert.deepEqual(r.findings.filter(f => f.kind === 'missing'), []);
});

test('asset：图片太小会糊 → 报 small', () => {
  const d = tmp();
  fs.mkdirSync(assetsDir(d), { recursive: true });
  makePng(path.join(assetsDir(d), 'tiny.png'), 400, 300);
  fs.writeFileSync(path.join(d, 'scenes.src.js'),
    `root => { VH_UI.shotEl(root, 'assets/tiny.png', 0,0,100,100); return {}; }`, 'utf8');
  const r = check(d);
  assert.ok(r.findings.some(f => f.kind === 'small'), JSON.stringify(r.findings));
});

test('asset：没被引用的素材会被列出来（占体积）', () => {
  const d = tmp();
  fs.mkdirSync(assetsDir(d), { recursive: true });
  makePng(path.join(assetsDir(d), 'unused.png'));
  fs.writeFileSync(path.join(d, 'scenes.src.js'), `root => { bg(root); return {}; }`, 'utf8');
  const r = check(d);
  assert.ok(r.findings.some(f => f.kind === 'unused'), JSON.stringify(r.findings));
});

test('asset：CSV 解析（逗号/制表符都认）', () => {
  const a = parseCsv('name,value\na,10\nb,20');
  assert.deepEqual(a.header, ['name', 'value']);
  assert.equal(a.rows.length, 2);
  assert.ok(a.numeric);
  const b = parseCsv('name\tvalue\na\t1');
  assert.equal(b.rows[0][1], '1');
});

test('asset：图表是真 SVG（有坐标轴刻度，不是几个 div 假装）', () => {
  const svg = chartSvg({ items: [{ label: '默认', value: 100 }, { label: '需要', value: 240 }], w: 600, h: 400 });
  assert.match(svg, /^<svg/);
  assert.match(svg, /<line[^>]*stroke-opacity/);            // 网格线
  assert.match(svg, /font-family="ui-monospace,monospace"/); // 轴刻度数字
  assert.match(svg, /240/);                                  // 数值标注
  assert.match(svg, /viewBox/);                              // 可缩放（横竖屏通用）
});

test('asset：图表坐标轴取整（刻度是可读的数，不是 237.3）', () => {
  const svg = chartSvg({ items: [{ label: 'a', value: 237 }], w: 600, h: 400 });
  const ticks = [...svg.matchAll(/>([\d.]+)<\/text>/g)].map(m => +m[1]);
  assert.ok(ticks.length > 0);
  // 刻度应为 0 / 62.5 / 125 / 187.5 / 250 这类整齐值（nice number）
  assert.ok(ticks.includes(0), JSON.stringify(ticks));
  const maxTick = Math.max(...ticks);
  assert.ok(maxTick >= 237, '顶部刻度要覆盖最大值：' + JSON.stringify(ticks));
  assert.ok(maxTick % 50 === 0 || maxTick % 25 === 0, '顶部应为整刻度：' + maxTick);
});

test('asset：空数据不出图（不返回半个 SVG）', () => {
  assert.equal(chartSvg({ items: [] }), '');
});

test('asset：折线图也支持', () => {
  const svg = chartSvg({ type: 'line', items: [{ label: '1月', value: 10 }, { label: '2月', value: 30 }] });
  assert.match(svg, /<polyline/);
  assert.match(svg, /<circle/);
});

/* ---------- 素材就绪守门（assetsReady） ---------- */
test('assetsReady：注入块里有"等图片解码"的实现', () => {
  const fx = fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', 'fx-block.html'), 'utf8');
  assert.match(fx, /function assetsReady/, '应有 assetsReady');
  assert.match(fx, /\.decode\(\)/, '必须调 decode()：onload 只代表拿到数据，decode 才代表能画');
  assert.match(fx, /backgroundImage/, '背景图也要等（背景图没有 onload 事件）');
  assert.match(fx, /querySelectorAll\('video'\)/, '视频也要等 loadeddata');
  assert.match(fx, /setTimeout\([^,]+, timeout\)/, '必须有超时兜底，否则坏图会永远卡住');
});

test('assetsReady：坏图及时结束等待，正式帧严格模式报错而非静默出空白', () => {
  const fx = fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', 'fx-block.html'), 'utf8');
  assert.match(fx, /addEventListener\('error', done/, '加载失败也要放行');
  assert.match(fx, /if \(opt\.strict && failed\) throw/);
});

test('assetsReady：统一生成出口安装可 await 的帧屏障，不异步回零', () => {
  const gen = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib/generator-metadata.mjs'), 'utf8');
  const runtime = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib/frame-runtime.mjs'), 'utf8');
  assert.match(gen, /injectFrameRuntime/);
  assert.match(runtime, /window\.__ready/);
  assert.match(runtime, /__vhMediaPending/);
});
