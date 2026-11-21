import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestChat, createProviderPool } from '../lib/provider-pool.mjs';
import { parseChatSSE } from '../lib/provider-response.mjs';
import { beginTask, updateTask, taskStatus, taskError } from '../lib/task-status.mjs';

const prov = { name: 'opendesign', base: 'http://fixture.invalid', model: 'deepseek-v4.1-flash', key: 'fixture-private' };
const event = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  return { ...prov, base: 'http://127.0.0.1:' + server.address().port };
}

test('SSE：中文分片、推理字段、交错工具碎片组装成完整工具调用', () => {
  const sse = ': keepalive\n\n' + event({ reasoning_content: '先检查' }) + event({ content: '你好' }) +
    event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"path":' } },
      { index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":"脚本.md"}' } }] }) +
    event({ tool_calls: [{ index: 0, function: { arguments: '"out/证据.txt","content":"你好"}' } }] }) +
    event({}, 'tool_calls') + 'data: [DONE]\n\n';
  const msg = parseChatSSE(sse).choices[0].message;
  assert.equal(msg.content, '你好'); assert.equal(msg.reasoning_content, '先检查');
  assert.equal(msg.tool_calls.length, 2);
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { path: 'out/证据.txt', content: '你好' });
});

test('SSE：中途断流、截断工具参数和 length 结束均不能交付工具执行', () => {
  assert.throws(() => parseChatSSE(event({ content: '只收到一半' })), /完整/);
  const fragment = event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"path":' } }] });
  assert.throws(() => parseChatSSE(fragment + 'data: [DONE]\n\n'));
  const complete = event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{}' } }] });
  assert.throws(() => parseChatSSE(complete + event({}, 'length') + 'data: [DONE]\n\n'), /截断/);
});

test('SSE：较长生成持续有数据就继续，不受接收空闲时限误杀', async t => {
  const route = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ content: '开头' }));
    let n = 0;
    const timer = setInterval(() => {
      res.write(event({ reasoning_content: '推理' }));
      if (++n === 6) { clearInterval(timer); res.end(event({ content: '结尾' }, 'stop') + 'data: [DONE]\n\n'); }
    }, 35);
    res.on('close', () => clearInterval(timer));
  });
  const result = await requestChat(route, [], [], { timeoutMs: 2000, headerTimeoutMs: 800, idleTimeoutMs: 160 });
  assert.equal(result.choices[0].message.content, '开头结尾');
});

test('SSE：[DONE] 后服务器不主动断开也能及时完成', async t => {
  const route = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ content: '已完成' }, 'stop') + 'data: [DONE]\n\n');
  });
  const result = await requestChat(route, [], [], { timeoutMs: 1000, idleTimeoutMs: 150 });
  assert.equal(result.choices[0].message.content, '已完成');
});

for (const phase of ['headers', 'idle', 'total']) {
  test('真实 HTTP 超时分类：' + phase + '；不自动换渠道', async t => {
    let requests = 0;
    const route = await serve(t, (_req, res) => {
      requests++;
      if (phase === 'headers') return;
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n');
      if (phase === 'total') { const timer = setInterval(() => res.write(': keepalive\n\n'), 20); res.on('close', () => clearInterval(timer)); }
    });
    const budget = phase === 'total' ? { timeoutMs: 180 } : phase === 'headers' ? { headerTimeoutMs: 180 } : { idleTimeoutMs: 180 };
    const pool = createProviderPool({ candidates: [route, { ...route, name: 'commandcode' }],
      timeoutMs: 1500, headerTimeoutMs: 1000, idleTimeoutMs: 1000, retryDelayMs: 0, ...budget });
    await assert.rejects(pool.chat([], []), error => {
      assert.equal(error.failures.length, 1); assert.equal(error.failures[0].provider, 'opendesign');
      assert.equal(error.failures[0].timeoutPhase, phase); return true;
    });
    assert.equal(requests, 2);
  });
}

test('SSE 200 内含错误仍准确分类，且不泄漏响应正文', async () => {
  await assert.rejects(requestChat(prov, [], [], { fetchImpl: async () => new Response(
    'data: {"error":{"code":"quota_exhausted","message":"fixture-private"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) }),
  error => { assert.equal(error.kind, 'quota'); assert.doesNotMatch(error.message, /fixture-private/); return true; });
});

test('所选 OpenDesign 缺凭证时明确拒绝，不能偷偷用唯一的 CommandCode', () => {
  assert.throws(() => createProviderPool({ candidates: [{ ...prov, name: 'commandcode' }] }), /不会自动切换/);
});

test('旧任务报错按渠道展示，不再把 OpenDesign 超时误报成额度不足，且不改历史文件', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-channel-display-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const task = beginTask(dir, '原始要求', 'topic');
  updateTask(dir, task.id, { status: 'failed', error: { kind: 'quota', message: '额度不足' } });
  fs.writeFileSync(path.join(dir, 'out/.vh-chat.log'), '模型调用失败：所有模型渠道均不可用：opendesign：请求超时；commandcode：额度不足（HTTP 400）\n');
  const file = path.join(dir, 'out/.vh-task.json'), before = fs.readFileSync(file, 'utf8');
  const state = taskStatus(dir);
  assert.equal(state.error.kind, 'channels'); assert.match(state.error.message, /OpenDesign：请求超时/);
  assert.match(state.error.message, /CommandCode：额度不足/); assert.equal(fs.readFileSync(file, 'utf8'), before);
  const current = taskError({ failures: [{ provider: 'opendesign', kind: 'timeout', reason: '请求超时', timeoutPhase: 'idle', timeoutMs: 90000 }] });
  assert.match(current.message, /接收停滞，90秒/); assert.doesNotMatch(current.message, /CommandCode|额度不足/);
});
