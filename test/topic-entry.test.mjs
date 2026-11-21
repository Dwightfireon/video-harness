import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startServer } from '../lib/server.mjs';
import { beginTask, readTask, updateTask, taskStatus, retryInput } from '../lib/task-status.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { readCheckpoint } from '../lib/checkpoint.mjs';

const SKILL = path.join(process.env.HOME, '.config/opencode/skills/article-video');
const providers = () => [{ provider: 'opendesign', model: 'deepseek/deepseek-v4.1-flash' },
  { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }];
async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-topic-entry-'));
  fs.mkdirSync(path.join(root, 'projects')); const home = path.join(root, 'home');
  const calls = [];
  const model = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => { raw += b; });
    req.on('end', () => {
      calls.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json');
      if (options.executeTool && calls.length === 1) {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'dispatch-proof', type: 'function', function: { name: 'append_file', arguments:
            JSON.stringify({ path: '方案.md', content: '\n<!-- topic worker executed a real tool -->\n' }) } }] }, finish_reason: 'tool_calls' }] }));
      } else { res.writeHead(400); res.end(JSON.stringify({ error: { code: 'quota_exhausted' } })); }
    });
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const base = 'http://127.0.0.1:' + model.address().port;
  for (const sub of ['.config/opencode', '.local/share/opencode']) fs.mkdirSync(path.join(home, sub), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/opencode/opencode.jsonc'), JSON.stringify({ provider: {
    opendesign: { options: { baseURL: base + '/od' } }, commandcode: { options: { baseURL: base + '/cc' } },
  } }));
  fs.writeFileSync(path.join(home, '.local/share/opencode/auth.json'), JSON.stringify({ commandcode: { key: 'fixture-only' } }));
  const server = startServer(root, 0, { root, providerInfo: providers,
    // 这个 fixture 用假模型服务器验证派发链路，所以固定走本地循环；
    // 真实新工程默认是 opencode（见 vh new 写入的 runner 配置）。
    agentEnv: { ...process.env, HOME: home, OPEN_DESIGN_API_KEY: 'fixture-only', ARTICLE_VIDEO_SKILL_DIR: SKILL, VH_RUNNER: 'local' }, ...options });
  await once(server, 'listening');
  t.after(async () => {
    for (const name of fs.readdirSync(path.join(root, 'projects'))) {
      const task = readTask(path.join(root, 'projects', name));
      if (task?.pid && task.pid !== process.pid && ['starting', 'running'].includes(task.status)) {
        try { process.kill(-task.pid, 'SIGTERM'); } catch {}
      }
    }
    server.closeAllConnections(); model.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => model.close(r))]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, calls, url: 'http://127.0.0.1:' + server.address().port };
}
async function pageFor(t, url) {
  const browser = await launchBrowser(chromium, { headless: true, args: ['--mute-audio'] });
  t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); await page.goto(url);
  return { page, errors };
}

test('旧网页项目继续任务无需CLI启用：先保存自动策略，实际worker沿用且不重置任务身份', { timeout: 15000 }, async t => {
  const env = await setup(t), project = path.join(env.root, 'projects/legacy');
  fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  const task = beginTask(project, '继续把材料做成视频', 'article');
  updateTask(project, task.id, { status: 'failed', automation: { enabled: false, maxRepairs: 2 } }, task.attemptId);
  const result = await fetch(env.url + '/_api/chat/resume?p=projects%2Flegacy', { method: 'POST' });
  assert.equal(result.status, 200, await result.text());
  const end = Date.now() + 10000;
  while (Date.now() < end && !(readTask(project)?.status === 'failed' && readTask(project)?.attemptId !== task.attemptId)) await delay(40);
  const current = readTask(project);
  assert.equal(current.id, task.id); assert.notEqual(current.attemptId, task.attemptId); assert.equal(current.status, 'failed');
  assert.equal(current.automation.enabled, true);
  assert.equal(readCheckpoint(project, task.id).automation.enabled, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'))), {}, '不擅自改写旧项目配置');
});

test('真实页面选题入口：按钮→API→CLI→工具执行→额度失败可见，刷新保留且仅手动重试', { timeout: 30000 }, async t => {
  const env = await setup(t, { executeTool: true });
  const { page, errors } = await pageFor(t, env.url);
  assert.match(await page.textContent('#automationHint'), /直接开始.*不会自动发布.*加入队列只保存/);
  const idea = '调研这个开源项目 https://example.test/project\n结尾保留用户指定的内容；不要把 --mode 或目录拼进选题。';
  await page.locator('.choice:has(input[value="topic"])').click();
  await page.fill('#newInput', idea); await page.locator('#composerSettings > summary').click(); await page.click('#advBtn'); await page.fill('#newName', 'topic-entry');
  await page.click('#newBtn');
  try { await page.waitForSelector('.task-status.error', { timeout: 15000 }); }
  catch (error) {
    throw new Error(JSON.stringify({ message: error.message, page: await page.textContent('#newMsg'),
      calls: env.calls.length, task: readTask(path.join(env.root, 'projects/topic-entry')),
      state: taskStatus(path.join(env.root, 'projects/topic-entry')), errors }, null, 2));
  }
  assert.match(await page.textContent('.task-status.error'), /额度不足/);
  const project = path.join(env.root, 'projects/topic-entry');
  assert.equal(fs.readFileSync(path.join(project, 'materials/选题.md'), 'utf8').trim(), idea);
  const proof = '\n<!-- topic worker executed a real tool -->\n';
  const plan = fs.readFileSync(path.join(project, '方案.md'), 'utf8');
  assert.ok(plan.endsWith(proof), '当前方案阶段必须真实追加作者文件');
  assert.equal(plan.split(proof).length - 1, 1);
  const first = readTask(project); assert.equal(first.status, 'failed'); assert.equal(first.mode, 'topic');
  assert.deepEqual(first.automation, { enabled: true, maxRepairs: 2 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'))).automation.enabled, true);
  assert.equal(readCheckpoint(project, first.id).automation.enabled, true, '实际CLI执行器必须接收网页自动策略');
  assert.equal(first.error.kind, 'quota');
  assert.match(env.calls[0].messages[1].content, /任务：给一个选题/);
  assert.equal(env.calls[0].messages[1].content.split('用户的指令是：\n')[1], idea);
  const callCount = env.calls.length;
  const firstMtime = fs.statSync(path.join(project, '方案.md')).mtimeMs;
  await page.reload(); await page.waitForSelector('.task-status.error');
  await page.waitForTimeout(2100); assert.equal(env.calls.length, callCount, '刷新或轮询不得自动重试');
  await page.click('[data-retry="projects/topic-entry"]');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const s = taskStatus(project);
    if (s.attemptId !== first.attemptId && s.status === 'failed') break;
    await delay(50);
  }
  assert.equal(taskStatus(project).status, 'failed');
  assert.equal(readTask(project).id, first.id, '继续同一个逻辑任务');
  assert.notEqual(readTask(project).attemptId, first.attemptId);
  assert.equal(readTask(project).message, idea);
  assert.ok(env.calls.length > callCount, JSON.stringify({ task: readTask(project), state: taskStatus(project) }));
  assert.ok(env.calls[callCount].messages.some(m => m.role === 'tool' && m.tool_call_id === 'dispatch-proof'));
  assert.equal(fs.statSync(path.join(project, '方案.md')).mtimeMs, firstMtime, '已完成的写入不重复');
  assert.equal(fs.readFileSync(path.join(project, '方案.md'), 'utf8'), plan, '恢复不得再次追加工具证据');
  await page.goto(env.url + '/?p=projects%2Ftopic-entry&tab=chat');
  await page.waitForFunction(() => document.querySelector('#chatState')?.textContent === '任务失败');
  assert.match(await page.textContent('#chatError'), /额度不足/);
  assert.equal(await page.isVisible('#chatRetry'), true);
  assert.deepEqual(errors, []);
});

test('选题入口：没有凭证不假报开工，保留输入和失败状态', { timeout: 15000 }, async t => {
  const env = await setup(t, { providerInfo: () => [] }); const { page, errors } = await pageFor(t, env.url);
  await page.locator('.choice:has(input[value="topic"])').click();
  await page.fill('#newInput', '一个选题'); await page.click('#newBtn');
  await page.waitForSelector('.task-status.error');
  assert.match(await page.textContent('.task-status.error'), /没有已配置/);
  assert.doesNotMatch(await page.textContent('#newMsg'), /开工了/);
  assert.equal(env.calls.length, 0); assert.deepEqual(errors, []);
});

test('选题入口：后台进程启动失败也必须留下可见结果', { timeout: 15000 }, async t => {
  const env = await setup(t, { agentExecutable: '/nonexistent/vh-node' });
  const result = await (await fetch(env.url + '/_api/new', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'startup-error', mode: 'topic', input: '选题仍须保留' }) })).json();
  assert.equal(result.ok, true);
  const { page } = await pageFor(t, env.url); await page.waitForSelector('.task-status.error');
  assert.match(await page.textContent('.task-status.error'), /未能正常启动/);
  assert.equal(readTask(path.join(env.root, 'projects/startup-error')).error.kind, 'startup');
  assert.equal(env.calls.length, 0);
});

test('项目内提交：ES module 不得因未声明变量报错；请求失败保留输入', { timeout: 15000 }, async t => {
  const env = await setup(t, { providerInfo: () => [] });
  const project = path.join(env.root, 'projects/chat'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  const { page, errors } = await pageFor(t, env.url + '/?p=projects%2Fchat&tab=chat');
  await page.fill('#chatInput', '保留这条输入'); await page.click('#chatSend');
  await page.waitForFunction(() => document.querySelector('#chatError')?.textContent.includes('提交失败'));
  assert.equal(await page.inputValue('#chatInput'), '保留这条输入');
  assert.deepEqual(errors, []); assert.equal(env.calls.length, 0);
});

test('任务状态：旧额度失败自动可见，项目隔离，旧回调不能覆盖新任务', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-task-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'), b = path.join(root, 'b'); fs.mkdirSync(path.join(a, 'out'), { recursive: true });
  fs.mkdirSync(path.join(a, 'materials')); fs.writeFileSync(path.join(a, 'materials/选题.md'), '旧选题');
  fs.writeFileSync(path.join(a, 'out/.vh-chat.log'), '模型调用失败：所有模型渠道均不可用：commandcode：额度不足（HTTP 400）\n══ 结束（退出 1） ══');
  assert.equal(taskStatus(a).error.kind, 'quota'); assert.equal(taskStatus(a).canRetry, true);
  assert.deepEqual(retryInput(a), { message: '旧选题', mode: 'topic' });
  const old = beginTask(a, '第一轮', 'topic'); const next = beginTask(a, '第二轮', 'topic');
  assert.equal(updateTask(a, old.id, { status: 'failed' }), null);
  assert.equal(readTask(a).id, next.id); assert.equal(taskStatus(a).running, true);
  assert.equal(taskStatus(b).running, false);
  updateTask(a, next.id, { status: 'cancelled', error: null });
  assert.equal(taskStatus(a).status, 'cancelled');
});

test('真实 HTTP：A 运行不影响 B，服务重启仍显示失败，无效项目不能重试默认项目', async t => {
  const env = await setup(t, { providerInfo: () => [] });
  const a = path.join(env.root, 'projects/a'), b = path.join(env.root, 'projects/b');
  for (const project of [a, b]) {
    fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  }
  const task = beginTask(a, 'A 正在工作', 'topic');
  updateTask(a, task.id, { status: 'running', pid: process.pid });
  t.after(() => updateTask(a, task.id, { status: 'cancelled' }));
  const get = rel => fetch(env.url + '/_api/chat/status?p=' + encodeURIComponent(rel)).then(r => r.json());
  assert.equal((await get('projects/a')).running, true);
  assert.equal((await get('projects/b')).running, false);
  const response = await fetch(env.url + '/_api/chat?p=projects%2Fb', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'B 的原始想法', mode: 'topic' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await get('projects/b')).error.kind, 'credentials');
  assert.equal((await get('projects/a')).running, true);
  const restarted = startServer(b, 0, { root: env.root, providerInfo: () => [] });
  await once(restarted, 'listening');
  t.after(async () => { restarted.closeAllConnections(); await new Promise(r => restarted.close(r)); });
  const url = 'http://127.0.0.1:' + restarted.address().port;
  const restored = await (await fetch(url + '/_api/chat/status?p=projects%2Fb')).json();
  assert.equal(restored.status, 'failed'); assert.equal(restored.error.kind, 'credentials'); assert.equal(restored.canRetry, true);
  const invalid = await fetch(url + '/_api/chat/retry?p=projects%2Fmissing', { method: 'POST' });
  assert.equal(invalid.status, 404); assert.equal(env.calls.length, 0);
});

test('工作台日志：尾部等长替换也更新，不以字符串长度判断变化', async t => {
  const env = await setup(t, { providerInfo: () => [] });
  const project = path.join(env.root, 'projects/log'); fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  const log = path.join(project, 'out/.vh-chat.log'); fs.writeFileSync(log, 'A'.repeat(6000));
  const { page } = await pageFor(t, env.url + '/?p=projects%2Flog&tab=chat');
  await page.waitForFunction(() => document.querySelector('#chatLog')?.textContent === 'A'.repeat(6000));
  fs.writeFileSync(log, 'B'.repeat(6000));
  await page.waitForFunction(() => document.querySelector('#chatLog')?.textContent === 'B'.repeat(6000));
});
