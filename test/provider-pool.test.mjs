import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AGENT_MODEL, createProviderPool, ProviderRequestError, requestChat } from '../lib/provider-pool.mjs';
import { buildCandidates, pickProvider, runAgent, loadMemory } from '../lib/agent.mjs';
import { loadState, saveState } from '../lib/state.mjs';

const candidates = [
  { name: 'opendesign', model: 'wrong-old-model', key: 'test-only-od-key', base: 'http://unused.invalid/od' },
  { name: 'commandcode', model: 'wrong-old-model', key: 'test-only-cc-key', base: 'http://unused.invalid/cc' },
];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const tempProject = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  return 'http://127.0.0.1:' + server.address().port;
}

/* settings 显式注入：不能读本机真实配置，否则测试结果随使用者环境变化。 */
test('渠道构建：默认仅 OpenDesign，缺凭证不能回退，手动选择才使用 CommandCode', t => {
  // 本机 opencode 凭证库里可能有真实 key；来源链必须能注入隔离 home，
  // 否则这条断言会随使用者是否登录过 OpenDesign 而变化。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-provider-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const build = input => buildCandidates({ home, ...input });
  const routes = build({ providers: [{ name: 'commandcode', base: 'http://localhost/cc' }],
    config: { opendesignKey: 'test-only', commandcodeModel: 'some-other-model' },
    env: {}, auth: { commandcode: { key: 'test-only' } }, settings: {} });
  assert.equal(routes[0].model, 'deepseek-v4.1-flash');
  assert.equal(routes.length, 1);
  assert.equal(build({ providers: [{ name: 'commandcode', base: 'http://localhost/cc' }],
    config: {}, env: {}, auth: { commandcode: { key: 'test-only' } }, settings: {} }).length, 0);
  const manual = build({ providers: [{ name: 'commandcode', base: 'http://localhost/cc' }],
    config: { preferredProvider: 'commandcode' }, env: {}, auth: { commandcode: { key: 'test-only' } }, settings: {} });
  assert.deepEqual(manual.map(p => p.name), ['commandcode']); assert.equal(manual[0].model, AGENT_MODEL);
  assert.equal(build({ providers: [], config: {}, env: {}, auth: {}, settings: {} }).length, 0);
  assert.equal(build({ providers: [], config: {}, env: {}, auth: { opendesign: { key: 'test-only' } }, settings: {} })[0].name, 'opendesign');
});

test('旧项目缓存不更改默认渠道与模型，失败不自动切换', async t => {
  const project = tempProject(t);
  saveState(project, { agent: { provider: 'commandcode', model: 'old-model' } });
  const configured = buildCandidates({ providers: [], config: { opendesignKey: 'test-only' }, env: {}, auth: {}, settings: {} });
  assert.equal((await pickProvider(project, configured, {}, {})).model, 'deepseek-v4.1-flash');
  const calls = [];
  const pool = createProviderPool({ candidates, preferred: (await pickProvider(project, candidates, {}, {})).name,
    request: async p => { calls.push(p.name); if (p.name === 'opendesign') throw new ProviderRequestError('quota', { status: 402 }); return reply('成功'); } });
  await assert.rejects(pool.chat([], []), /未自动切换/);
  assert.deepEqual(calls, ['opendesign']);
});

for (const status of [401, 402, 403, 404, 408, 429, 500, 502, 503, 504]) {
  test('HTTP ' + status + '：仅可恢复故障重试一次，始终不触碰其他渠道', async () => {
    const messages = [{ role: 'user', content: '本地测试内容' }];
    const tools = [{ type: 'function', function: { name: 'write_file' } }];
    const bodies = [];
    const pool = createProviderPool({ candidates, retryDelayMs: 0,
      request: (p, m, s, options) => requestChat(p, m, s, { ...options, fetchImpl: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return url.includes('/od/') ? response({ error: { message: 'unavailable' } }, status) : response(reply('备用正常'));
      } }) });
    await assert.rejects(pool.chat(messages, tools), /未自动切换/);
    assert.equal(bodies.length, [408, 500, 502, 503, 504].includes(status) ? 2 : 1);
    for (const body of bodies) assert.equal(body.model, 'deepseek-v4.1-flash');
    assert.deepEqual(bodies[0].messages, messages);
    assert.deepEqual(bodies[0].tools, tools);
    assert.equal(bodies[0].model, 'deepseek-v4.1-flash');
    assert.equal(bodies[0].stream, true);
  });
}

test('200 error 额度错误与错误 JSON 都暂停，不切换渠道', async () => {
  for (const bad of [() => response({ error: { code: 'insufficient_quota' } }),
    () => response({ error: { code: 'quota_exhausted' } }, 400),
    () => response({ choices: [{ message: { content: ['bad content type'], tool_calls: {} } }] }),
    () => new Response('<html>gateway down</html>', { status: 200 })]) {
    let calls = 0;
    const pool = createProviderPool({ candidates, request: (p, m, s, options) => requestChat(p, m, s,
      { ...options, fetchImpl: async url => { calls++; return url.includes('/od/') ? bad() : response(reply('好')); } }) });
    await assert.rejects(pool.chat([], []), /未自动切换/); assert.equal(calls, 1);
  }
});

test('普通请求/上下文/内容限制不靠换渠道绕过', async () => {
  for (const [status, code] of [[400, 'context_length_exceeded'], [500, 'context_length_exceeded'], [413, 'payload_too_large'], [403, 'content_policy']]) {
    let calls = 0;
    const pool = createProviderPool({ candidates, request: (p, m, s, options) => requestChat(p, m, s,
      { ...options, fetchImpl: async () => { calls++; return response({ error: { code } }, status); } }) });
    await assert.rejects(pool.chat([], []), /未自动切换/);
    assert.equal(calls, 1);
  }
});

test('手动选择 CommandCode 才访问它；它失败也不自动切回 OpenDesign', async () => {
  const calls = []; let fails = false;
  const pool = createProviderPool({ candidates, preferred: 'commandcode', request: async p => {
    calls.push(p.name);
    if (fails) throw new ProviderRequestError('server');
    return reply('正常');
  } });
  await pool.chat([], []);
  await pool.chat([], []);
  fails = true;
  await assert.rejects(pool.chat([], []), /未自动切换/);
  assert.deepEqual(calls, ['commandcode', 'commandcode', 'commandcode']);
});

test('两个渠道都有凭证：出错即停止，不自动重试或尝试备用', async () => {
  let calls = 0;
  const pool = createProviderPool({ candidates, request: async () => { calls++; throw new ProviderRequestError('quota'); } });
  await assert.rejects(pool.chat([], []), /未自动切换/);
  assert.equal(calls, 1);
});

test('限流带 Retry-After：直接停止，不自动重敲或换渠道', async () => {
  let calls = 0;
  const pool = createProviderPool({ candidates, request: (p, m, s, options) => requestChat(p, m, s,
    { ...options, fetchImpl: async () => { calls++; return response({ error: {} }, 429, { 'retry-after': '120' }); } }) });
  await assert.rejects(pool.chat([], []));
  assert.equal(calls, 1);
});

test('超时覆盖响应体读取，真实本地 HTTP 证明不会请求其他渠道', async t => {
  const calls = [];
  const base = await listen(t, (req, res) => {
    calls.push(req.url);
    if (req.url.startsWith('/od/')) { res.writeHead(200); res.write('{"choices":'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply('HTTP 备用成功')));
  });
  const pool = createProviderPool({ candidates: candidates.map(p => ({ ...p, base: base + (p.name === 'opendesign' ? '/od' : '/cc') })), timeoutMs: 500, retryDelayMs: 0 });
  await assert.rejects(pool.chat([{ role: 'user', content: '本地测试' }], []), /请求超时/);
  assert.deepEqual(calls, ['/od/chat/completions', '/od/chat/completions']);
});

test('用户取消不是超时：不会借轮替重新发请求', async () => {
  const controller = new AbortController(); let calls = 0;
  const pool = createProviderPool({ candidates, request: async () => {
    calls++; controller.abort(); throw new Error('cancelled');
  } });
  await assert.rejects(pool.chat([], [], controller.signal), e => e.name === 'AbortError');
  assert.equal(calls, 1);
});

test('网络失败不换渠道，日志不回显异常正文/凭证/用户内容', async () => {
  const logs = [];
  const pool = createProviderPool({ candidates, log: s => logs.push(s), request: (p, m, s, options) => requestChat(p, m, s,
    { ...options, fetchImpl: async url => {
      if (url.includes('/od/')) throw new Error('Bearer test-only-od-key PRIVATE-ARTICLE');
      return response(reply('好'));
    } }) });
  await assert.rejects(pool.chat([], []), /未自动切换/);
  assert.doesNotMatch(logs.join('\n'), /渠道轮替/);
  assert.doesNotMatch(logs.join('\n'), /test-only|PRIVATE-ARTICLE|Bearer/);
});

test('没有候选渠道或只有一个渠道时明确停止，不构造虚假备用', async () => {
  assert.throws(() => createProviderPool({ candidates: [] }), /没有可用模型渠道/);
  let calls = 0;
  const pool = createProviderPool({ candidates: candidates.slice(0, 1), request: async () => { calls++; throw new ProviderRequestError('quota'); } });
  await assert.rejects(pool.chat([], []), /未自动切换/);
  assert.equal(calls, 1);
});

test('完整 agent：工具后出错即暂停；手动继续同渠道保留工具历史，不重复写入', async t => {
  const project = tempProject(t), calls = [], logs = [];
  saveState(project, { agent: { provider: 'opendesign', model: 'old-model' }, preserve: 'user-work' });
  const result = await runAgent(project, '仅测试暂停', { taskId: 'single-channel', mode: 'edit-visual', providers: candidates, log: m => logs.push(m),
    request: async (p, messages) => {
      calls.push({ name: p.name, messages: structuredClone(messages) });
      if (calls.length === 1) return { choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'test-call-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'scenes.src.js', content: 'root => ({render(){}})' }) } }] } }] };
      if (p.name === 'opendesign') throw new ProviderRequestError('quota', { status: 402 });
      return reply('已完成测试');
    } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls.map(c => c.name), ['opendesign', 'opendesign']);
  await runAgent(project, '仅测试暂停', { taskId: 'single-channel', resume: true, mode: 'edit-visual', providers: candidates,
    request: async (p, messages) => { assert.equal(p.name, 'opendesign');
      assert.ok(messages.some(m => m.role === 'tool' && m.tool_call_id === 'test-call-1')); return reply('继续'); } });
  assert.equal(logs.filter(l => /^· write_file /.test(l)).length, 1);
  assert.equal(fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'), 'root => ({render(){}})');
  const state = loadState(project);
  assert.equal(state.agent.provider, 'opendesign');
  // 记录实际发出的请求模型（OpenDesign 的别名），而不是写死的全局常量。
  assert.equal(state.agent.model, 'deepseek-v4.1-flash');
  assert.equal(state.agent.requestModel, 'deepseek-v4.1-flash');
  assert.equal(state.preserve, 'user-work');
  assert.doesNotMatch(JSON.stringify(state), /test-only-.*key/);
});

test('完整 agent：全部渠道失败返回 failed，记忆不伪装完成', async t => {
  const project = tempProject(t);
  const result = await runAgent(project, '失败测试', { mode: 'edit-visual', providers: candidates,
    request: async () => { throw new ProviderRequestError('quota', { status: 402 }); } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /未自动切换/);
  assert.match(loadMemory(project).at(-1).summary, /未完成/);
});

test('真实 CLI：两套凭证存在但只访问 OpenDesign，失败退出 1 不打印完成', async t => {
  const dir = tempProject(t), home = path.join(dir, 'home'), project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  const calls = [];
  const base = await listen(t, (req, res) => { calls.push(req.url); res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'never echo test-only-od-key' } })); });
  const config = path.join(home, '.config/opencode'), auth = path.join(home, '.local/share/opencode');
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(auth, { recursive: true });
  fs.writeFileSync(path.join(config, 'opencode.jsonc'), JSON.stringify({ provider: {
    opendesign: { options: { baseURL: base + '/od' } }, commandcode: { options: { baseURL: base + '/cc' } },
  } }));
  fs.writeFileSync(path.join(auth, 'auth.json'), JSON.stringify({ commandcode: { key: 'test-only-cc-key' } }));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('vh.mjs'), 'ask', '本地故障测试', '--mode', 'edit-visual', '--dir', project], {
      env: { ...process.env, HOME: home, OPEN_DESIGN_API_KEY: 'test-only-od-key' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, text }));
  });
  assert.equal(result.code, 1, result.text);
  assert.deepEqual(calls, ['/od/chat/completions']);
  assert.match(result.text, /任务未完成/);
  assert.doesNotMatch(result.text, /✓ 结束|test-only-.*key/);
  assert.equal(fs.existsSync(path.join(project, 'out/.vh-run.json')), false);
});
