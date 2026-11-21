import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderPool, ProviderRequestError } from '../lib/provider-pool.mjs';
import { runAgent } from '../lib/agent.mjs';
import { taskError } from '../lib/task-status.mjs';

const candidates = ['opendesign', 'commandcode'].map(name => ({ name, key: 'fixture', base: 'http://fixture.invalid' }));
const reply = text => ({ choices: [{ message: { role: 'assistant', content: text } }] });

test('OpenDesign 首次超时：同上下文、同工具、同渠道重试一次后成功', async () => {
  const calls = [], logs = [], successes = [];
  const messages = [{ role: 'user', content: '原始要求' }], tools = [{ type: 'function', function: { name: 'write_file' } }];
  const pool = createProviderPool({ candidates, retryDelayMs: 0, log: line => logs.push(line), onSuccess: p => successes.push(p.name),
    request: async (p, m, t, options) => {
      calls.push(p.name); assert.strictEqual(m, messages); assert.strictEqual(t, tools);
      assert.equal(options.timeoutMs, 600000);
      if (calls.length === 1) throw new ProviderRequestError('timeout', { timeoutPhase: 'idle', timeoutMs: 90000 });
      return reply('恢复正常');
    } });
  assert.equal((await pool.chat(messages, tools)).choices[0].message.content, '恢复正常');
  assert.deepEqual(calls, ['opendesign', 'opendesign']); assert.deepEqual(successes, ['opendesign']);
  assert.match(logs.join('\n'), /同一渠道重试 1\/1/);
});

test('OpenDesign 连续超时：最多两次请求，保留原因与重试次数后暂停', async () => {
  let calls = 0;
  const pool = createProviderPool({ candidates, retryDelayMs: 0, request: async p => {
    assert.equal(p.name, 'opendesign'); calls++; throw new ProviderRequestError('timeout');
  } });
  await assert.rejects(pool.chat([], []), error => {
    assert.equal(error.failures[0].attempts, 2);
    assert.match(taskError({ failures: error.failures }).message, /同渠道重试一次后仍失败/); return true;
  });
  assert.equal(calls, 2);
});

test('超时后重试遇到额度不足：立即停止，不再重试也不切换', async () => {
  let calls = 0;
  const pool = createProviderPool({ candidates, retryDelayMs: 0, request: async () => {
    throw new ProviderRequestError(++calls === 1 ? 'timeout' : 'quota');
  } });
  await assert.rejects(pool.chat([], []), error => {
    assert.equal(error.failures[0].kind, 'quota'); assert.equal(error.failures[0].attempts, 2); return true;
  });
  assert.equal(calls, 2);
});

test('取消发生在超时后的等待中：立即取消，不发第二个请求', async () => {
  const controller = new AbortController(); let calls = 0;
  const pool = createProviderPool({ candidates, retryDelayMs: 5000,
    log: line => { if (line.includes('同一渠道重试')) queueMicrotask(() => controller.abort()); },
    request: async () => { calls++; throw new ProviderRequestError('timeout'); } });
  await assert.rejects(pool.chat([], [], controller.signal), error => error === controller.signal.reason);
  assert.equal(calls, 1);
});

test('未确认临时性的错误不自动重试；所选 CommandCode 超时同渠道至多重试一次', async () => {
  for (const kind of ['quota', 'auth', 'rate', 'network', 'server', 'response', 'request']) {
    let calls = 0;
    const pool = createProviderPool({ candidates, retryDelayMs: 0,
      request: async () => { calls++; throw new ProviderRequestError(kind); } });
    await assert.rejects(pool.chat([], [])); assert.equal(calls, 1, kind);
  }
  let calls = 0;
  const pool = createProviderPool({ candidates, preferred: 'commandcode', retryDelayMs: 0,
    request: async p => { assert.equal(p.name, 'commandcode'); calls++; throw new ProviderRequestError('timeout'); } });
  await assert.rejects(pool.chat([], [])); assert.equal(calls, 2);
});

test('完整 Agent：工具成功后下一请求超时重试，不重复执行已完成写入', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-timeout-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [], logs = []; let before;
  const result = await runAgent(dir, '只写一次再接着做', { taskId: 'timeout-retry', mode: 'edit-visual', providers: candidates,
    log: line => logs.push(line), request: async (p, messages) => {
      calls.push({ name: p.name, messages: structuredClone(messages) });
      if (calls.length === 1) return { choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'write-once', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out/proof.txt', content: '已完成的内容' }) } }] } }] };
      if (calls.length === 2) { before = fs.statSync(path.join(dir, 'out/proof.txt')).mtimeMs; throw new ProviderRequestError('timeout'); }
      assert.ok(messages.some(m => m.role === 'tool' && m.tool_call_id === 'write-once')); return reply('已继续');
    } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.map(c => c.name), ['opendesign', 'opendesign', 'opendesign']);
  assert.deepEqual(calls[1].messages, calls[2].messages);
  assert.equal(logs.filter(line => line.startsWith('· write_file')).length, 1);
  assert.equal(fs.statSync(path.join(dir, 'out/proof.txt')).mtimeMs, before);
});
