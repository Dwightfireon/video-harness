/* Real installed OpenCode + loopback-only fixture provider. No paid model/search.
 * This catches the shared-service / per-child environment boundary that fake
 * executables cannot exercise. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { discoverTopics } from '../lib/discovery.mjs';
import { readSchedule, writeSchedule } from '../lib/schedule.mjs';

test('本机真实OpenCode私有启动可读取临时agent并完成提问，模型请求只到本地模拟服务', { timeout: 45000 }, async t => {
  const binary = process.env.VH_TEST_NATIVE_OPENCODE || 'opencode';
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0 || !/v2\./.test(version.stdout || '')) return t.skip('本机未安装可运行的 OpenCode V2；其余模拟执行器测试仍需通过');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-native-question-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = { topic: '工具省下的时间去了哪里？', subject: '工作中的辅助工具', coreQuestion: '辅助工具节省的时间为什么未必变成更少的工作？',
    why: '帮助普通用户区分处理速度、任务数量与实际工作负担。', outline: '先检查具体任务的耗时，再比较任务数量和交付要求。', difference: '围绕工作负担而不是工具功能列表。',
    question: { version: 1, audience: '使用辅助工具的普通上班族', value: '帮助判断工具是否真的减轻了工作负担。', investigate: ['比较相同任务的处理时间', '调查任务数量和交付标准的变化'], premises: ['是否减轻负担需要结合具体场景确认。'] } };
  const content = JSON.stringify([candidate]), requests = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body; try { body = JSON.parse(raw); } catch { body = {}; }
    requests.push({ path: req.url, model: body.model });
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end('Unknown fixture endpoint'); return; }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of [
        { id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
        { id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
      ]) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture-response', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const values = { VH_OPENCODE_BIN: binary, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'vh-local-cli/fixture', snapshots: false, providers: { 'vh-local-cli': {
      package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'local-fixture-not-a-real-key' }, models: { fixture: {} },
    } } }) };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) fs.mkdirSync(values[key], { recursive: true });
  writeSchedule(root, { ...readSchedule(root), discoveryConfig: { model: 'vh-local-cli/fixture', query: '普通人的工作与辅助工具', timeoutMs: 30000 } });
  const result = await discoverTopics(root);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].coreQuestion, candidate.coreQuestion);
  assert.equal(result.results[0].researchAssessment.status, 'unresearched');
  assert.deepEqual(result.results[0].sources, []);
  assert.ok(requests.length > 0, '真实 CLI 必须运行到本地模型请求，不只是通过参数解析');
  assert.ok(requests.every(request => request.model === 'fixture'));
  assert.equal(readSchedule(root).items.length, 0);
});
