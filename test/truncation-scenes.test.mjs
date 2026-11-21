import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChatSSE } from '../lib/provider-response.mjs';
import { requestChat, createProviderPool } from '../lib/provider-pool.mjs';
import { runAgent, makeTools } from '../lib/agent.mjs';
import { readCheckpoint, writeCheckpoint } from '../lib/checkpoint.mjs';
import { nextAgentStep } from '../lib/agent.mjs';
import { writeSceneDraft, assembleSceneDrafts, sceneDraftStatus, sceneAssemblyMatches } from '../lib/scene-drafts.mjs';

const providers = [{ name: 'opendesign', key: 'fixture-secret-do-not-log', base: 'http://fixture.invalid' }];
const event = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const calls = (...tool_calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls }, finish_reason: 'tool_calls' }] });
const draft = n => `// @layout 场${n}\nroot => { const n = ${n}; return { render(t) { void n; } }; }`;
function fixture(t, count = 3) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trunc-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, 'out'));
  fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(project, '脚本.md'), Array.from({ length: count }, (_, i) => `## S${i + 1} · 场${i + 1}\n1. 旁白${i + 1}。\n`).join('\n'));
  fs.writeFileSync(path.join(project, 'scenes.src.js'), 'root => ({render(){}})\n');
  for (const name of ['方案.md', 'claims.json']) fs.writeFileSync(path.join(project, name), 'fixture');
  return project;
}

test('工具 length：响应按截断分类，丢弃整批工具，不泄漏半截参数', async () => {
  const partial = event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"path":"scenes.src.js","content":"PRIVATE' } }] }) +
    event({}, 'length') + 'data: [DONE]\n\n';
  assert.throws(() => parseChatSSE(partial), e => e.code === 'output_truncated' && e.finishReason === 'length' && e.toolCount === 1);
  const request = await assert.rejects(requestChat(providers[0], [], [], { fetchImpl: async () =>
    new Response(partial, { headers: { 'content-type': 'text/event-stream' } }) }), e => {
    assert.equal(e.kind, 'truncated'); assert.equal(e.diagnostics.parseCode, 'output_truncated');
    assert.equal(e.diagnostics.finishReason, 'length'); assert.equal(e.diagnostics.toolCount, 1);
    assert.equal(e.diagnostics.streamComplete, true);
    assert.doesNotMatch(JSON.stringify(e), /PRIVATE|fixture-secret/);
    return true;
  });
  void request;
});

test('流式解析失败细分：参数错误、流不完整、事件损坏；均无原始内容', async () => {
  const cases = [
    [event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"content":"PRIVATE' } }] }) + event({}, 'tool_calls') + 'data: [DONE]\n\n', 'invalid_tool_arguments'],
    [event({ content: 'PRIVATE' }), 'incomplete_stream'],
    ['data: {"PRIVATE":\n\n', 'malformed_sse'],
  ];
  for (const [raw, code] of cases) {
    await assert.rejects(requestChat(providers[0], [], [], { fetchImpl: async () =>
      new Response(raw, { headers: { 'content-type': 'text/event-stream' } }) }), e => {
      assert.equal(e.kind, 'response'); assert.equal(e.diagnostics.parseCode, code);
      assert.doesNotMatch(JSON.stringify(e), /PRIVATE|fixture-secret/); return true;
    });
  }
});

test('非流式 JSON 的半截工具也不可执行，协议错误与截断区分', async () => {
  for (const [finish_reason, argumentsText, kind, code] of [
    ['length', '{"content":"PRIVATE', 'truncated', 'output_truncated'],
    ['tool_calls', '{"content":"PRIVATE', 'response', 'invalid_tool_arguments'],
  ]) {
    const payload = { choices: [{ finish_reason, message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'partial', function: { name: 'write_scene', arguments: argumentsText } }] } }] };
    await assert.rejects(requestChat(providers[0], [], [], { fetchImpl: async () => new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' } }) }), e => {
      assert.equal(e.kind, kind); assert.equal(e.diagnostics.parseCode, code);
      assert.doesNotMatch(JSON.stringify(e), /PRIVATE/); return true;
    });
  }
});

test('协议损坏不自动重试或切换渠道，安全子类出现在持久化失败信息', async () => {
  let n = 0;
  const pool = createProviderPool({ candidates: [providers[0], { ...providers[0], name: 'commandcode' }],
    request: async () => { n++; return requestChat(providers[0], [], [], { fetchImpl: async () =>
      new Response(event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{' } }] }) + event({}, 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }) }); } });
  await assert.rejects(pool.chat([], []), e => {
    assert.equal(e.failures[0].diagnostics.parseCode, 'invalid_tool_arguments'); return true;
  });
  assert.equal(n, 1);
});

test('分场草稿独立落盘：保存后不碰原场景，齐了才组装', t => {
  const project = fixture(t); const source = path.join(project, 'scenes.src.js');
  const original = fs.readFileSync(source, 'utf8');
  assert.match(writeSceneDraft(project, 1, draft(1)), /1\/3/);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  assert.match(nextAgentStep(project, 'article'), /下一场先写 S2/);
  assert.throws(() => assembleSceneDrafts(project), /S2、S3/);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  writeSceneDraft(project, 2, draft(2)); writeSceneDraft(project, 3, draft(3));
  assert.match(assembleSceneDrafts(project), /已组装 3 场/);
  const contents = fs.readFileSync(source, 'utf8');
  assert.equal(contents.split(/^\/\/---$/m).length, 3);
  assert.ok(contents.indexOf('场1') < contents.indexOf('场2') && contents.indexOf('场2') < contents.indexOf('场3'));
  assert.deepEqual(sceneDraftStatus(project).missing, []);
});

test('场景非法/缺场/脚本或源文件被外部修改，不能覆盖作者文件', t => {
  const project = fixture(t); const source = path.join(project, 'scenes.src.js');
  for (const body of ['root => {', 'root => {}\n//---\nroot => {}', 'something else', 'root => ()']) {
    assert.throws(() => writeSceneDraft(project, 1, body));
  }
  assert.equal(sceneDraftStatus(project), null);
  writeSceneDraft(project, 1, draft(1));
  fs.writeFileSync(source, '用户后续修改');
  assert.throws(() => writeSceneDraft(project, 2, draft(2)), /已在分场草稿期间改变/);
  assert.throws(() => assembleSceneDrafts(project), /已在分场草稿期间改变/);
  assert.equal(fs.readFileSync(source, 'utf8'), '用户后续修改');
  assert.equal(sceneDraftStatus(project).stale, true);
});

test('组装成功与写清单之间的崩溃窗口：不重写相同源文件，仅补齐清单', t => {
  const project = fixture(t, 2), source = path.join(project, 'scenes.src.js');
  const original = fs.readFileSync(source, 'utf8');
  writeSceneDraft(project, 1, draft(1)); writeSceneDraft(project, 2, draft(2));
  fs.writeFileSync(source, [draft(1), draft(2)].join('\n\n//---\n\n') + '\n');
  assert.equal(sceneDraftStatus(project).stale, true);
  assert.equal(sceneAssemblyMatches(project), true);
  const before = fs.statSync(source).mtimeMs;
  assert.match(assembleSceneDrafts(project), /已组装 2 场/);
  assert.equal(fs.statSync(source).mtimeMs, before);
  assert.equal(sceneDraftStatus(project).stale, false);
  assert.notEqual(original, fs.readFileSync(source, 'utf8'));
});

test('edit-copy 无法使用场景工具；同一场草稿重复写入不改时间', async t => {
  const project = fixture(t), content = draft(1);
  const denied = makeTools(project, () => {}, { mode: 'edit-copy' });
  assert.match(await denied.write_scene.run({ scene: 1, content }), /拒绝/);
  assert.match(await denied.assemble_scenes.run({}), /拒绝/);
  assert.equal(sceneDraftStatus(project), null);
  const allowed = makeTools(project, () => {}, { mode: 'edit-visual' });
  assert.match(await allowed.write_scene.run({ scene: 1, content }), /已保存/);
  const file = path.join(project, 'out/.vh-scene-drafts/S1.js'); const before = fs.statSync(file).mtimeMs;
  assert.match(await allowed.write_scene.run({ scene: 1, content }), /未重复写入/);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('真实本地 HTTP 流截断 → 缩成一场 → 保存三场 → 原子组装 → 完成，不扣模型额度', async t => {
  const project = fixture(t); let httpCalls = 0; const logs = [];
  const response = async (_prov, messages, tools, opts) => {
    httpCalls++;
    const sse = httpCalls === 1
      ? event({ tool_calls: [{ index: 0, id: 'partial', function: { name: 'write_scene', arguments: '{"scene":1,"content":"root => {' } }] }) + event({}, 'length') + 'data: [DONE]\n\n'
      : null;
    if (sse) return requestChat(providers[0], messages, tools, { ...opts, fetchImpl: async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) });
    if (httpCalls <= 4) return calls(tool('s' + (httpCalls - 1), 'write_scene', { scene: httpCalls - 1, content: draft(httpCalls - 1) }));
    if (httpCalls === 5) return calls(tool('assembled', 'assemble_scenes', {}));
    return reply('草稿已组装，待用户审阅');
  };
  const result = await runAgent(project, '逐场写', { taskId: 'stream-and-scenes', mode: 'edit-visual', providers,
    request: response, log: text => logs.push(text), stepBudget: 12 });
  assert.equal(result.status, 'completed'); assert.equal(httpCalls, 6);
  assert.match(logs.join('\n'), /整批工具未执行/);
  const cp = readCheckpoint(project, 'stream-and-scenes');
  assert.equal(cp.messages.some(m => m.tool_calls?.some(c => c.id === 'partial')), false);
  assert.equal(cp.messages.filter(m => m.role === 'tool').length, 4);
  assert.equal(fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8').split(/^\/\/---$/m).length, 3);
});

test('连续截断有上限且跨恢复保留；新用户指令可重新给予机会', async t => {
  const project = fixture(t);
  const raw = event({ tool_calls: [{ index: 0, id: 'partial', function: { name: 'write_scene', arguments: '{' } }] }) + event({}, 'length') + 'data: [DONE]\n\n';
  const fail = async (_p, m, tools, opts) => requestChat(providers[0], m, tools, { ...opts,
    fetchImpl: async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }) });
  const result = await runAgent(project, '开始制作', { taskId: 'limit', mode: 'article', providers, request: fail, stepBudget: 20 });
  assert.equal(result.status, 'paused'); assert.equal(readCheckpoint(project, 'limit').truncationStreak, 2);
  assert.equal(readCheckpoint(project, 'limit').messages.filter(m => m.role === 'tool').length, 0);
  const again = await runAgent(project, '开始制作', { taskId: 'limit', mode: 'article', providers,
    resume: true, stepBudget: 5, request: fail });
  assert.equal(again.status, 'paused'); assert.equal(readCheckpoint(project, 'limit').truncationStreak, 3);
  let seen = '';
  const steered = await runAgent(project, '开始制作', { taskId: 'limit', mode: 'article', providers,
    resume: true, instruction: '每次只写 S1', stepBudget: 1, request: async (_p, msgs) => {
      seen = msgs.map(m => m.content || '').join('\n'); return calls(tool('s1', 'write_scene', { scene: 1, content: draft(1) }));
    } });
  assert.match(seen, /每次只写 S1/); assert.equal(steered.status, 'paused');
  assert.equal(readCheckpoint(project, 'limit').truncationStreak, 0);
});

test('恢复时写场景执行中：确认内容而不重复写入', async t => {
  const project = fixture(t), draftBody = draft(1); writeSceneDraft(project, 1, draftBody);
  const f = path.join(project, 'out/.vh-scene-drafts/S1.js'); const before = fs.statSync(f).mtimeMs;
  const c = tool('unfinished', 'write_scene', { scene: 1, content: draftBody });
  writeCheckpoint(project, { schemaVersion: 1, taskId: 'recover', mode: 'edit-visual', status: 'failed',
    messages: [{ role: 'user', content: '写一场' }, { role: 'assistant', content: null, tool_calls: [c] }], pending: [{ call: c, status: 'executing' }] });
  await runAgent(project, '写一场', { taskId: 'recover', mode: 'edit-visual', resume: true, providers,
    request: async (_p, msgs) => { assert.match(msgs.find(m => m.tool_call_id === 'unfinished').content, /逐字一致/); return reply('已核对'); } });
  assert.equal(fs.statSync(f).mtimeMs, before);
});

test('恢复组装执行中：产物相同就核对，不重放组装', async t => {
  const project = fixture(t, 2); writeSceneDraft(project, 1, draft(1)); writeSceneDraft(project, 2, draft(2));
  assembleSceneDrafts(project);
  const source = path.join(project, 'scenes.src.js'), before = fs.statSync(source).mtimeMs;
  const c = tool('assemble-pending', 'assemble_scenes', {});
  writeCheckpoint(project, { schemaVersion: 1, taskId: 'recover-assemble', mode: 'edit-visual', status: 'failed',
    messages: [{ role: 'user', content: '组装' }, { role: 'assistant', content: null, tool_calls: [c] }], pending: [{ call: c, status: 'executing' }] });
  await runAgent(project, '组装', { taskId: 'recover-assemble', mode: 'edit-visual', resume: true, providers,
    request: async (_p, msgs) => { assert.match(msgs.find(m => m.tool_call_id === 'assemble-pending').content, /逐字一致/); return reply('已核对'); } });
  assert.equal(fs.statSync(source).mtimeMs, before);
});
