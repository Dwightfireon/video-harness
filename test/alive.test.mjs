import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, report, sampleTimes, summarizeDiffs, prepareSamplingPage } from '../lib/alive.mjs';
import { launchBrowser } from '../lib/browser.mjs';

test('alive：步长校验和尾段时间使用实际秒数', () => {
  for (const step of [0, -1, NaN, Infinity, '1']) assert.throws(() => sampleTimes(5, step), /step/);
  assert.deepEqual(sampleTimes(2.25, 0.5), [0, 0.5, 1, 1.5, 2, 2.25]);
  assert.deepEqual(sampleTimes(4, 2), [0, 2, 4]);
  const result = summarizeDiffs([3, 0, 0, 0, 3], sampleTimes(2.25, 0.5), [[0, 2.25]], [0]);
  assert.equal(result.totalSeconds, 2.25);
  assert.equal(result.visibleSeconds, 0.75);
  assert.equal(result.ratio, 33);
  assert.equal(result.scenes[0].quietSeconds, 1.5);
});

test('alive：不同步长均按时长统计，maxStillAt 是起点', () => {
  for (const step of [0.5, 1, 2]) {
    const times = sampleTimes(8, step);
    const r = summarizeDiffs(times.slice(1).map(() => 0), times, [[0, 8]], [0]);
    const start = times.find(t => t >= 0.5);
    assert.equal(r.totalSeconds, 8);
    assert.equal(r.visibleSeconds, 0);
    assert.equal(r.scenes[0].maxStill, 8 - start);
    assert.equal(r.scenes[0].maxStillAt, start);
    assert.equal(r.scenes[0].quietSeconds, 8 - start);
    assert.equal(r.findings.length, 1);
    assert.ok(r.findings[0].msg.includes(`从 ${start}s 起`));
  }
});

test('alive：非网格场景边界与转场保护区不能错配到相邻样本', () => {
  const r = summarizeDiffs([0, 0, 90, 0, 0, 0], sampleTimes(6, 1), [[0, 2.2], [2.2, 6]], [0, 0]);
  assert.equal(r.scenes[0].samples, 1); // 1–2；2–3 跨场，丢弃。
  assert.equal(r.scenes[1].samples, 3); // 3–4、4–5、5–6。
  assert.equal(r.scenes[1].minDiff, 0);
  assert.equal(r.scenes[1].maxStill, 3);
  assert.equal(r.scenes[1].maxStillAt, 3);
  const guarded = summarizeDiffs([0, 0, 0, 0], sampleTimes(4, 1), [[0, 4]], [1.5]);
  assert.equal(guarded.scenes[0].samples, 2);
  assert.equal(guarded.scenes[0].maxStillAt, 2);
});

test('alive：最长低差是连续区间，不是累计；不设 50% 运动配额', () => {
  const r = summarizeDiffs([0, 0, 0, 5, 0, 0, 0, 5, 0, 0], sampleTimes(10, 1), [[0, 10]], [0]);
  assert.equal(r.scenes[0].maxStill, 3);
  assert.equal(r.scenes[0].maxStillAt, 4);
  assert.equal(r.scenes[0].quietSeconds, 7);
  assert.equal(r.findings.length, 0);
  const text = report({ ...r, dur: 10, threshold: 1.2 });
  assert.match(text, /启发式/);
  assert.match(text, /不能据此断言看过成片/);
  assert.doesNotMatch(text, /drift|观众会走神|✓ 每秒|人眼能感知的门槛/);
});

test('alive：缺失场景与非法步长返回错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-alive-test-'));
  try {
    assert.match((await analyze(dir)).error, /scene.html/);
    fs.writeFileSync(path.join(dir, 'scene.html'), '<html></html>');
    for (const step of [0, -1, NaN, Infinity]) assert.match((await analyze(dir, { step })).error, /step/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('alive：浏览器验证完整横竖画幅和字幕/进度条排除', async t => {
  let chromium, browser;
  try {
    ({ chromium } = await import('playwright'));
    browser = await launchBrowser(chromium, { headless: true });
  } catch (error) {
    if (/Cannot find package|缺少无头浏览器|Executable doesn't exist/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-alive-browser-'));
  const file = path.join(dir, 'scene.html');
  try {
    for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
      fs.writeFileSync(file, `<style>body{margin:0;background:black}#subject{position:absolute;left:${width / 2}px;top:${height / 2}px;width:${width / 2}px;height:${height / 2}px}</style>
        <div id="subject"></div><script>window.W=${width};window.H=${height};window.DURATION=1;
        function addScene(){}addScene(0,1);window.renderAt=t=>document.getElementById('subject').style.background=t<.5?'black':'white';</script>`);
      const result = await analyze(dir);
      assert.equal(result.error, undefined);
      assert.ok(result.diffs[0] > 40, `必须包含原 960×540 之外的运动：${JSON.stringify(result)}`);
    }
    fs.writeFileSync(file, `<style>body{margin:0;background:black}#subs,#subbox,#bar{position:fixed;inset:0}</style>
      <div id="subs"></div><div id="subbox"></div><div id="bar"></div><script>
      window.W=1080;window.H=1920;window.DURATION=1;function addScene(){}addScene(0,1);
      window.renderAt=t=>{for(const id of ['subs','subbox','bar']) document.getElementById(id).style.background=t<.5?'black':'white'};</script>`);
    const page = await browser.newPage();
    assert.deepEqual(await prepareSamplingPage(page, file), { width: 1080, height: 1920 });
    assert.deepEqual(await page.evaluate(() => ['subs', 'subbox', 'bar'].map(id => getComputedStyle(document.getElementById(id)).display)), ['none', 'none', 'none']);
    const result = await analyze(dir);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.diffs, [0]);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
