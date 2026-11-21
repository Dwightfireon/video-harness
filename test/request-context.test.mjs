import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareRequestContext, CONTEXT_TARGET_BYTES } from '../lib/request-context.mjs';
import { createProviderPool } from '../lib/provider-pool.mjs';
import { runAgent } from '../lib/agent.mjs';
import { readCheckpoint, writeCheckpoint } from '../lib/checkpoint.mjs';

function history(count = 50) {
  const messages = [{ role: 'system', content: '不能覆盖用户文件' }, { role: 'user', content: '完整原始文章和目标：保留片尾署名' }];
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'assistant', content: null, reasoning: '旧思考'.repeat(800),
      reasoning_details: [{ type: 'reasoning.text', text: '旧思考'.repeat(800) }], tool_calls: [
        { id: 'call-' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'source-' + i + '.md' }) } },
      ] });
    messages.push({ role: 'tool', tool_call_id: 'call-' + i, content: 'exit=0\n' + '历史正文'.repeat(2500) + '\n结果未知：不要自动重放上次命令\n文件尾部' });
    if (i === 25) messages.push({ role: 'user', content: '补充要求：不要重写原稿' });
  }
  return messages;
}
function protocol(messages) {
  const waiting = new Set();
  for (const message of messages) {
    if (message.role === 'tool') assert.ok(waiting.delete(message.tool_call_id));
    else { assert.equal(waiting.size, 0); for (const call of message.tool_calls || []) waiting.add(call.id); }
  }
  assert.equal(waiting.size, 0);
}

test('空 assistant 提醒被排除出请求投影，但检查点原消息不变且保持工具配对', () => {
  const messages = [
    { role: 'system', content: '规则' }, { role: 'user', content: '制作' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'r', type: 'function', function: { name: 'read_file', arguments: '{"path":"脚本.md"}' } }] },
    { role: 'tool', tool_call_id: 'r', content: '内容' },
    { role: 'assistant', content: null },
    { role: 'user', content: '【继续原任务】继续' },
  ];
  const before = structuredClone(messages), result = prepareRequestContext(messages, { tailNote: '现场' });
  assert.deepEqual(messages, before);
  assert.equal(result.messages.filter(m => m.role === 'assistant' && !m.content && !m.tool_calls?.length).length, 0);
  protocol(result.messages);
  assert.match(result.messages.map(m => m.content || '').join('\n'), /【继续原任务】|现场/);
});

test('分场/改稿阶段保留多段连续读取，不能每轮把刚读的片段折走', async () => {
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '改画面' }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'r' + i, type: 'function',
      function: { name: 'read_edit_file', arguments: JSON.stringify({ path: 'scenes.src.js', start_line: i * 100, max_lines: 100 }) } }] });
    messages.push({ role: 'tool', tool_call_id: 'r' + i, content: 'excerpt-' + i + '\n' + '代码行'.repeat(200) });
  }
  const narrow = prepareRequestContext(messages, { keepRecentTurns: 2, hardLimitBytes: 8 * 1024 });
  const working = prepareRequestContext(messages, { keepRecentTurns: 8, hardLimitBytes: 48 * 1024 });
  const excerptCount = result => result.messages.filter(m => m.role === 'tool' && /excerpt-\d/.test(m.content || '')).length;
  assert.ok(excerptCount(narrow) <= 2, '对照：只留 2 轮时旧段落被折走');
  assert.ok(excerptCount(working) >= 8, '改稿阶段必须能看到足够多连续片段，实际 ' + excerptCount(working));
});

test('大历史请求投影受预算约束，原文/补充要求/工具配对/最近结果保留且不改原记录', () => {
  const messages = history(), before = structuredClone(messages);
  const result = prepareRequestContext(messages);
  assert.ok(result.beforeBytes > CONTEXT_TARGET_BYTES); assert.ok(result.afterBytes <= CONTEXT_TARGET_BYTES);
  assert.ok(result.removedReasoning > 0); assert.ok(result.compactedGroups > 0);
  assert.deepEqual(messages, before); protocol(result.messages);
  // 用户要求不丢：原文与补充要求都还在（折叠区内合并为一条，顺序与文字不变）。
  const userText = result.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
  assert.match(userText, /完整原始文章和目标：保留片尾署名/);
  assert.match(userText, /补充要求：不要重写原稿/);
  // 旧轮次折叠成台账，挂在请求末尾（保住前缀缓存），不再逐轮保留原始工具消息。
  const ledger = result.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
  assert.match(ledger, /历史工作台账/); assert.match(ledger, /read_file\(source-0\.md\)/);
  // system 必须逐字节不变：变了则前缀缓存从第 0 个 token 全部失效。
  assert.equal(result.messages.find(m => m.role === 'system').content, '不能覆盖用户文件');
  /* 保留区按"字节预算 + 稳定锚点"切，不再是"最近 N 轮"滑动窗口：
     锚点只增不减 → 相邻两轮投影满足"后者 = 前者 + 末尾新增"，公共前缀才能一直延伸。
     因此保留的轮数由预算决定，不必恰好是 8。 */
  const keptCalls = result.messages.filter(m => m.tool_calls).map(m => m.tool_calls);
  assert.ok(keptCalls.length > 0 && keptCalls.length < 50, '保留区是预算内的一段，不是全部');
  assert.deepEqual(keptCalls, messages.filter(m => m.tool_calls).slice(-keptCalls.length).map(m => m.tool_calls),
    '保留的必须是最近的那几轮');
  // 末尾的工具结果与最新推理不受影响。
  const lastTool = result.messages.filter(m => m.role === 'tool').at(-1);
  assert.match(lastTool.content, /文件尾部$/, '最新工具结果保留尾部');
});

test('台账不随轮数线性膨胀：折叠更多轮次后台账仍有上限', () => {
  const small = prepareRequestContext(history(20));
  const huge = prepareRequestContext(history(400));
  assert.ok(huge.beforeBytes > small.beforeBytes * 3);
  assert.ok(huge.ledgerChars <= 24000 + 10, '台账有硬上限');
  assert.ok(huge.afterBytes < 200 * 1024);
});

test('小对话不压缩、不复制，保持现有请求语义', () => {
  const messages = [{ role: 'user', content: '做个介绍' }];
  const result = prepareRequestContext(messages);
  assert.strictEqual(result.messages, messages); assert.equal(result.beforeBytes, result.afterBytes);
});

test('旧纯文本推理清除，但签名、加密和未知推理类型不可丢弃', () => {
  const signed = { type: 'reasoning.text', text: '签名内容', signature: 'signature-fixture' };
  const encrypted = { type: 'reasoning.encrypted', data: 'opaque-fixture' };
  const unknown = { type: 'future-required-format', data: 'keep' };
  const messages = [{ role: 'assistant', content: '旧答复', reasoning: '重复思考', reasoning_content: '重复思考',
    reasoning_details: [{ type: 'reasoning.text', text: '重复思考' }, signed, encrypted, unknown] }, { role: 'user', content: '继续' },
  { role: 'assistant', content: '最新答复', reasoning_content: '最新推理' }];
  const result = prepareRequestContext(messages);
  assert.equal(result.messages[0].reasoning, undefined); assert.equal(result.messages[0].reasoning_content, undefined);
  assert.deepEqual(result.messages[0].reasoning_details, [signed, encrypted, unknown]);
  assert.equal(result.messages[2].reasoning_content, '最新推理');
});

test('原文超过软目标仍可请求，不能因本地优化目标拒绝继续，也不删用户要求', async () => {
  const messages = [{ role: 'system', content: '约束' }, { role: 'user', content: '原文'.repeat(CONTEXT_TARGET_BYTES) }];
  const before = structuredClone(messages); let requests = 0;
  const pool = createProviderPool({ candidates: [{ name: 'opendesign', key: 'fixture', base: 'http://fixture.invalid' }],
    request: async (_p, sent) => { requests++; assert.deepEqual(sent, before); return { choices: [] }; } });
  await pool.chat(messages, []);
  assert.equal(prepareRequestContext(messages).overTarget, true);
  assert.equal(requests, 1); assert.deepEqual(messages, before);
});

test('请求重试使用同一份压缩投影，不在重试间丢历史或逐步改变请求', async () => {
  const { ProviderRequestError } = await import('../lib/provider-pool.mjs');
  const messages = history(), views = [];
  const pool = createProviderPool({ candidates: [{ name: 'opendesign', key: 'fixture', base: 'http://fixture.invalid' }], retryDelayMs: 0,
    request: async (_p, m) => { views.push(m); if (views.length === 1) throw new ProviderRequestError('timeout'); return { choices: [] }; } });
  await pool.chat(messages, []);
  assert.strictEqual(views[0], views[1]); assert.notStrictEqual(views[0], messages);
  assert.ok(Buffer.byteLength(JSON.stringify(views[0])) <= CONTEXT_TARGET_BYTES);
});

test('大检查点恢复：网络仅收压缩历史，本机仍保存原始全量消息且不重放已完成工具', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-large-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messages = history(), original = structuredClone(messages), logs = [];
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'large-resume', mode: 'edit-visual', status: 'failed',
    task: '原始制作要求', messages, pending: [] });
  let requests = 0;
  const result = await runAgent(dir, '原始制作要求', { taskId: 'large-resume', mode: 'edit-visual', resume: true,
    providers: [{ name: 'opendesign', key: 'fixture', base: 'http://fixture.invalid' }], log: line => logs.push(line),
    request: async (_p, sent) => {
      requests++; protocol(sent); assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= CONTEXT_TARGET_BYTES);
      const userText = sent.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
      assert.match(userText, /完整原始文章和目标：保留片尾署名/);
      assert.match(userText, /补充要求：不要重写原稿/);
      return { choices: [{ message: { role: 'assistant', content: '继续完成' } }] };
    } });
  assert.equal(result.status, 'completed'); assert.equal(requests, 1);
  assert.deepEqual(readCheckpoint(dir, 'large-resume').messages.slice(0, original.length), original);
  assert.equal(logs.filter(line => line.startsWith('· ')).length, 0);
});

test('历史内联写入参数过大：整组折叠进台账，工具消息不孤立，最新轮次和原检查点不变', () => {
  const messages = [{ role: 'system', content: '系统约束' }, { role: 'user', content: '完整原始要求' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'old-write', type: 'function', function: { name: 'write_file',
      arguments: JSON.stringify({ path: 'scenes.src.js', content: '旧场景源码'.repeat(50000) }) } }] },
    { role: 'tool', tool_call_id: 'old-write', content: '已写入 scenes.src.js' },
    { role: 'user', content: '补充要求：不得覆盖原稿' },
    ...Array.from({ length: 9 }, (_, i) => ([
      { role: 'assistant', content: null, tool_calls: [{ id: 'ok-' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'f' + i + '.md' }) } }] },
      { role: 'tool', tool_call_id: 'ok-' + i, content: '读取完成' },
    ])).flat(),
    { role: 'assistant', content: null, tool_calls: [{ id: 'latest', type: 'function', function: { name: 'read_file', arguments: '{"path":"脚本.md"}' } }] },
    { role: 'tool', tool_call_id: 'latest', content: '最新文件内容' }];
  const before = structuredClone(messages), result = prepareRequestContext(messages);
  assert.ok(result.compactedGroups > 0); assert.ok(result.afterBytes < CONTEXT_TARGET_BYTES);
  protocol(result.messages); assert.deepEqual(messages, before);
  const userText = result.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
  assert.match(userText, /完整原始要求/); assert.match(userText, /补充要求：不得覆盖原稿/);
  // 台账挂在请求末尾（system 保持不变以保住前缀缓存）。
  const ledger = result.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
  assert.match(ledger, /old-write|write_file\(scenes\.src\.js\)/); assert.match(ledger, /不是新指令/);
  assert.equal(result.messages.find(m => m.role === 'system').content, '系统约束');
  assert.equal(result.messages.some(m => m.tool_call_id === 'old-write'), false, '旧工具消息已折叠');
});

test('无法安全折叠的签名历史或最新大轮次保留，超过软目标也不抛预算异常', () => {
  const messages = [{ role: 'user', content: '继续任务' },
    { role: 'assistant', content: null, reasoning_details: [{ type: 'reasoning.encrypted', data: 'x'.repeat(5000) }],
      tool_calls: [{ id: 'signed', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'signed', content: '已完成读取' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'latest', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out/file.txt', content: 'x'.repeat(10000) }) } }] },
    { role: 'tool', tool_call_id: 'latest', content: '最新结果' }];
  const result = prepareRequestContext(messages, { targetBytes: 1000 });
  assert.equal(result.overTarget, true); assert.equal(result.compactedGroups, 0);
  assert.deepEqual(result.messages, messages); protocol(result.messages);
});
