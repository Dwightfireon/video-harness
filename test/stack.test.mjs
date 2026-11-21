import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/* stack 是浏览器端助手（依赖 offsetHeight），这里校验"它存在且不掉进已知坑"：
   ① 提供 row/slot/finish/bottom  ② 不写死行高（靠内容撑开）  ③ 间距可配 */
const FX = fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', 'fx-block.html'), 'utf8');

test('stack：导出 row / slot / finish / bottom', () => {
  const seg = FX.slice(FX.indexOf('function stack('), FX.indexOf('window.VH_UI = Object.assign(window.VH_UI || {}, { stack })'));
  for (const k of ['row(', 'slot(', 'finish(', 'get bottom']) assert.ok(seg.includes(k), '缺 ' + k);
});

test('stack：行高靠内容撑开（用 offsetHeight，不写死）', () => {
  const seg = FX.slice(FX.indexOf('function stack('), FX.indexOf('window.VH_UI = Object.assign(window.VH_UI || {}, { stack })'));
  assert.ok(seg.includes('offsetHeight'), '没有用 offsetHeight —— 会退回手算高度，可能挤压');
});

test('stack：间距与字号可配（gap / titleSize / descSize）', () => {
  const seg = FX.slice(FX.indexOf('function stack('), FX.indexOf('window.VH_UI = Object.assign(window.VH_UI || {}, { stack })'));
  for (const k of ['gap', 'titleSize', 'descSize', 'lineGap']) assert.ok(seg.includes(k), '缺配置项 ' + k);
});

test('stack：说明行行高按字号算（1.6 倍），不会压住下一行', () => {
  const seg = FX.slice(FX.indexOf('function stack('), FX.indexOf('window.VH_UI = Object.assign(window.VH_UI || {}, { stack })'));
  assert.ok(/descSize \* 1\.6/.test(seg), '说明行行高未按 1.6 倍计算');
});
