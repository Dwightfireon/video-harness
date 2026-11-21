import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { startServer } from '../lib/server.mjs';
import { beginTask, readTask, taskStatus, updateTask } from '../lib/task-status.mjs';
import { queueTaskInstruction } from '../lib/runners/index.mjs';
import { renderChatSubmitFailure } from '../www/chat-submit-errors.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-chat-submit-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects/work'), home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(project, 'PROJECT.json'), JSON.stringify({ runner: 'opencode' }));
  fs.writeFileSync(path.join(project, 'out/.vh-runner.json'), JSON.stringify({ sessionId: 'fixture-session', service: 'private' }));
  return { root, project, home };
}

test('不能实时插话时把原文写入当前任务的恢复指令，不写无人读取的旧队列', async t => {  const f = fixture(t), task = beginTask(f.project, '原目标', 'edit');
  updateTask(f.project, task.id, { status: 'running', pid: process.pid });
  const result = await queueTaskInstruction(f.project, { message: '把第二场标题改短', taskId: task.id,
    attemptId: task.attemptId, mode: 'edit' });
  assert.equal(result.ok, true); assert.equal(result.reason, 'saved-for-resume');
  const saved = readTask(f.project).resumeInstructions;
  assert.equal(saved.length, 1); assert.equal(saved[0].content, '把第二场标题改短');
  assert.equal(saved[0].source, 'chat-running-submit');
  assert.equal(fs.existsSync(path.join(f.project, 'out/.vh-steer.json')), false);
  assert.equal((await queueTaskInstruction(f.project, { message: '过期要求', taskId: 'old', attemptId: task.attemptId })).ok, false);
  updateTask(f.project, task.id, { status: 'failed', pid: null });
  assert.equal(readTask(f.project).resumeInstructions.length, 1, '错误任务身份不能追加');
  const resumed = (await import('../lib/task-status.mjs')).resumeTask(f.project, '把第二场标题改短');
  assert.equal(resumed.resumeInstructions.length, 1, '继续时不能重复注入已保存的同一条补充指令');
});

test('运行中 private session 返回可操作的持久失败信息；输入保留，旧队列不生成', async t => {
  const f = fixture(t), server = startServer(null, 0, { root: f.root, home: f.home });
  await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  const task = beginTask(f.project, '原目标', 'edit');
  updateTask(f.project, task.id, { status: 'running', pid: process.pid });
  const response = await fetch(base + '/_api/chat?p=projects%2Fwork', { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ message: '补充：第二场改成竖屏', mode: 'edit', intent: 'continue' }) });
  assert.equal(response.status, 409); const body = await response.json();
  assert.equal(body.savedForResume, true); assert.match(body.error, /没有插进正在执行的步骤|不能可靠地实时插话/);
  assert.match(body.error, /已完整保存到原任务/); assert.match(body.error, /继续原任务/);
  const saved = readTask(f.project).resumeInstructions;
  assert.equal(saved.length, 1); assert.equal(saved[0].content, '补充：第二场改成竖屏');
  assert.equal(fs.existsSync(path.join(f.project, 'out/.vh-steer.json')), false);
});

test('提交失败提示是持久 UI 状态：轮询状态区变化不隐藏它；成功/关闭才移除', () => {
  const el = { textContent: '', classList: { hidden: false, add() { this.hidden = true; }, remove() { this.hidden = false; } } };
  renderChatSubmitFailure(el, { title: '补充指令未送达', message: '原因\n输入已保留' });
  assert.equal(el.textContent, '补充指令未送达：原因\n输入已保留'); assert.equal(el.classList.hidden, false);
  renderChatSubmitFailure(el, { title: '补充指令未送达', message: '原因\n输入已保留' });
  assert.equal(el.classList.hidden, false);
  renderChatSubmitFailure(el, null);
  assert.equal(el.textContent, ''); assert.equal(el.classList.hidden, true);
});

async function pageFixture(t) {
  const h = { chat: { status: 'running', running: true, taskId: 'fixture', attemptId: 'attempt', mode: 'article',
    canResume: false, canRetry: false, tail: 'running log' }, posts: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let text = ''; for await (const chunk of req) text += chunk;
    if (url.pathname === '/_api/chat' && req.method === 'POST') {
      h.posts.push(text);
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '已完整保存到原任务；先停止，再继续。', savedForResume: true, delivered: false })); return;
    }
    if (url.pathname.startsWith('/_api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(url.pathname === '/_api/chat' ? h.chat : url.pathname === '/_api/projects'
        ? { projects: [{ name: 'fixture', rel: 'projects/fixture', videos: [], task: h.chat }] }
        : url.pathname === '/_api/state' ? { scenes: [], videos: [], subs: [], script: [], duration: 0, stillsCount: 0, sceneM: 0 }
          : url.pathname === '/_api/format' ? { aspectRatio: '16:9', taskRunning: true }
            : { memory: [] })); return;
    }
    const name = url.pathname === '/' ? 'player.html' : url.pathname.startsWith('/_vh/') ? url.pathname.slice(5) : '';
    if (!name || name !== path.basename(name)) { res.writeHead(404); res.end(); return; }
    try { const data = fs.readFileSync(new URL('../www/' + name, import.meta.url)); res.writeHead(200, { 'content-type': name.endsWith('.js') || name.endsWith('.mjs') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(data); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchBrowser(chromium);
  t.after(async () => { await browser.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?p=projects/fixture&tab=chat`);
  await page.waitForFunction(() => document.querySelector('#chatSend')?.textContent === '补充指令 →');
  return { h, page, errors };
}

test('真实页面：运行中补充指令失败后提示不会一闪而过，输入保留且不会自动重试', async t => {
  const { h, page, errors } = await pageFixture(t);
  await page.locator('#chatInput').fill('把第二场改成竖屏');
  await page.locator('#chatSend').click();
  await page.waitForFunction(() => document.querySelector('#chatSubmitError')?.textContent.includes('已完整保存到原任务'));
  assert.equal(await page.locator('#chatSubmitError').isVisible(), true);
  assert.equal(await page.locator('#chatInput').inputValue(), '把第二场改成竖屏');
  await page.waitForTimeout(4200); // 跨过两轮聊天 + 状态轮询
  assert.match(await page.locator('#chatSubmitError').textContent(), /补充指令|已完整保存到原任务/);
  assert.equal(await page.locator('#chatSubmitError').isVisible(), true, '轮询不得冲掉提交失败');
  assert.equal(h.posts.length, 1, '失败不能自动重试');
  await page.locator('#chatSubmitError').click();
  assert.equal(await page.locator('#chatSubmitError').isVisible(), false);
  assert.deepEqual(errors, []);
});
