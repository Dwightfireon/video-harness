import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { networkCodes, canRetryRequest } from '../lib/network-diagnostics.mjs';
import { requestChat, createProviderPool, ProviderRequestError } from '../lib/provider-pool.mjs';
import { runAgent } from '../lib/agent.mjs';
import { readCheckpoint } from '../lib/checkpoint.mjs';
import { beginTask, finishTask, readTask, taskError } from '../lib/task-status.mjs';

const candidates = ['opendesign', 'commandcode'].map(name => ({ name, key: 'fixture-secret', base: 'http://fixture.invalid' }));
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] });
async function serve(t, handler) {
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('诊断只提取白名单码，支持嵌套 AggregateError，异常正文和凭证不进入结果', async () => {
  const error = new Error('Bearer fixture-secret 私人原文 https://secret.invalid');
  error.cause = new AggregateError([Object.assign(new Error('secret'), { code: 'ECONNRESET' }),
    Object.assign(new Error(), { code: 'fixture-secret' })]); error.cause.cause = error;
  assert.deepEqual(networkCodes(error), ['ECONNRESET']);
  await assert.rejects(requestChat(candidates[0], [], [], { fetchImpl: async () => { throw error; } }), e => {
    assert.equal(e.kind, 'network'); assert.equal(e.diagnostics.phase, 'awaiting-headers');
    assert.deepEqual(e.diagnostics.networkCodes, ['ECONNRESET']); assert.equal(e.diagnostics.receivedBytes, 0);
    assert.doesNotMatch(JSON.stringify(e), /fixture-secret|私人原文|secret.invalid/); return true;
  });
});

test('网络错误按类型有限重试：临时断连会重试，域名/证书/不明错误不盲重试', async () => {
  for (const [code, attempts] of [['ECONNRESET', 2], ['EAI_AGAIN', 2], ['UND_ERR_SOCKET', 2],
    ['ENOTFOUND', 1], ['CERT_HAS_EXPIRED', 1], ['ECONNREFUSED', 1], [null, 1]]) {
    let count = 0;
    const pool = createProviderPool({ candidates, retryDelayMs: 0, request: (p, m, t, options) => requestChat(p, m, t,
      { ...options, fetchImpl: async () => { count++; throw Object.assign(new Error('never echo fixture-secret'), code ? { code } : {}); } }) });
    await assert.rejects(pool.chat([], [])); assert.equal(count, attempts, String(code));
  }
  assert.equal(canRetryRequest('opendesign', new ProviderRequestError('network', { diagnostics: { networkCodes: ['ECONNRESET', 'CERT_HAS_EXPIRED'] } })), false);
});

test('HTTP 503重试后仍失败：保留HTTP状态/阶段/耗时/响应字节，写入任务状态不含正文', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-network-status-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const task = beginTask(dir, '原目标', 'edit-visual'); let count = 0;
  const base = await serve(t, (_req, res) => {
    count++; res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture-secret 私人原文' } }));
  });
  const pool = createProviderPool({ candidates: candidates.map(p => ({ ...p, base })), retryDelayMs: 0 });
  await assert.rejects(pool.chat([], []), error => {
    const f = error.failures[0]; assert.equal(f.attempts, 2); assert.equal(f.status, 503);
    assert.equal(f.diagnostics.source, 'http'); assert.equal(f.diagnostics.phase, 'receiving-body');
    assert.ok(f.diagnostics.receivedBytes > 0); assert.ok(f.diagnostics.elapsedMs >= 0);
    finishTask(dir, task.id, { status: 'failed', error: error.message, providerFailures: error.failures }, task.attemptId);
    const saved = readTask(dir); assert.equal(saved.error.failures[0].diagnostics.status, 503);
    assert.match(saved.error.message, /HTTP 503/); assert.doesNotMatch(JSON.stringify(saved), /fixture-secret|私人原文/); return true;
  });
  assert.equal(count, 2);
});

test('网关要求过长 Retry-After 时暂停而非无界等待', async () => {
  let count = 0;
  const pool = createProviderPool({ candidates, retryDelayMs: 0, request: async () => {
    count++; throw new ProviderRequestError('server', { status: 503, retryAfterMs: 120000 });
  } });
  await assert.rejects(pool.chat([], [])); assert.equal(count, 1);
});

test('真实流传输被切断：记录接收阶段与字节；重试完整响应前不执行半截工具', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-stream-reset-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let count = 0; const logs = [];
  const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
  const call = { index: 0, id: 'write-once', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out/proof.txt', content: '只写一次' }) } };
  const base = await serve(t, (_req, res) => {
    count++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (count === 1) {
      res.write(event({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] }));
      const timer = setTimeout(() => res.destroy(), 40); res.on('close', () => clearTimeout(timer));
    } else if (count === 2) {
      assert.equal(fs.existsSync(path.join(dir, 'out/proof.txt')), false, '首次断流不能执行未结束的工具');
      res.end(event({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    } else res.end(event({ choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  const result = await runAgent(dir, '接着做', { taskId: 'stream-reset', mode: 'edit-visual', providers: candidates.map(p => ({ ...p, base })), log: line => logs.push(line) });
  assert.equal(result.status, 'completed'); assert.equal(count, 3);
  assert.equal(logs.filter(line => line.startsWith('· write_file')).length, 1);
  assert.match(logs.join('\n'), /transport \/ receiving-body \/ HTTP 200 \/ (?:UND_ERR_SOCKET|ECONNRESET)/);
  assert.equal(fs.readFileSync(path.join(dir, 'out/proof.txt'), 'utf8'), '只写一次');
  const cp = readCheckpoint(dir, 'stream-reset'); assert.equal(cp.messages.filter(m => m.tool_call_id === 'write-once').length, 1);
});

test('参数/协议错误不会包装成网络重试，诊断展示不把传输故障断言为上游故障', async () => {
  await assert.rejects(requestChat({ ...candidates[0], base: 'not-a-url' }, [], []), error => {
    assert.equal(error.kind, 'request'); assert.equal(error.diagnostics.source, 'local-config'); return true;
  });
  await assert.rejects(requestChat(candidates[0], [], [], { fetchImpl: async () => new Response('not-json') }), error => {
    assert.equal(error.kind, 'response'); assert.equal(error.diagnostics.source, 'protocol');
    assert.equal(error.diagnostics.phase, 'parsing-response'); return true;
  });
  const display = taskError({ failures: [{ provider: 'opendesign', kind: 'network', reason: '网络连接失败',
    diagnostics: { source: 'transport', phase: 'receiving-body', networkCodes: ['ECONNRESET'], receivedBytes: 120, elapsedMs: 800 } }] });
  assert.match(display.message, /ECONNRESET/); assert.doesNotMatch(display.message, /上游模型故障/);
});

test('HTTP 200 中的接口 error 保留真实 HTTP 状态，不伪造 HTTP 400/503', async () => {
  await assert.rejects(requestChat(candidates[0], [], [], { fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'quota_exhausted' } })) }), error => {
    assert.equal(error.kind, 'quota'); assert.equal(error.status, 200);
    assert.equal(error.diagnostics.source, 'api-error'); assert.doesNotMatch(error.message, /HTTP 400/); return true;
  });
  let requests = 0;
  const pool = createProviderPool({ candidates, retryDelayMs: 0, request: (p, m, t, options) => requestChat(p, m, t,
    { ...options, fetchImpl: async () => { requests++; return new Response(JSON.stringify({ error: { status: 503 } })); } }) });
  await assert.rejects(pool.chat([], []), error => {
    assert.equal(error.failures[0].status, 200); assert.equal(error.failures[0].diagnostics.apiStatus, 503); return true;
  });
  assert.equal(requests, 2);
});
