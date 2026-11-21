import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { runAgent } from '../lib/agent.mjs';
import { ProviderRequestError } from '../lib/provider-pool.mjs';
import { readCheckpoint, writeCheckpoint, checkpointPath, taskDir } from '../lib/checkpoint.mjs';
import { beginTask, resumeTask, readTask, updateTask, taskStatus } from '../lib/task-status.mjs';
import { startServer } from '../lib/server.mjs';
import { launchBrowser } from '../lib/browser.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-secret-never-persist', model: 'deepseek-v4.1-flash' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const tools = calls => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
function fixture(t, cleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-resume-'));
  fs.mkdirSync(path.join(root, 'out')); fs.writeFileSync(path.join(root, 'PROJECT.json'), '{}');
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function until(predicate, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
  throw new Error('等待测试状态超时');
}
function protocol(messages) {
  const awaiting = new Set();
  for (const m of messages) {
    if (m.role === 'tool') assert.ok(awaiting.delete(m.tool_call_id));
    else { assert.equal(awaiting.size, 0); for (const c of m.tool_calls || []) awaiting.add(c.id); }
  }
  assert.equal(awaiting.size, 0);
}
function seed(root, pending, messages) {
  writeCheckpoint(root, { schemaVersion: 1, taskId: 'fixture-task', mode: 'edit-visual', status: 'running',
    task: '原始制作要求', messages, pending, totalSteps: 1 });
}

test('检查点：模型失败后保留完整工具结果，恢复不重复写文件、不保存渠道密钥', async t => {
  const root = fixture(t); let requests = 0;
  const result = await runAgent(root, '原始目标', { mode: 'edit-visual', providers, taskId: 'same-task',
    request: async () => { if (++requests === 1) return tools([call('write-once', 'write_file', { path: 'out/proof.txt', content: '一次写入' })]); throw new ProviderRequestError('quota'); } });
  assert.equal(result.status, 'failed');
  const before = fs.statSync(path.join(root, 'out/proof.txt')).mtimeMs;
  const cp = readCheckpoint(root, 'same-task');
  assert.equal(cp.messages.filter(m => m.tool_call_id === 'write-once').length, 1);
  assert.equal(fs.statSync(checkpointPath(root, 'same-task')).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(checkpointPath(root, 'same-task'), 'utf8'), /fixture-secret-never-persist/);
  const next = await runAgent(root, '原始目标', { mode: 'edit-visual', providers, taskId: 'same-task', resume: true,
    instruction: '保留原稿，继续出片', request: async (_p, messages) => {
      protocol(messages); assert.deepEqual(messages.slice(0, cp.messages.length), cp.messages);
      // 末尾会追加当前台账（保住前缀缓存），所以"继续指令"在末尾若干条里。
      const tail = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
      assert.match(tail, /继续原任务|保留原稿/); return reply('已接续');
    } });
  assert.equal(next.status, 'completed');
  assert.equal(fs.statSync(path.join(root, 'out/proof.txt')).mtimeMs, before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'out/.vh-chat-memory.json'))).length, 1, '同一任务只维护一条摘要');
});

test('同一批工具中断：跳过已完成项，执行尚未开始项，保持工具消息配对', async t => {
  const root = fixture(t); const first = call('first', 'write_file', { path: 'out/first.txt', content: '先前已写' });
  const second = call('second', 'write_file', { path: 'out/second.txt', content: '这次接着写' });
  fs.writeFileSync(path.join(root, 'out/first.txt'), '先前已写'); const before = fs.statSync(path.join(root, 'out/first.txt')).mtimeMs;
  seed(root, [{ call: first, status: 'done' }, { call: second, status: 'planned' }], [
    { role: 'user', content: '原目标' }, { role: 'assistant', content: null, tool_calls: [first, second] },
    { role: 'tool', tool_call_id: 'first', content: '已经完成' },
  ]);
  await runAgent(root, '原目标', { mode: 'edit-visual', providers, taskId: 'fixture-task', resume: true,
    request: async (_p, messages) => { protocol(messages); assert.equal(messages.filter(m => m.role === 'tool').length, 2); return reply('接续完成'); } });
  assert.equal(fs.readFileSync(path.join(root, 'out/second.txt'), 'utf8'), '这次接着写');
  assert.equal(fs.statSync(path.join(root, 'out/first.txt')).mtimeMs, before);
});

test('副作用未知：不自动重放命令，模型再次要求相同命令也被拦住', async t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'out/counter.txt'), 'x');
  const command = 'node -e \'require("fs").appendFileSync("out/counter.txt","x")\'';
  const c = call('unknown-effect', 'run', { command });
  seed(root, [{ call: c, status: 'executing' }], [{ role: 'user', content: '原目标' }, { role: 'assistant', content: null, tool_calls: [c] }]);
  let count = 0;
  await runAgent(root, '原目标', { mode: 'edit-visual', providers, taskId: 'fixture-task', resume: true,
    request: async (_p, messages) => {
      protocol(messages);
      if (++count === 1) { assert.match(messages.find(m => m.tool_call_id === 'unknown-effect').content, /结果未知/); return tools([call('repeat', 'run', { command })]); }
      assert.match(messages.find(m => m.tool_call_id === 'repeat').content, /拒绝自动重放/); return reply('先核对');
    } });
  assert.equal(fs.readFileSync(path.join(root, 'out/counter.txt'), 'utf8'), 'x');
});

test('写入后未存结果：只读确认相同内容，已有用户改动则不覆盖', async t => {
  for (const matches of [true, false]) {
    const root = fixture(t); const c = call('unfinished-write', 'write_file', { path: 'out/proof.txt', content: '原请求' });
    fs.writeFileSync(path.join(root, 'out/proof.txt'), matches ? '原请求' : '用户后来改过');
    const before = fs.statSync(path.join(root, 'out/proof.txt')).mtimeMs;
    seed(root, [{ call: c, status: 'executing' }], [{ role: 'user', content: '原目标' }, { role: 'assistant', content: null, tool_calls: [c] }]);
    await runAgent(root, '原目标', { mode: 'edit-visual', providers, taskId: 'fixture-task', resume: true,
      request: async (_p, messages) => { protocol(messages); assert.match(messages.find(m => m.role === 'tool').content, matches ? /逐字一致/ : /结果未知/); return reply('继续核对'); } });
    assert.equal(fs.statSync(path.join(root, 'out/proof.txt')).mtimeMs, before);
    assert.equal(fs.readFileSync(path.join(root, 'out/proof.txt'), 'utf8'), matches ? '原请求' : '用户后来改过');
  }
});

test('损坏检查点拒绝恢复；不能改模式，不能静默降级重做', async t => {
  const root = fixture(t); seed(root, [], [{ role: 'user', content: '原目标' }]);
  let called = false;
  await assert.rejects(runAgent(root, '新目标', { mode: 'article', providers, taskId: 'fixture-task', resume: true, request: async () => { called = true; } }), /模式/);
  fs.writeFileSync(checkpointPath(root, 'fixture-task'), '{broken');
  await assert.rejects(runAgent(root, '新目标', { mode: 'edit-visual', providers, taskId: 'fixture-task', resume: true, request: async () => { called = true; } }), /检查点无法读取/);
  assert.equal(called, false);
});

test('任务身份：继续保留 ID 与 topic 模式，旧 attempt 的回调不能覆盖新执行', t => {
  const root = fixture(t); const first = beginTask(root, '原始目标', 'topic');
  updateTask(root, first.id, { status: 'failed' }, first.attemptId);
  const next = resumeTask(root, '接着出片');
  assert.equal(next.id, first.id); assert.equal(next.mode, 'topic'); assert.equal(next.message, '原始目标');
  assert.notEqual(next.attemptId, first.attemptId);
  assert.equal(updateTask(root, first.id, { status: 'failed' }, first.attemptId), null);
  assert.equal(readTask(root).attemptId, next.attemptId);
});

test('旧任务无检查点：带现有文件接续说明，不伪称精确恢复', async t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, '脚本.md'), '原稿不能覆盖');
  await runAgent(root, '原始目标', { mode: 'edit-visual', providers, taskId: 'legacy-task', resume: true,
    request: async (_p, messages) => {
      const recovery = messages.find(m => m.content?.includes('没有可用的历史执行检查点'));
      assert.ok(recovery); assert.match(recovery.content, /脚本.md：存在/); assert.match(recovery.content, /不要创建新项目/); return reply('先核对已有文件');
    } });
  assert.equal(fs.readFileSync(path.join(root, '脚本.md'), 'utf8'), '原稿不能覆盖');
});

test('恢复时有新要求：不执行旧计划中尚未开始的写入，接收新要求后可执行新工具', async t => {
  const root = fixture(t); const c = call('old-plan', 'write_file', { path: 'out/old.txt', content: '不该再写' });
  seed(root, [{ call: c, status: 'planned' }], [{ role: 'user', content: '原目标' }, { role: 'assistant', content: null, tool_calls: [c] }]);
  let count = 0;
  await runAgent(root, '原目标', { mode: 'edit-visual', providers, taskId: 'fixture-task', resume: true, instruction: '不要执行先前计划的写入，改写另一个文件',
    request: async (_p, messages) => {
      protocol(messages);
      if (++count === 1) { assert.match(messages.find(m => m.tool_call_id === 'old-plan').content, /未执行/); return tools([call('new-plan', 'write_file', { path: 'out/new.txt', content: '新要求' })]); }
      return reply('已按补充要求继续');
    } });
  assert.equal(fs.existsSync(path.join(root, 'out/old.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'out/new.txt'), 'utf8'), '新要求');
});

test('继续指令持久化：启动失败后仍保留，模型请求失败后再次继续也不重复注入', async t => {
  const root = fixture(t), task = beginTask(root, '原目标', 'edit-visual');
  updateTask(root, task.id, { status: 'failed' });
  const attempt = resumeTask(root, '保留已经写好的片尾');
  updateTask(root, attempt.id, { status: 'failed' }, attempt.attemptId); // 模拟进程尚未进入 agent 就启动失败
  const retry = resumeTask(root);
  assert.equal(retry.resumeInstructions.length, 1);
  await runAgent(root, '原目标', { mode: 'edit-visual', providers, taskId: retry.id, attemptId: retry.attemptId, resume: true,
    instructions: retry.resumeInstructions, request: async () => { throw new ProviderRequestError('quota'); } });
  updateTask(root, retry.id, { status: 'failed' }, retry.attemptId);
  const next = resumeTask(root);
  await runAgent(root, '原目标', { mode: 'edit-visual', providers, taskId: next.id, attemptId: next.attemptId, resume: true,
    instructions: next.resumeInstructions, request: async (_p, messages) => {
      assert.equal(messages.filter(m => m.role === 'user' && m.content === '保留已经写好的片尾').length, 1); return reply('继续完成');
    } });
});

async function serverFixture(t, handler) {
  const root = fixture(t, false), project = path.join(root, 'projects/work'), home = path.join(root, 'home');
  // Topic recovery still uses its author-stage contract. Only the explicit edit
  // command-lifecycle fixture below uses the project's automation opt-out.
  fs.mkdirSync(path.join(project, 'out'), { recursive: true }); fs.writeFileSync(path.join(project, 'PROJECT.json'), '{"automation":{"enabled":false,"maxRepairs":2}}');
  for (const f of ['脚本.md', 'claims.json', 'scenes.src.js']) fs.writeFileSync(path.join(project, f), f === '脚本.md' ? '## S1 · 原稿\n1. 已有内容。\n' : '{}');
  const calls = []; const model = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
      const input = JSON.parse(raw); calls.push(input); protocol(input.messages); handler(input, res, calls.length);
    });
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/opencode/opencode.jsonc'), JSON.stringify({ provider: { opendesign: { options: { baseURL: 'http://127.0.0.1:' + model.address().port } } } }));
  const options = { root, providerInfo: () => [{ provider: 'opendesign' }], agentEnv: { ...process.env, HOME: home, OPEN_DESIGN_API_KEY: 'fixture-only' } };
  const servers = [];
  async function start() { const server = startServer(project, 0, options); servers.push(server); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; }
  const url = await start();
  t.after(async () => {
    const task = readTask(project); if (task?.pid && ['starting', 'running'].includes(task.status)) { try { process.kill(-task.pid, 'SIGKILL'); } catch {} }
    for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    model.closeAllConnections(); await new Promise(r => model.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const post = (url, route, value) => fetch(url + route + '?p=projects%2Fwork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { root, project, url, calls, post, start, servers };
}

test('真实 CLI 硬中断 + 工作台重启：继续同一任务，工具已成功的文件不再写', { timeout: 25000 }, async t => {
  const env = await serverFixture(t, (_input, res, count) => {
    res.setHeader('content-type', 'application/json');
    if (count === 1) {
      assert.ok(_input.tools.some(tool => tool.function.name === 'append_file'));
      res.end(JSON.stringify(tools([call('once', 'append_file', { path: '方案.md', content: '# 原任务方案\n只写一次\n' })])));
    }
    else if (count >= 3) res.end(JSON.stringify(reply('接着完成')));
    // 第二次模型请求保持等待，模拟请求中进程被强制杀死。
  });
  assert.equal((await env.post(env.url, '/_api/chat', { message: '原始调研要求', mode: 'topic' })).status, 200);
  await until(() => env.calls.length >= 2);
  const first = readTask(env.project), before = fs.statSync(path.join(env.project, '方案.md')).mtimeMs;
  assert.equal(fs.readFileSync(path.join(env.project, '方案.md'), 'utf8'), '# 原任务方案\n只写一次\n');
  const savedLog = fs.readFileSync(path.join(env.project, 'out/.vh-chat.log'), 'utf8');
  process.kill(-first.pid, 'SIGKILL');
  await until(() => taskStatus(env.project).canResume);
  env.servers[0].closeAllConnections(); await new Promise(r => env.servers[0].close(r)); env.servers.shift();
  const restarted = await env.start();
  assert.equal((await env.post(restarted, '/_api/chat/resume')).status, 200);
  // paused 记录可先于 CLI 完全退出；共享制作锁释放后才允许继续。
  await until(() => readTask(env.project)?.status === 'paused' && taskStatus(env.project).canResume);
  assert.equal(taskStatus(env.project).canResume, true, '没有成片的 topic 任务只能暂停，不能误完成');
  const next = readTask(env.project);
  assert.equal(next.id, first.id); assert.notEqual(next.attemptId, first.attemptId); assert.equal(next.mode, 'topic');
  assert.equal(next.message, '原始调研要求');
  assert.ok(env.calls[2].messages.some(m => m.tool_call_id === 'once'));
  assert.equal(fs.statSync(path.join(env.project, '方案.md')).mtimeMs, before);
  assert.equal(fs.readFileSync(path.join(env.project, '方案.md'), 'utf8'), '# 原任务方案\n只写一次\n');
  assert.ok(fs.readFileSync(path.join(env.project, 'out/.vh-chat.log'), 'utf8').startsWith(savedLog));
});

test('通用 edit 命令运行中父进程被杀：子进程未结束时禁止继续，结束后不自动重放未知命令', { timeout: 20000 }, async t => {
  const env = await serverFixture(t, (_input, res, count) => {
    res.setHeader('content-type', 'application/json');
    if (count === 1) res.end(JSON.stringify(tools([call('slow-tool', 'run', {
      command: 'node -e \'setTimeout(()=>require("fs").writeFileSync("out/late.txt","once"),650)\'',
    })])));
    else { assert.match(_input.messages.find(m => m.tool_call_id === 'slow-tool').content, /结果未知/); res.end(JSON.stringify(reply('先检查产物再继续'))); }
  });
  await env.post(env.url, '/_api/chat', { message: '测试中断工具', mode: 'edit' });
  const runPath = path.join(env.project, 'out/.vh-run.json');
  await until(() => { try { return JSON.parse(fs.readFileSync(runPath)).childPid > 0; } catch { return false; } });
  const first = readTask(env.project);
  t.after(() => { try { process.kill(-first.pid, 'SIGKILL'); } catch {} });
  process.kill(first.pid, 'SIGKILL');
  await until(() => taskStatus(env.project).orphanRunning);
  assert.equal((await env.post(env.url, '/_api/chat/resume')).status, 409);
  await until(() => fs.existsSync(path.join(env.project, 'out/late.txt')) && !taskStatus(env.project).orphanRunning);
  const before = fs.statSync(path.join(env.project, 'out/late.txt')).mtimeMs;
  assert.equal((await env.post(env.url, '/_api/chat/resume')).status, 200);
  await until(() => readTask(env.project)?.status === 'completed' && !taskStatus(env.project).running);
  assert.equal(readTask(env.project).id, first.id);
  assert.equal(readTask(env.project).mode, 'edit');
  assert.equal(fs.statSync(path.join(env.project, 'out/late.txt')).mtimeMs, before);
  // 通用编辑任务无需成片；这里仅验证未知命令没有自动重放。
  assert.ok(env.calls.length >= 2);
  assert.equal(fs.readFileSync(path.join(env.project, 'out/late.txt'), 'utf8'), 'once');
});

test('真实页面：默认继续、保留选题模式；明确新任务才换 ID 并归档原记录', { timeout: 25000 }, async t => {
  const env = await serverFixture(t, (_input, res, count) => {
    res.setHeader('content-type', 'application/json');
    if (count === 1) res.end(JSON.stringify(tools([call('proof', 'append_file', { path: '方案.md', content: '# 原任务产物\n' })])));
    else { res.writeHead(400); res.end(JSON.stringify({ error: { code: 'quota_exhausted' } })); }
  });
  await env.post(env.url, '/_api/chat', { message: '不要重做已有内容', mode: 'topic' });
  await until(() => readTask(env.project)?.status === 'failed');
  const first = readTask(env.project);
  const before = fs.statSync(path.join(env.project, '方案.md')).mtimeMs;
  assert.equal(fs.readFileSync(path.join(env.project, '方案.md'), 'utf8'), '# 原任务产物\n');
  const browser = await launchBrowser(chromium, { headless: true, args: ['--mute-audio'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(env.url + '/?p=projects%2Fwork&tab=chat');
  await page.waitForFunction(() => document.querySelector('#chatSend')?.textContent === '继续原任务 →');
  assert.equal(await page.locator('#modes button.on').getAttribute('data-mode'), 'topic');
  assert.match(await page.textContent('#chatResumeHint'), /检查点/);
  await page.click('#chatSend'); // 留空继续，不能新建任务，也不能切成 article。
  await until(() => readTask(env.project)?.attemptId !== first.attemptId && readTask(env.project)?.status === 'failed');
  assert.equal(readTask(env.project).id, first.id); assert.equal(readTask(env.project).mode, 'topic');
  assert.equal(fs.statSync(path.join(env.project, '方案.md')).mtimeMs, before);
  assert.equal(fs.readFileSync(path.join(env.project, '方案.md'), 'utf8'), '# 原任务产物\n');
  page.once('dialog', dialog => dialog.accept()); await page.click('#chatNew');
  await page.click('#modes button[data-mode="article"]'); await page.fill('#chatInput', '这是用户明确的新要求'); await page.click('#chatSend');
  await until(() => readTask(env.project)?.id !== first.id && readTask(env.project)?.status === 'failed');
  assert.equal(readTask(env.project).mode, 'article');
  assert.ok(fs.existsSync(path.join(taskDir(env.project, first.id), 'task.json')));
  assert.ok(fs.existsSync(path.join(taskDir(env.project, first.id), '.vh-chat.log')));
  assert.ok(readCheckpoint(env.project, first.id));
  assert.equal(fs.readFileSync(path.join(env.project, '方案.md'), 'utf8'), '# 原任务产物\n');
  assert.deepEqual(errors, []);
});

test('HTTP 安全：检查点不可下载，错误项目的生成/继续/取消不回退默认项目', async t => {
  const env = await serverFixture(t, (_input, res) => res.end(JSON.stringify(reply('不应调用'))));
  const task = beginTask(env.project, '原目标', 'topic'); updateTask(env.project, task.id, { status: 'failed' });
  const baseline = fs.readFileSync(path.join(env.project, 'out/.vh-task.json'), 'utf8');
  const cpURL = '/projects/work/out/.vh-tasks/' + task.id + '/checkpoint.json';
  assert.equal((await fetch(env.url + cpURL)).status, 403);
  for (const route of ['/_api/chat', '/_api/chat/resume', '/_api/chat/cancel']) {
    assert.equal((await fetch(env.url + route + '?p=projects%2Fmissing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"继续"}' })).status, 404);
  }
  assert.equal(fs.readFileSync(path.join(env.project, 'out/.vh-task.json'), 'utf8'), baseline);
  assert.equal(env.calls.length, 0);
});
