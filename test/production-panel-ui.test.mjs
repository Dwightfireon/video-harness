import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../lib/browser.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
const options = { skip: chromium ? false : '没有 playwright' };
const WWW = fileURLToPath(new URL('../www/', import.meta.url));

function viewFixture() {
  return { version: 1, readOnly: true,
    automation: { enabled: true, maxRepairs: 2, source: 'web-default', activePolicy: { enabled: true, maxRepairs: 2 } },
    task: { id: 'mock-task', attemptId: 'mock-attempt', status: 'failed', running: false, cancelling: false,
      repairRecovery: { blocked: false, canExtend: false, additionalRepairs: 0, used: 2, limit: 2, targetLimit: 2 },
      canResume: true, stage: 'measure', error: { message: '旁白超过上限 <img src=x onerror="window.xss=1"> ' + '长卡点'.repeat(90) }, pausedReason: null },
    repair: { used: 2, limit: 2, phase: 'stopped', lastIssue: '需要先删减脚本' },
    quality: { state: 'unverified', phase: 'final', checkedAt: '2026-10-24T10:00:00Z', verifiedAt: null,
      checks: [{ id: 'media', label: '带声成片', state: 'failed', issues: [{ message: '实测超时', hint: '删减后再继续' }] }],
      note: '仅机器检查；请试听', reason: null } };
}

/* 完全独立的静态 + mock API 服务：不启动 vh、不读取任何用户项目或凭证。 */
async function setup(width = 1280, { running = false } = {}) {
  const h = { view: viewFixture(), calls: [], readFailure: false, saveStatus: 409, stillsState: { state: 'idle' },
    cancelResult: { error: '模拟取消失败' }, cancelStatus: 409, resumeResult: { error: '模拟继续失败' }, resumeStatus: 409 };
  if (running) { h.view.task.status = 'running'; h.view.task.running = true; h.view.task.canResume = false; h.view.repair.phase = 'idle'; }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/_api/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      h.calls.push({ path: url.pathname, method: req.method, verify: url.searchParams.get('verify'), body });
      let value = {}, status = 200;
      if (url.pathname === '/_api/production') { value = h.readFailure ? { error: '模拟断连' } : h.view; status = h.readFailure ? 503 : 200; }
      else if (url.pathname === '/_api/production/settings') { value = { error: '任务已开始，设置未保存' }; status = h.saveStatus; }
      else if (url.pathname === '/_api/chat/cancel') { value = h.cancelResult; status = h.cancelStatus; }
      else if (url.pathname === '/_api/chat/resume') { value = h.resumeResult; status = h.resumeStatus; }
      else if (url.pathname === '/_api/chat') value = { ...h.view.task, taskId: h.view.task.id, mode: 'article',
        canRetry: h.view.task.canResume, taskRunning: h.view.task.running, productionBusy: false, orphanRunning: false,
        resumeNotice: '已有进度保留。', tail: 'mock log' };
      else if (url.pathname === '/_api/projects') value = { projects: [{ name: '恢复夹具', rel: 'fixture', videos: [],
        size: 0, cacheBytes: 0, dur: 0, task: { ...h.view.task, taskId: h.view.task.id } }] };
      else if (url.pathname === '/_api/state') value = { name: 'mock-只读测试', stale: {}, scenes: [], videos: [], subs: [], script: [], duration: 0, stillsCount: 0, sceneM: 0 };
      else if (url.pathname === '/_api/format') value = { aspectRatio: '16:9', width: 1920, height: 1080, taskRunning: h.view.task.running, pendingBuild: false };
      else if (url.pathname === '/_api/chat/memory') value = { memory: [] };
      else if (url.pathname === '/_api/stills') {
        if (req.method === 'POST' && h.stillsPostFailure) { value = { error: '另一项目正在截图' }; status = 409; }
        else { if (req.method === 'POST') h.stillsState = { state: 'running' }; value = h.stillsState; }
      }
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return;
    }
    if (url.pathname === '/fixture/scene.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><body>mock preview</body></html>'); return; }
    const name = url.pathname === '/' ? url.searchParams.has('p') ? 'player.html' : 'index.html'
      : url.pathname.startsWith('/_vh/') ? url.pathname.slice(5) : '';
    if (!name || name !== path.basename(name)) { res.writeHead(404); res.end(); return; }
    try {
      const data = await fs.readFile(path.join(WWW, name));
      res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css' : /\.(mjs|js)$/.test(name) ? 'application/javascript' : 'text/html' });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?p=fixture`);
    await page.waitForFunction(expected => document.querySelector('.production-summary')?.textContent === expected, running ? '正在制作' : '任务失败');
    assert.equal(await page.locator('#productionPanel').evaluate(node => node.open), !running, '阻塞展开卡点；正常运行保持摘要，不把预览挤出首屏');
    await page.locator('#productionPanel > summary').focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('#productionPanel').evaluate(node => node.open), running, '全局播放器快捷键不得拦截原生 details 键盘');
    await page.keyboard.press('Space');
    return { ...h, get data() { return h; }, page, errors,
      async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
  } catch (error) { await browser?.close(); await new Promise(resolve => server.close(resolve)); throw error; }
}

test('静帧按钮等待真实后台状态，不以已有张数冒充成功，失败可见', options, async () => {
  const h = await setup(), { page } = h;
  try {
    await page.locator('#reStills').click();
    await page.waitForFunction(() => document.querySelector('#stillsStatus').textContent.includes('正在重截'));
    await page.waitForTimeout(2300); // at least one ordinary state poll while capture is still running
    assert.equal(await page.locator('#reStills').isDisabled(), true);
    h.data.stillsState = { state: 'failed', message: 'fixture 截图失败' };
    await page.waitForFunction(() => document.querySelector('#stillsStatus').textContent.includes('fixture 截图失败'));
    assert.equal(await page.locator('#reStills').isDisabled(), false);
    await page.locator('#reStills').click();
    await page.waitForFunction(() => document.querySelector('#stillsStatus').textContent.includes('正在重截'));
    h.data.stillsState = { state: 'completed' };
    await page.waitForFunction(() => document.querySelector('#stillsStatus').textContent.includes('仍需逐张核对'));
    assert.equal(await page.locator('#reStills').isDisabled(), false);
    assert.equal(h.data.calls.filter(call => call.path === '/_api/stills' && call.method === 'POST').length, 2);
    h.data.stillsPostFailure = true; // previous status is still 'completed'
    await page.locator('#reStills').click();
    await page.waitForFunction(() => document.querySelector('#stillsStatus').textContent.includes('本次提交未确认'));
    assert.doesNotMatch(await page.locator('#stillsStatus').textContent(), /静帧生成完成/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('正常运行默认紧凑：摘要包含轮次与质量，预览保留在首屏', options, async () => {
  const h = await setup(1280, { running: true });
  try {
    assert.match(await h.page.locator('#productionPanel > summary').textContent(), /自动制作.*修复 2\/2.*旧回执/s);
    const geometry = await h.page.evaluate(() => ({ panel: document.querySelector('#productionPanel').getBoundingClientRect().height,
      preview: document.querySelector('#frameWrap').getBoundingClientRect().top, viewport: innerHeight }));
    assert.ok(geometry.panel < 100 && geometry.preview < geometry.viewport - 100, JSON.stringify(geometry));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const width of [1280, 390]) {
  test(`修复恢复真实浏览器 ${width}px：所有入口取消零POST、旧服务不假报授权、输入保留`, options, async () => {
    const h = await setup(width), { page } = h;
    try {
      h.data.view.task.repairRecovery = { blocked: true, canExtend: true, additionalRepairs: 2, used: 2, limit: 2, targetLimit: 4 };
      h.data.resumeStatus = 200;
      h.data.resumeResult = { task: { taskId: 'mock-task', attemptId: 'mock-attempt',
        automationSummary: { repairLimit: 2, repairUsed: 2 } } };
      const base = new URL(page.url()).origin;
      let allow = false;
      const dialogs = [];
      page.on('dialog', async dialog => {
        dialogs.push({ type: dialog.type(), message: dialog.message() });
        if (dialog.type() === 'confirm' && allow) await dialog.accept(); else await dialog.dismiss();
      });
      for (const entry of ['home', 'retry', 'composer', 'production']) {
        const selector = { home: '[data-retry]', retry: '#chatRetry', composer: '#chatSend', production: '[data-action="resume"]' }[entry];
        await page.goto(base + (entry === 'home' ? '/' : '/?p=fixture&tab=chat'));
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('追加2轮'), selector);
        if (entry !== 'home') await page.locator('#chatInput').fill('保留这段未提交的修改要求');
        const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(dimensions.scroll <= dimensions.width, `${entry}: ${JSON.stringify(dimensions)}`);
        const before = h.data.calls.filter(call => call.method === 'POST').length;
        allow = false;
        await page.locator(selector).click();
        await page.waitForFunction(selector => !document.querySelector(selector).disabled, selector);
        assert.equal(h.data.calls.filter(call => call.method === 'POST').length, before, entry + ': 取消不得提交');
        allow = true;
        await Promise.all([page.waitForResponse(response => response.url().includes('/_api/chat/resume')),
          page.locator(selector).click()]);
        if (entry === 'home') {
          await page.waitForFunction(() => !document.querySelector('[data-retry]').disabled);
          assert.ok(dialogs.some(dialog => dialog.type === 'alert' && /重启工作台/.test(dialog.message)));
        } else {
          const error = entry === 'production' ? '.production-status' : '#chatError';
          await page.waitForFunction(selector => document.querySelector(selector).textContent.includes('重启工作台'), error);
          assert.doesNotMatch(await page.locator(error).textContent(), /继续请求已接收/);
          assert.equal(await page.locator('#chatInput').inputValue(), '保留这段未提交的修改要求');
        }
        const posts = h.data.calls.filter(call => call.method === 'POST');
        assert.equal(posts.length, before + 1, entry + ': only one continue POST');
        assert.equal(posts.at(-1).path, '/_api/chat/resume');
        const sent = JSON.parse(posts.at(-1).body);
        assert.equal(sent.additionalRepairs, 2); assert.equal(sent.taskId, 'mock-task'); assert.equal(sent.attemptId, 'mock-attempt');
        if (entry === 'retry' || entry === 'composer') {
          // 输入框未发送的要求随同一个继续入口交给下一次执行，不能悄悄消失。
          assert.equal(sent.instruction, '保留这段未提交的修改要求');
        } else {
          // 首页卡片与制作面板没有该输入框，不能凭页面其它位置残留内容替用户提交。
          assert.equal(sent.instruction, undefined);
        }
      }
      assert.ok(dialogs.filter(dialog => dialog.type === 'confirm').every(dialog => /累计已用 2.*保留.*2→4.*8分钟.*模型、TTS 和渲染费用/s.test(dialog.message)));
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });

  test(`自动制作真实浏览器 ${width}px：完整页面无横向溢出、文本安全、409 保留设置`, options, async () => {
    const h = await setup(width);
    try {
      const { page } = h;
      assert.match(await page.locator('#productionPanel').textContent(), /默认生效.*当前任务实际模式/s);
      assert.equal(await page.locator('#productionPanel img').count(), 0); assert.equal(await page.evaluate(() => window.xss), undefined);
      await page.locator('.production-advanced > summary').click();
      await page.locator('[data-field="enabled"]').uncheck();
      await page.locator('[data-field="maxRepairs"]').selectOption('5');
      await page.locator('[data-action="save"]').click();
      await page.waitForFunction(() => document.querySelector('.production-settings').textContent.includes('保存失败'));
      await page.locator('[data-action="verify"]').click();
      await page.waitForFunction(() => document.querySelector('.production-status').textContent.includes('只读复核已返回'));
      assert.equal(await page.locator('[data-field="enabled"]').isChecked(), false);
      assert.equal(await page.locator('[data-field="maxRepairs"]').inputValue(), '5');
      assert.match(await page.locator('.production-settings').textContent(), /保存失败.*选择已保留/s);
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
        panel: document.querySelector('#productionPanel').getBoundingClientRect().right,
        body: document.querySelector('.production-body').scrollWidth,
        available: document.querySelector('.production-body').clientWidth }));
      assert.ok(dimensions.document <= dimensions.viewport, JSON.stringify(dimensions));
      assert.ok(dimensions.panel <= width, JSON.stringify(dimensions));
      assert.ok(dimensions.body <= dimensions.available, JSON.stringify(dimensions));
      assert.deepEqual(h.errors, []);
      assert.equal(h.data.calls.filter(call => call.method === 'POST').length, 1);
      assert.ok(h.data.calls.some(call => call.path === '/_api/production' && call.verify === '1'));
    } finally { await h.close(); }
  });
}

test('自动制作真实浏览器：继续失败不显示成功；断连保留旧检查并禁用付费动作', options, async () => {
  const h = await setup(390);
  try {
    await h.page.locator('[data-action="resume"]').click();
    await h.page.waitForFunction(() => document.querySelector('.production-status').textContent.includes('继续请求失败'));
    assert.match(await h.page.locator('.production-status').textContent(), /模拟继续失败.*没有自动重试/);
    h.data.readFailure = true;
    await h.page.locator('[data-action="verify"]').click();
    await h.page.waitForFunction(() => document.querySelector('.production-connection').textContent.includes('非实时'));
    assert.match(await h.page.locator('#productionPanel').textContent(), /实测超时/);
    assert.equal(await h.page.locator('[data-action="resume"]').isDisabled(), true);
    assert.equal(h.data.calls.filter(call => call.method === 'POST').length, 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('修复恢复真实浏览器：确认实际新限额才接收；5轮封顶且未来设置/核验不追加', options, async () => {
  const h = await setup(390), { page } = h;
  try {
    h.data.view.task.repairRecovery = { blocked: true, canExtend: true, additionalRepairs: 1, used: 4, limit: 4, targetLimit: 5 };
    h.data.resumeStatus = 200;
    h.data.resumeResult = { task: { taskId: 'mock-task', attemptId: 'next-attempt', status: 'starting', running: true,
      automationSummary: { enabled: true, repairUsed: 4, repairLimit: 5, repairPhase: 'idle' } } };
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-action="resume"]').textContent.includes('追加1轮'));
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-action="resume"]').click();
    await page.waitForFunction(() => document.querySelector('.production-status').textContent.includes('继续请求已接收'));
    assert.equal(h.data.calls.filter(call => call.method === 'POST').length, 1);
    h.data.view.task.repairRecovery = { blocked: true, canExtend: false, additionalRepairs: 0, used: 5, limit: 5, targetLimit: 5 };
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.production-help').textContent.includes('总上限 5'));
    assert.equal(await page.locator('[data-action="resume"]').isDisabled(), true);
    assert.equal(await page.locator('#chatRetry').isDisabled(), true);
    assert.equal(await page.locator('#chatSend').isDisabled(), true);
    await page.locator('.production-advanced > summary').click();
    await page.locator('[data-field="maxRepairs"]').selectOption('5');
    await page.locator('[data-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('.production-settings').textContent.includes('保存失败'));
    await page.locator('[data-action="verify"]').click();
    await page.waitForFunction(() => document.querySelector('.production-status').textContent.includes('只读复核已返回'));
    assert.equal(h.data.calls.filter(call => call.path === '/_api/chat/resume').length, 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('自动制作真实浏览器：取消失败不假报成功，收到 cancelling 等待退出且不可继续', options, async () => {
  const h = await setup();
  try {
    h.data.view.task.running = true; h.data.view.task.status = 'running';
    await h.page.locator('[data-action="verify"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-action="cancel"]').disabled);
    await h.page.locator('[data-action="cancel"]').click();
    await h.page.waitForFunction(() => document.querySelector('.production-status').textContent.includes('取消请求失败'));
    assert.doesNotMatch(await h.page.locator('.production-status').textContent(), /已取消|已退出/);
    h.data.cancelStatus = 200; h.data.cancelResult = { cancelling: true, cancelled: false };
    await h.page.locator('[data-action="cancel"]').click();
    await h.page.waitForFunction(() => document.querySelector('.production-status').textContent.includes('尚未确认停止'));
    assert.equal(await h.page.locator('[data-action="cancel"]').isDisabled(), true);
    assert.equal(await h.page.locator('[data-action="resume"]').isDisabled(), true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
