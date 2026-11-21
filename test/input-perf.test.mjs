import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startServer } from '../lib/server.mjs';
import { launchBrowser } from '../lib/browser.mjs';

let chromium = null;
try { const m = await import('playwright'); chromium = m.default?.chromium || m.chromium; } catch {}
const SKIP = chromium ? false : '没有 playwright';
/* 本机 Playwright 只装了库、没下载浏览器二进制；用系统 Chrome 通道，
   避免整套 UI 回归测试因为缺少 chromium_headless_shell 而全部失败。 */
const LAUNCH = { headless: true, channel: 'chrome' };

function makeProject(root) {
  const proj = path.join(root, 'projects', 'p');
  fs.mkdirSync(path.join(proj, 'out'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(proj, '脚本.md'), '## S1 · x\n1. y\n');
  fs.writeFileSync(path.join(proj, 'scenes.src.js'), '//---\nx\n');
  fs.writeFileSync(path.join(proj, 'scene.html'), '<script>const DURATION=10;</script><script>const SUBS=[];</script>');
  return proj;
}

test('分页编辑器在真实页面里生效：超长文本只渲染一页，拼接后内容不丢', { skip: SKIP, timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-paged-ui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeProject(root);
  const server = startServer(root, 0, { root });
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser(chromium, LAUNCH);
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(url + '/');
  await page.waitForTimeout(1500);

  const text = await page.evaluate(() => {
    const unit = '这是正文内容测试，用来看换行密度。';
    let out = '';
    for (let i = 0; i < 3000; i++) out += unit.slice(0, 14) + '\n';
    return out;
  });
  await page.evaluate(t => {
    const ta = document.querySelector('#newInput');
    ta.focus(); ta.value = t;
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
  }, text);
  await page.waitForTimeout(500);

  const state = await page.evaluate(() => {
    const ta = document.querySelector('#newInput');
    const pager = document.querySelector('#pagerHost .pager');
    return { textareaChars: ta.value.length, pagerVisible: !!pager, pagerText: pager ? pager.textContent : '' };
  });
  assert.equal(state.pagerVisible, true, '超长文本应出现翻页控件');
  assert.ok(state.textareaChars <= 4200, `textarea 只应承载一页，实际 ${state.textareaChars}`);
  assert.match(state.pagerText, /全文 \d+ 字/);

  // 逐页收集，拼起来必须与原文一致
  const joined = await page.evaluate(async () => {
    const ta = document.querySelector('#newInput');
    for (let g = 0; g < 100; g++) {
      const prev = [...document.querySelectorAll('#pagerHost .pager button')].find(b => b.textContent.includes('上一页'));
      if (!prev || prev.disabled) break;
      prev.click(); await new Promise(r => setTimeout(r, 40));
    }
    let out = '';
    for (let g = 0; g < 100; g++) {
      out += ta.value;
      const next = [...document.querySelectorAll('#pagerHost .pager button')].find(b => b.textContent.includes('下一页'));
      if (!next || next.disabled) break;
      next.click(); await new Promise(r => setTimeout(r, 40));
    }
    return out;
  });
  assert.equal(joined, text, '分页拼接必须逐字还原');
  assert.deepEqual(errors, []);
});

test('首页轮询不会反复重建项目卡片（缩略图节点保持稳定）', { skip: SKIP, timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cardstable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = makeProject(root);
  fs.mkdirSync(path.join(proj, 'out', 'stills'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'out', '.vh-chat.log'), '· run {"command":"a"}\n');
  fs.writeFileSync(path.join(proj, 'out', '.vh-task.json'), JSON.stringify({
    schemaVersion: 1, id: 't', attemptId: 'a', attemptNumber: 1, status: 'running',
    message: 'p', mode: 'topic', pid: process.pid, startedAt: Date.now() - 1000,
    updatedAt: Date.now(), attemptStartedAt: Date.now() - 1000 }));
  const server = startServer(root, 0, { root });
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser(chromium, LAUNCH);
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage();
  await page.goto(url + '/');
  await page.waitForSelector('.card');
  const before = await page.evaluate(() => {
    const card = document.querySelector('.card');
    return { cards: document.querySelectorAll('.card').length, hasImg: !!card.querySelector('img') };
  });
  // 让任务"步数"变化，旧实现会因为 signature 变化而整页重建
  const logPath = path.join(proj, 'out', '.vh-chat.log');
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(logPath, '· run {"command":"step' + i + '"}\n');
    await page.waitForTimeout(2300);
  }
  const after = await page.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    hasImg: !!document.querySelector('.card').querySelector('img'),
  }));
  assert.equal(after.cards, before.cards, '卡片数量不应变化');
  assert.equal(after.hasImg, before.hasImg, '缩略图节点不应被销毁重建');
});
