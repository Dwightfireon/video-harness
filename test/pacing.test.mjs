import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyze, report, parsePsnr, summarizePsnrs } from '../lib/pacing.mjs';
import { launchBrowser } from '../lib/browser.mjs';

test('pacing：最长连续低差不等于低差总和', () => {
  const r = summarizePsnrs([99, 99, 20, 99, 99], [0, 5, 10, 15, 20, 25]);
  assert.equal(r.stillSeconds, 10);
  assert.equal(r.stillStreak, 2);
  assert.equal(summarizePsnrs([99, 99, 99], [1, 3, 8, 15]).stillSeconds, 14);
  assert.equal(summarizePsnrs([20, 20], [0, 5, 10]).stillSeconds, 0);
  assert.throws(() => summarizePsnrs([99, null], [0, 1, 2]), /样本/);
  assert.throws(() => summarizePsnrs([99], [0, 0]), /递增/);
});

test('pacing：ffmpeg 缺失、失败、无结果都必须报错', () => {
  assert.equal(parsePsnr({ status: 0, stderr: '[psnr] average:inf min:inf\n' }), 99);
  assert.equal(parsePsnr({ status: 0, stderr: '[psnr] average:47.25 min:44\n' }), 47.25);
  for (const result of [
    { status: 1, stderr: 'average:99\n' },
    { status: null, error: new Error('ENOENT') },
    { status: null, signal: 'SIGTERM' },
    { status: 0, stderr: '' },
    { status: 0, stderr: 'average:nan' },
    { status: 0, stderr: 'average:42broken' },
  ]) assert.throws(() => parsePsnr(result), /ffmpeg/);
});

test('pacing：报告不把长停或运动得分当审美硬判', () => {
  const text = report({ scenes: [{ n: 1, dur: 30, activity: 0, stillSeconds: 20 }], findings: [{ scene: 1, msg: '待复核' }] });
  assert.match(text, /人工复核/);
  assert.match(text, /像素抽样启发式/);
  assert.match(text, /不能据此断言看过成片/);
  assert.doesNotMatch(text, /太长|修法|✓|加 drift/);
});

test('pacing：非法 samples 在启动浏览器前拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pacing-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'scene.html'), '<script>addScene(0,30)</script>');
    for (const samples of [0, 1, -1, 2.5, NaN, Infinity]) assert.match((await analyze(dir, { samples })).error, /samples/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pacing：浏览器/ffmpeg 验证相对 assets、失败返回与本轮临时目录清理', async t => {
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await launchBrowser(chromium, { headless: true });
    await browser.close();
  } catch (error) {
    if (/Cannot find package|缺少无头浏览器|Executable doesn't exist/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('没有 ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pacing-browser-'));
  const untouched = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pace-unrelated-'));
  const before = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vh-pace-')).sort();
  const initial = before();
  const oldPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(path.join(dir, 'out', '.pacing-scene.html'), 'keep existing user file');
    fs.writeFileSync(path.join(dir, 'assets', 'test.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>');
    const html = `<style>body{margin:0;background:black}#subs,#subbox,#bar{position:fixed;inset:0}</style>
      <img id="asset" src="assets/test.svg"><div id="subs"></div><div id="subbox"></div><div id="bar"></div><script>
      window.W=108;window.H=192;window.__ready=document.getElementById('asset').decode();
      function addScene(){}addScene(0,30);
      window.renderAt=t=>{if(document.getElementById('asset').naturalWidth!==16)throw new Error('relative asset missing');
      for(const id of ['subs','subbox','bar'])document.getElementById(id).style.background=t<15?'black':'white';};</script>`;
    fs.writeFileSync(path.join(dir, 'scene.html'), html);
    const r = await analyze(dir, { samples: 3 });
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.scenes[0].stillSeconds, 20);
    assert.equal(r.findings.length, 1);
    assert.deepEqual(before(), initial);
    assert.equal(fs.readFileSync(path.join(dir, 'out', '.pacing-scene.html'), 'utf8'), 'keep existing user file');

    // ffmpeg 不可用不能产生“检查通过”，也不能留下截图目录。
    process.env.PATH = dir;
    const failed = await analyze(dir, { samples: 2 });
    process.env.PATH = oldPath;
    assert.equal(failed.ok, false);
    assert.match(failed.error, /ffmpeg/);
    assert.deepEqual(before(), initial);

    fs.writeFileSync(path.join(dir, 'scene.html'), html.replace('window.renderAt=t=>{', "window.renderAt=t=>{throw new Error('fixture render failure');"));
    const renderFailed = await analyze(dir, { samples: 2 });
    assert.equal(renderFailed.ok, false);
    assert.match(renderFailed.error, /fixture render failure/);
    assert.deepEqual(before(), initial);
    assert.ok(fs.existsSync(untouched));
  } finally {
    if (oldPath == null) delete process.env.PATH; else process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(untouched, { recursive: true, force: true });
  }
});
