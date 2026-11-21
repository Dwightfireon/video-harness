/* 真实事故：带着纸纹的片子永远渲染不出来 —— 每次 build/render 都抛
 * 「素材加载、解码失败或超时，不能生成可靠帧」，于是状态永远停在
 * 「成片还没生成」，用户点几次继续都是同一句话。
 *
 * 根因是 assetsReady() 抓 background-image 里的 url(...) 时用了
 *   /url\(["']?([^"')]+)["']?\)/
 * 这条正则只排除引号字符本身，**会钻进引号内部**：纸纹是一条内联 SVG data URI，
 * 里面自带 `filter='url(%23n)'`（SVG 滤镜引用），于是 `%23n` 被当成一个素材文件
 * 去加载 → ERR_FILE_NOT_FOUND → failed=1 → 严格模式抛错。
 * 全片每场都调 bg(root)，于是 7 场全假失败。
 *
 * 另一条同源事故（对比度检查器）：只采元素**外面**一圈像素，把「深字写在自己的
 * 浅色徽章上」误判成「深字压深卡」，12:1 的徽章报成 1.1:1，渲染被误拦。
 * 现在改成先抹掉文字再截图，在矩形内部采底色。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const readAsset = name => fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', name), 'utf8');

test('assetsReady：纸纹的内联 SVG 不会被当成素材文件', () => {
  const fx = readAsset('fx-block.html');
  // 旧写法（钻进引号内部）不能再出现
  assert.doesNotMatch(fx, /matchAll\(\/url\\\(\[\"'\]\?/, '不该再用会钻进引号内部的 url 正则');
  assert.match(fx, /topLevelUrls/, '应有一个"只取顶层 url(...)"的解析函数');
  // 纯片段引用（#mask / %23mask）必须被排除：它们指向文档内的 SVG 定义
  assert.match(fx, /startsWith\('#'\)/, '要显式跳过 #片段引用');
  assert.match(fx, /%\s*23|%23/i, '要显式跳过 %23 编码的 #片段引用');
});

test('assetsReady：顶层 url 解析对引号内的括号免疫（含纸纹真实片段）', () => {
  const fx = readAsset('fx-block.html');
  const body = fx.match(/const topLevelUrls = css => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(body, '找不到 topLevelUrls 的实现');
  // 直接跑函数体（把它包成可调用形式）
  const fn = new Function('css', `${body}\n return topLevelUrls(css);`);
  const grain = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>")`;
  const got = fn(grain);
  assert.equal(got.length, 1, '一条 data URI 只算一个 URL，不能把内部 url(%23n) 也算成素材：' + JSON.stringify(got));
  assert.match(got[0], /^data:image\/svg\+xml/, '取到的应当是整条 data URI');
  assert.deepEqual(fn('url(#mask)'), [], 'url(#mask) 是文档内引用，不是文件');
  assert.deepEqual(fn('url(%23mask)'), [], 'url(%23mask) 同上');
  assert.deepEqual(fn('url(./assets/a.png)'), ['./assets/a.png'], '普通相对路径要保留');
});

test('对比度实测：抹掉文字后再采样底色，自带底色的元素不被误判', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'contrast-rendered.mjs'), 'utf8');
  assert.match(src, /HIDE_TEXT_CSS/, '应有"抹掉文字"的注入样式');
  assert.match(src, /-webkit-text-fill-color:\s*transparent/, '要用 -webkit-text-fill-color 抹字，否则渐变字仍会留像素');
  // 采样点必须落在元素矩形内部（徽章/按钮的底色在自己身上）
  assert.match(src, /for \(let dx = 1; dx < w;/, '应在元素矩形内部网格采样，而不是只采外圈');
});
