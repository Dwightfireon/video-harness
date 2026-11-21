import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { taskNotices } from '../www/task-notices.mjs';
import { beginTask, updateTask, resumeTask, taskStatus } from '../lib/task-status.mjs';
import { launchBrowser } from '../lib/browser.mjs';

const reason = '实测旁白超过时长上限，请删减脚本后继续。';
const missing = '缺少带声成片';
const pausedTask = () => ({ taskId: 'fixture-task', status: 'paused', mode: 'article', running: false,
  canResume: true, canRetry: true, error: null, pausedReason: reason, resumeNotice: '继续原任务，保留已有进度。',
  deliverableStale: missing, tail: 'mock log', since: Date.now() });

test('暂停原因优先，缺成片作为独立次级状态；兼容旧接口 resumeNotice', () => {
  assert.deepEqual(taskNotices(pausedTask()), { reason, deliverable: '产物状态：' + missing, warnings: [] });
  assert.equal(taskNotices({ ...pausedTask(), pausedReason: null }).reason, '继续原任务，保留已有进度。');
  assert.match(taskNotices({ status: 'paused' }).reason, /任务已暂停/);
  assert.deepEqual(taskNotices(), { reason: '', deliverable: '', warnings: [] });
});

test('具体失败优先于暂停说明；完成、取消和空闲不显示旧暂停原因', () => {
  const error = { kind: 'quota', message: '模型渠道额度不足' };
  for (const status of ['failed', 'interrupted', 'incomplete', 'paused']) {
    assert.equal(taskNotices({ ...pausedTask(), status, error }).reason, error.message);
  }
  for (const status of ['completed', 'cancelled', 'idle']) {
    assert.equal(taskNotices({ ...pausedTask(), status }).reason, '');
  }
});

test('运行警告只在结束后展示，不覆盖失败原因', () => {
  const task = { ...pausedTask(), status: 'failed', warnings: ['中断后已恢复', '  ', 3],
    error: { kind: 'quota', message: '额度不足' } };
  const notices = taskNotices(task);
  assert.deepEqual(notices.warnings, ['中断后已恢复']);
  assert.equal(notices.reason, '额度不足');
  assert.deepEqual(taskNotices({ ...task, running: true }).warnings, [], '运行中不提前报旧警告');
  // 已交付但收尾异常：不再用"任务未完成"吓人。
  const delivered = taskNotices({ status: 'failed', delivered: true, running: false,
    error: { kind: 'execution', message: '任务未完成。原始输入与执行日志已保留，请查看日志后重试。' } });
  assert.match(delivered.reason, /制作结果已交付/);
});

test('开始、运行、取消中不遗留历史原因与产物提示，但保留当前阻塞说明', () => {
  const old = { ...pausedTask(), error: { kind: 'execution', message: '上一轮失败' } };
  for (const state of [{ status: 'starting' }, { status: 'running' }, { running: true },
    { cancelling: true }, { status: 'cancelling' }, { orphanRunning: true }]) {
    assert.deepEqual(taskNotices({ ...old, ...state }), { reason: '', deliverable: '', warnings: [] });
  }
  for (const kind of ['cancelling', 'orphan', 'production']) {
    assert.equal(taskNotices({ ...old, running: true, error: { kind, message: '等待执行进程退出' } }).reason, '等待执行进程退出');
  }
});

test('taskStatus 单独提供 pausedReason；继续与完成后不泄漏旧原因，状态读取不改历史记录', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-task-notices-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  const task = beginTask(project, '制作夹具视频', 'article');
  updateTask(project, task.id, { status: 'paused', pausedReason: reason });
  const file = path.join(project, 'out/.vh-task.json'), before = fs.readFileSync(file, 'utf8');
  const paused = taskStatus(project);
  assert.equal(paused.pausedReason, reason);
  assert.equal(paused.resumeNotice, reason);
  assert.equal(paused.error, null);
  assert.ok(paused.deliverableStale);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(taskStatus(project, { includeDeliverable: false }).pausedReason, reason);
  resumeTask(project);
  const starting = taskStatus(project);
  assert.equal(starting.status, 'starting');
  assert.equal(starting.pausedReason, null);
  assert.equal(starting.deliverableStale, null);
  assert.notEqual(starting.resumeNotice, reason);
  updateTask(project, task.id, { status: 'completed', pausedReason: reason });
  assert.equal(taskStatus(project).pausedReason, null);
  updateTask(project, task.id, { status: 'paused', pausedReason: null });
  assert.match(taskStatus(project).pausedReason, /步数上限/);
});

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
const browserOptions = { skip: chromium ? false : '没有 playwright' };
const WWW = fileURLToPath(new URL('../www/', import.meta.url));

/* 独立静态页面 + mock API：不启动 vh、模型、TTS 或渲染，不读取用户项目。 */
async function setup(t, width) {
  const h = { task: pausedTask(), calls: [], allowResume: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/_api/')) {
      h.calls.push({ path: url.pathname, method: req.method });
      let value = {}, status = 200;
      if (req.method === 'POST' && url.pathname === '/_api/chat/resume' && h.allowResume) {
        h.task = { ...h.task, status: 'starting', running: true, canResume: false, canRetry: false };
        value = { task: h.task };
      }
      else if (req.method !== 'GET') { value = { error: '只读夹具拒绝执行' }; status = 405; }
      else if (url.pathname === '/_api/chat') value = h.task;
      else if (url.pathname === '/_api/projects') value = { projects: [{ name: '暂停夹具', rel: 'fixture',
        videos: [], size: 0, cacheBytes: 0, dur: 0, task: h.task }] };
      else if (url.pathname === '/_api/state') value = { name: '暂停夹具', stale: {}, scenes: [], videos: [],
        subs: [], script: [], duration: 0, stillsCount: 0, sceneM: 0 };
      else if (url.pathname === '/_api/format') value = { aspectRatio: '16:9', width: 1920, height: 1080, taskRunning: !!h.task.running };
      else if (url.pathname === '/_api/chat/memory') value = { memory: [] };
      else if (url.pathname === '/_api/production') value = { version: 1, readOnly: true,
        automation: { enabled: true, maxRepairs: 2 }, task: h.task, repair: { used: 0, limit: 2, phase: 'idle' },
        quality: { state: 'not-checked', checks: [] } };
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return;
    }
    if (url.pathname === '/fixture/scene.html') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>mock scene</title>'); return;
    }
    const name = url.pathname === '/' ? (url.searchParams.has('p') ? 'player.html' : 'index.html')
      : url.pathname.startsWith('/_vh/') ? url.pathname.slice(5) : '';
    if (!name || name !== path.basename(name)) { res.writeHead(404); res.end(); return; }
    try {
      const data = await fs.promises.readFile(path.join(WWW, name));
      res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css'
        : /\.(mjs|js)$/.test(name) ? 'application/javascript' : 'text/html' }); res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await launchBrowser(chromium);
  t.after(() => browser.close());
  h.page = await browser.newPage({ viewport: { width, height: 900 } });
  h.errors = []; h.page.on('pageerror', error => h.errors.push(error.message));
  h.url = 'http://127.0.0.1:' + server.address().port;
  return h;
}

test('指挥区继续按钮成功后立即清理旧提示，不把恢复成功文字留在错误区', browserOptions, async t => {
  const h = await setup(t, 1280), { page } = h;
  h.allowResume = true;
  await page.goto(h.url + '/?p=fixture&tab=chat');
  await page.waitForFunction(expected => document.querySelector('#chatError')?.textContent === expected, reason);
  await page.locator('#chatRetry').click();
  await page.waitForFunction(() => document.querySelector('#chatError').classList.contains('hidden') &&
    document.querySelector('#chatStale').classList.contains('hidden'));
  assert.equal(await page.locator('#chatError').textContent(), '');
  assert.equal(await page.locator('#chatStale').textContent(), '');
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), [{ path: '/_api/chat/resume', method: 'POST' }]);
  assert.deepEqual(h.errors, []);
});

for (const width of [1280, 390]) {
  test(`暂停原因真实页面 ${width}px：卡片和指挥区优先显示原因，轮询运行后清空旧提示`, browserOptions, async t => {
    const h = await setup(t, width), { page } = h;
    const unsafe = reason + ' <img src=x onerror="window.xss=1">';
    h.task.pausedReason = unsafe;
    await page.goto(h.url);
    await page.waitForFunction(expected => document.querySelector('.task-status')?.textContent.includes(expected), unsafe);
    const text = await page.locator('.card .meta').textContent();
    assert.ok(text.indexOf(unsafe) < text.indexOf('产物状态：' + missing));
    assert.doesNotMatch(await page.locator('.task-status').textContent(), /缺少带声成片/);
    assert.equal(await page.locator('.meta img').count(), 0);
    assert.equal(await page.evaluate(() => window.xss), undefined);
    // 只改 pausedReason（resumeNotice 不变），卡片签名也必须刷新。
    h.task.pausedReason = reason;
    await page.waitForFunction(expected => document.querySelector('.task-status')?.textContent.trim().endsWith(expected), reason);
    h.task = { ...h.task, status: 'running', running: true, canResume: false, canRetry: false };
    await page.waitForFunction(() => document.querySelector('.task-status b')?.textContent === '制作中');
    assert.doesNotMatch(await page.locator('.card .meta').textContent(), /实测旁白|产物状态/);

    h.task = pausedTask();
    await page.goto(h.url + '/?p=fixture&tab=chat');
    await page.waitForFunction(expected => document.querySelector('#chatError')?.textContent === expected, reason);
    assert.equal(await page.locator('#chatError').isVisible(), true);
    assert.equal(await page.locator('#chatStale').textContent(), '产物状态：' + missing);
    assert.equal(await page.locator('#chatStale').isVisible(), true);
    assert.equal(await page.locator('#chatRetry').isVisible(), true);
    h.task = { ...h.task, status: 'failed', error: { kind: 'quota', message: '模型渠道额度不足' } };
    await page.waitForFunction(() => document.querySelector('#chatError').textContent === '模型渠道额度不足');
    // 运行警告单独一行，不挤掉失败原因。
    h.task = { ...h.task, warnings: ['运行中曾出现网络连接中断，之后已恢复并继续'] };
    await page.waitForFunction(() => document.querySelector('#chatWarnings').textContent.includes('网络连接中断'));
    assert.equal(await page.locator('#chatError').textContent(), '模型渠道额度不足');
    h.task = { ...h.task, warnings: [] };
    await page.waitForFunction(() => document.querySelector('#chatWarnings').classList.contains('hidden'));
    assert.equal(await page.locator('#chatStale').textContent(), '产物状态：' + missing);
    h.task = { ...h.task, status: 'starting', running: true, canResume: false, canRetry: false };
    await page.waitForFunction(() => document.querySelector('#chatState').textContent.includes('制作进程启动中'));
    for (const id of ['chatError', 'chatStale']) {
      assert.equal(await page.locator('#' + id).textContent(), '');
      assert.equal(await page.locator('#' + id).isVisible(), false);
    }
    assert.equal(await page.locator('#chatRetry').isVisible(), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(h.errors, []);
    assert.ok(h.calls.every(call => call.method === 'GET'), '展示与轮询不自动继续任务');
  });
}
