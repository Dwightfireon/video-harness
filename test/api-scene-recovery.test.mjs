import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { requestChat, createProviderPool } from '../lib/provider-pool.mjs';
import { apiErrorCode } from '../lib/api-error-diagnostics.mjs';
import { runAgent, agentWorkflowPrompt } from '../lib/agent.mjs';
import { writeCheckpoint, readCheckpoint } from '../lib/checkpoint.mjs';
import { pendingSceneWork } from '../lib/scene-work.mjs';
import { taskError } from '../lib/task-status.mjs';
import { writeSceneDraft } from '../lib/scene-drafts.mjs';

const provider = { name: 'opencode-go', model: 'minimax-m3.1-flash-free', key: 'PRIVATE_KEY', base: 'http://fixture.invalid' };
const tools = [{ type: 'function', function: { name: 'write_scene' } }];
const reply = { choices: [{ message: { role: 'assistant', content: '已经核对' } }] };
const call = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
async function apiFailure(code, message, status = 200) {
  return requestChat(provider, [], [], { fetchImpl: async () => new Response(status === 200
    ? event({ error: { code, message } }) : JSON.stringify({ error: { code, message } }),
  { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } }) });
}
function history() {
  const messages = [{ role: 'system', content: '旧系统提示：不要覆盖原稿' }, { role: 'user', content: '原始文章必须保留 PRIVATE_ARTICLE' }];
  for (let i = 0; i < 18; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.md' }) } }] });
    messages.push({ role: 'tool', tool_call_id: 'c' + i, content: '历史材料'.repeat(1500) });
    if (i === 6) messages.push({ role: 'user', content: '后续补充：保留我的署名' });
  }
  return messages;
}
function paired(messages) {
  let ids = new Set();
  for (const m of messages) {
    if (m.role === 'tool') assert.equal(ids.delete(m.tool_call_id), true);
    else { assert.equal(ids.size, 0); ids = new Set((m.tool_calls || []).map(c => c.id)); }
  }
  assert.equal(ids.size, 0);
}
function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-api-scenes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  for (const [name, text] of Object.entries({ 'PROJECT.json': '{}', '方案.md': '方案', 'claims.json': '[]',
    '脚本.md': '## S1 · 首场\n1. 第一个窗口出现问题。\n\n## S2 · 次场\n1. 第二个窗口给出对照。\n',
    'scenes.src.js': 'root => ({render(){}})', 'notes.md': '只读材料' })) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('HTTP 200/400 的接口错误保留固定子类，日志与任务状态无原文/密钥', async () => {
  for (const status of [200, 400]) {
    for (const [code, message, expected] of [
      ['context_length_exceeded', 'PRIVATE_KEY PRIVATE_ARTICLE', 'context_length_exceeded'],
      ['invalid_tool_call', 'PRIVATE_KEY PRIVATE_ARTICLE', 'invalid_tool_call'],
      ['content_filter', 'PRIVATE_KEY PRIVATE_ARTICLE', 'content_policy'],
      ['private-provider-code', 'PRIVATE_KEY PRIVATE_ARTICLE', 'unknown_api_error'],
    ]) {
      await assert.rejects(apiFailure(code, message, status), e => {
        assert.equal(e.diagnostics.apiCode, expected);
        const task = taskError({ failures: [{ provider: provider.name, kind: e.kind, reason: e.message, diagnostics: e.diagnostics }] });
        assert.doesNotMatch(JSON.stringify(task), /PRIVATE_KEY|PRIVATE_ARTICLE|private-provider-code/);
        assert.match(task.message, /接口|上下文|内容/); return true;
      });
    }
  }
  assert.equal(apiErrorCode({ message: 'Something went wrong' }), 'unknown_api_error');
});

test('确认上下文超限：同渠道缩历史一次，原文/补充/工具配对不丢，不修改检查点消息', async () => {
  const messages = history(), before = structuredClone(messages), views = [], logs = [];
  const pool = createProviderPool({ candidates: [provider], preferred: provider.name, log: l => logs.push(l),
    request: async (p, sent) => {
      assert.equal(p.name, provider.name); views.push(sent); paired(sent);
      if (views.length === 1) return apiFailure('context_length_exceeded', 'maximum context length');
      return reply;
    } });
  await pool.chat(messages, []);
  assert.equal(views.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(views[1])) < Buffer.byteLength(JSON.stringify(views[0])));
  const text = views[1].map(m => m.content || '').join('\n');
  assert.match(text, /原始文章必须保留 PRIVATE_ARTICLE/); assert.match(text, /后续补充：保留我的署名/);
  assert.deepEqual(messages, before); assert.match(logs.join('\n'), /同渠道纠偏 1\/1/);
  assert.doesNotMatch(logs.join('\n'), /PRIVATE_ARTICLE|PRIVATE_KEY/);
});

test('未知拒绝/内容策略/工具参数损坏不伪称上下文超限、不盲重试', async () => {
  for (const code of ['unexpected_error', 'content_filter', 'invalid_tool_call', 'invalid_messages']) {
    let count = 0;
    const pool = createProviderPool({ candidates: [provider], preferred: provider.name,
      request: async () => { count++; return apiFailure(code, 'PRIVATE_KEY'); } });
    await assert.rejects(pool.chat(history(), [])); assert.equal(count, 1);
  }
});

test('上下文无法再缩或缩后仍超限，均有界停止', async () => {
  for (const messages of [history(), [{ role: 'user', content: '原文很长'.repeat(40000) }]]) {
    let count = 0;
    const pool = createProviderPool({ candidates: [provider], preferred: provider.name,
      request: async () => { count++; return apiFailure('context_length_exceeded', 'limit'); } });
    await assert.rejects(pool.chat(messages, [])); assert.equal(count, messages.length > 1 ? 2 : 1);
  }
});

test('定向工具请求使用标准协议，明确不支持时仅回退一次到 auto', async () => {
  let body;
  await requestChat(provider, [], tools, { toolChoice: 'write_scene', fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body); return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'write_scene' } }); assert.equal(body.parallel_tool_calls, false);
  const choices = [];
  const pool = createProviderPool({ candidates: [provider], preferred: provider.name,
    request: async (_p, _m, _t, opts) => {
      choices.push(opts.toolChoice);
      if (choices.length === 1) return apiFailure('invalid_request', 'tool_choice is not supported');
      return reply;
    } });
  await pool.chat([], tools, undefined, '', { toolChoice: 'write_scene' });
  assert.deepEqual(choices, ['write_scene', undefined]);
});

test('旧检查点保留旧 system，请求投影追加当前政策，尾注带工具说明/下一场原文；四轮只读后定向写一场', async t => {
  const dir = project(t), originalSystem = '旧版本系统提示；只有 write_file，缺分场说明';
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'old-prompt', mode: 'article', status: 'failed',
    messages: [{ role: 'system', content: originalSystem }, { role: 'user', content: '做视频，原稿不改' }], pending: [] });
  const choices = [], logs = [];
  await runAgent(dir, '做视频，原稿不改', { taskId: 'old-prompt', resume: true, mode: 'article', providers: [{ ...provider, name: 'opendesign' }],
    stepBudget: 6, log: l => logs.push(l), request: async (_p, messages, _t, opts) => {
      choices.push(opts.toolChoice);
      assert.ok(messages[0].content.startsWith(originalSystem + '\n\n'), '请求保留历史系统原文');
      assert.ok(messages[0].content.endsWith(agentWorkflowPrompt(dir)), '请求投影追加当前政策，不执行历史强制工作流');
      assert.match(messages.at(-1).content, /当前分场工具说明/);
      if (choices.length <= 4) {
        assert.match(messages.at(-1).content, /下一场 S1 · 首场/); assert.match(messages.at(-1).content, /第一个窗口出现问题/);
        return call('read' + choices.length, 'read_file', { path: 'notes.md' });
      }
      if (choices.length === 5) return call('scene1', 'write_scene', { scene: 1, content: 'root => ({render(){}})' });
      assert.match(messages.at(-1).content, /下一场 S2 · 次场/);
      assert.match(messages.at(-1).content, /第二个窗口给出对照/);
      return call('read-next', 'read_file', { path: 'notes.md' });
    } });
  assert.deepEqual(choices, [undefined, undefined, undefined, undefined, 'write_scene', undefined]);
  assert.match(logs.join('\n'), /本轮定向调用 write_scene/);
  assert.equal(readCheckpoint(dir, 'old-prompt').messages[0].content, originalSystem);
  assert.ok(fs.existsSync(path.join(dir, 'out/.vh-scene-drafts/S1.js')));
});

test('范围保护：改文案/脚本未完成/草稿基线冲突不触发分场写入调度', t => {
  const dir = project(t);
  assert.equal(pendingSceneWork(dir, 'edit-copy'), null);
  assert.equal(pendingSceneWork(dir, 'edit-script'), null);
  writeSceneDraft(dir, 1, 'root => ({render(){}})');
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n用户改动');
  assert.equal(pendingSceneWork(dir, 'article'), null);
});

test('接口工具参数错误：不执行失败批次，定向缩成一场后继续保存', async t => {
  const dir = project(t), choices = [], seen = [];
  await runAgent(dir, '做视频', { taskId: 'api-tool-repair', mode: 'article', providers: [{ ...provider, name: 'opendesign' }],
    stepBudget: 2, request: async (_p, messages, _t, opts) => {
      choices.push(opts.toolChoice); seen.push(messages);
      if (choices.length === 1) return apiFailure('tool_use_failed', 'failed to generate tool call PRIVATE_KEY');
      assert.match(messages.map(m => m.content || '').join('\n'), /上一批工具参数无效，整批没有执行/);
      return call('repaired', 'write_scene', { scene: 1, content: 'root => ({render(){}})' });
    } });
  assert.deepEqual(choices, [undefined, 'write_scene']);
  const cp = readCheckpoint(dir, 'api-tool-repair');
  assert.equal(cp.messages.filter(m => m.role === 'tool').length, 1);
  assert.doesNotMatch(JSON.stringify(cp), /PRIVATE_KEY|failed to generate/);
  assert.equal(cp.toolRepairStreak, 0);
});

test('两次工具参数错误中间插只读，仍不能清零恢复预算；恢复继续有限制', async t => {
  const dir = project(t); let count = 0;
  const request = async () => {
    count++;
    if (count === 2) return call('read-only', 'read_file', { path: 'notes.md' });
    return apiFailure('invalid_tool_call', 'invalid arguments PRIVATE_KEY');
  };
  const opts = { taskId: 'bounded-tools', mode: 'article', providers: [{ ...provider, name: 'opendesign' }], request, stepBudget: 10 };
  const result = await runAgent(dir, '做视频', opts);
  assert.equal(result.status, 'paused'); assert.equal(count, 3);
  assert.equal(readCheckpoint(dir, 'bounded-tools').toolRepairStreak, 2);
  const resumed = await runAgent(dir, '做视频', { ...opts, resume: true });
  assert.equal(resumed.status, 'paused'); assert.equal(count, 4);
  assert.equal(readCheckpoint(dir, 'bounded-tools').toolRepairStreak, 3);
});

test('非流式非法工具参数同样进入有界纠偏，不把参数传给执行器', async t => {
  const dir = project(t); let count = 0;
  const result = await runAgent(dir, '做视频', { taskId: 'json-repair', mode: 'article', providers: [{ ...provider, name: 'opendesign' }],
    stepBudget: 5, request: async () => {
      count++;
      return requestChat(provider, [], [], { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null, tool_calls: [{ id: 'broken', function: { name: 'write_file', arguments: '{"path":"scenes.src.js","content":"PRIVATE' } }] } }] }),
      { headers: { 'content-type': 'application/json' } }) });
    } });
  assert.equal(result.status, 'paused'); assert.equal(count, 2);
  assert.equal(readCheckpoint(dir, 'json-repair').messages.filter(m => m.role === 'tool').length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), 'root => ({render(){}})');
});

test('用户补充先讨论、不要写入时，不定向调度 write_scene', async t => {
  const dir = project(t), choices = [];
  await runAgent(dir, '做视频', { taskId: 'user-first', mode: 'article', providers: [{ ...provider, name: 'opendesign' }],
    instruction: '先检查资料，不要写场景', stepBudget: 6, request: async (_p, messages, _t, opts) => {
      choices.push(opts.toolChoice);
      assert.match(messages.map(m => m.content || '').join('\n'), /先检查资料，不要写场景/);
      return call('read-' + choices.length, 'read_file', { path: 'notes.md' });
    } });
  assert.deepEqual(choices, Array(6).fill(undefined));
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-scene-drafts/S1.js')), false);
});
