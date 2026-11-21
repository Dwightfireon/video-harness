import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, makeTools } from '../lib/agent.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { readCheckpoint } from '../lib/checkpoint.mjs';
import { productionFailure, productionRepairSignature } from '../lib/automation.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
function fixture(t, failure = 'FAIL 版式溢出') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-auto-agent-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ 'PROJECT.json': '{"deliveryTarget":"video"}', '方案.md': '方案', 'claims.json': '[]',
    '脚本.md': '## S1 · 一\n1. 展示一个窗口。\n', 'scenes.src.js': 'root => { const label = 0; return {render(t){}}; }',
    'engine.tpl.html': "const ORIENT = 'landscape';", 'scene.html': 'const DURATION = 2; const scenes = []; addScene(0,2,()=>{});',
    'gen.mjs': `console.error(${JSON.stringify(failure)}); process.exit(7);` })) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
const toolReply = args => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
  { id: 'patch-' + args.base_hash, type: 'function', function: { name: 'patch_text', arguments: JSON.stringify(args) } },
  { id: 'finish-' + args.base_hash, type: 'function', function: { name: 'finish_repair', arguments: '{}' } },
] }, finish_reason: 'tool_calls' }] });
const replyCalls = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map(([name, args], i) =>
  ({ id: name + '-' + i, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: 'tool_calls' }] });
const patchArgs = (dir, before, after) => ({ path: 'scenes.src.js', base_hash: readEditFile(dir, 'scenes.src.js').base_hash,
  find: 'label = ' + before, replace: 'label = ' + after, expected_count: 1 });

test('无人模式：阶段失败在同一次执行进入真实短补丁修复，有界停止且恢复不清预算', async t => {
  const dir = fixture(t), logs = []; let requests = 0;
  const options = { mode: 'article', automation: { enabled: true, maxRepairs: 2 }, providers, taskId: 'auto-fixture', stepBudget: 20, log: m => logs.push(m),
    request: async () => {
      requests++;
      const current = readEditFile(dir, 'scenes.src.js');
      return toolReply({ path: 'scenes.src.js', base_hash: current.base_hash, find: `label = ${requests - 1}`, replace: `label = ${requests}`, expected_count: 1 });
    } };
  const result = await runAgent(dir, '完成当前片子', options);
  assert.equal(result.status, 'paused'); assert.equal(requests, 2);
  assert.match(result.paused, /2 轮上限/);
  assert.match(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), /label = 2/);
  const checkpoint = readCheckpoint(dir, 'auto-fixture');
  assert.equal(checkpoint.pipelineState.productionRepairs.history.length, 2);
  assert.equal(checkpoint.automation.enabled, true);
  const resumed = await runAgent(dir, '完成当前片子', { ...options, automation: undefined, resume: true });
  assert.equal(resumed.status, 'paused'); assert.equal(requests, 2);
  assert.ok(logs.some(line => line.includes('自动制作阶段 build')));
  assert.equal(fs.existsSync(path.join(dir, '审查.md')), false);
});
test('无人模式：环境故障立即保留现场，不让模型乱改内容或调用更多请求', async t => {
  const dir = fixture(t, 'ENOSPC 无可用空间'); let requests = 0;
  const result = await runAgent(dir, '继续制作', { mode: 'article', automation: true, providers, taskId: 'auto-environment', stepBudget: 10,
    request: async () => { requests++; throw new Error('环境故障不应请求模型改稿'); } });
  assert.equal(result.status, 'paused'); assert.match(result.paused, /环境/); assert.equal(requests, 0);
  assert.match(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), /label = 0/);
});
test('自动制作不允许通过通用run绕过受控阶段', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'article', automation: { enabled: true } });
  const result = await tools.run.run({ command: `node "${path.resolve('vh.mjs')}" render --force` });
  assert.match(result, /拒绝.*run_stage/);
  assert.match(await tools.run.run({ command: 'node -e "require(\"fs\").writeFileSync(\"out/.vh-production-quality.json\",\"{}\")"' }), /拒绝/);
  for (const file of ['out/.vh-production-quality.json', 'out/.vh-state.json', 'render.mjs', '审查.md']) {
    assert.match(await tools.write_file.run({ path: file, content: '{}' }), /拒绝/);
  }
});

test('同一轮跨请求多次补丁，只有 finish_repair 后才复检', async t => {
  const dir = fixture(t), logs = []; let requests = 0;
  const result = await runAgent(dir, '完成当前片子', { mode: 'article', automation: { enabled: true, maxRepairs: 1 },
    providers, taskId: 'multi-patch', stepBudget: 20, log: line => logs.push(line), request: async () => {
      requests++;
      if (requests <= 2) return replyCalls(['patch_text', patchArgs(dir, requests - 1, requests)]);
      return replyCalls(['finish_repair', {}]);
    } });
  assert.equal(result.status, 'paused'); assert.match(result.paused, /1 轮上限/);
  assert.equal(requests, 3); assert.match(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), /label = 2/);
  const ledger = readCheckpoint(dir, 'multi-patch').pipelineState.productionRepairs;
  assert.equal(ledger.history.length, 1); assert.ok(ledger.history[0].submittedAt);
  assert.equal(ledger.history[0].workingSignature, ledger.history[0].submittedSignature);
  assert.equal(logs.filter(line => line.includes('自动制作阶段 build')).length, 2, '只在修完提交后重新构建');
});

test('未提交的受控补丁跨暂停恢复，保留本轮和预算', async t => {
  const dir = fixture(t), logs = []; let requests = 0;
  const options = { mode: 'article', automation: { enabled: true, maxRepairs: 1 }, providers, taskId: 'multi-resume',
    log: line => logs.push(line), request: async () => {
      requests++;
      if (requests <= 2) return replyCalls(['patch_text', patchArgs(dir, requests - 1, requests)]);
      return replyCalls(['finish_repair', {}]);
    } };
  await runAgent(dir, '完成当前片子', { ...options, stepBudget: 2 });
  const first = readCheckpoint(dir, 'multi-resume').pipelineState.productionRepairs;
  assert.equal(requests, 1); assert.ok(first.pending?.workingSignature); assert.equal(first.history.length, 1);
  assert.equal(logs.filter(line => line.includes('自动制作阶段 build')).length, 1);
  const result = await runAgent(dir, '完成当前片子', { ...options, resume: true, stepBudget: 20 });
  assert.equal(result.status, 'paused'); assert.match(result.paused, /1 轮上限/); assert.equal(requests, 3);
  const final = readCheckpoint(dir, 'multi-resume').pipelineState.productionRepairs;
  assert.ok(final.history[0].submittedAt); assert.equal(final.history.length, 1);
  assert.equal(logs.filter(line => line.includes('自动制作阶段 build')).length, 2);
});

test('连续两个恢复窗口只读不提交修复时停止，并给出可定位的下一步', async t => {
  const dir = fixture(t), taskId = 'stalled-repair';
  const ledger = productionFailure({}, { stage: 'render', reason: 'FAIL 版式溢出：`label` 超出容器',
    sourceSignature: productionRepairSignature(dir), maxRepairs: 2 });
  fs.mkdirSync(path.join(dir, 'out/.vh-tasks/' + taskId), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/.vh-tasks/' + taskId + '/checkpoint.json'), JSON.stringify({
    schemaVersion: 1, taskId, mode: 'article', status: 'paused', messages: [{ role: 'user', content: '完成当前片子' }],
    pending: [], automation: { enabled: true, maxRepairs: 2 },
    pipelineState: { productionRepairs: ledger, repairWindowStalled: true } }));
  let requests = 0;
  const readOnly = async () => {
    requests++;
    return replyCalls(['read_file', { path: 'scenes.src.js' }]);
  };
  const options = { mode: 'article', automation: { enabled: true, maxRepairs: 2 }, providers, taskId, resume: true, stepBudget: 2 };
  const first = await runAgent(dir, '完成当前片子', { ...options, request: readOnly });
  assert.equal(first.status, 'paused');
  const windows = readCheckpoint(dir, taskId).pipelineState;
  assert.equal(windows.repairStalledWindows, 1); assert.equal(windows.repairWindowStalled, true);
  const second = await runAgent(dir, '完成当前片子', { ...options, request: readOnly });
  assert.equal(second.status, 'paused');
  assert.match(second.paused, /连续两个恢复窗口都没有提交本轮修复/);
  assert.match(second.paused, /finish_repair/);
  const stopped = readCheckpoint(dir, taskId).pipelineState.productionRepairs;
  assert.ok(stopped.pending, '停止不提交、不清空待修问题');
  assert.equal(stopped.history.length, 1);
});

test('外部输入变化不能冒充受控补丁或提交，保留外部文件和已用预算', async t => {
  const dir = fixture(t), logs = []; let requests = 0;
  const result = await runAgent(dir, '完成当前片子', { mode: 'article', automation: { enabled: true, maxRepairs: 1 },
    providers, taskId: 'external-repair', stepBudget: 20, log: line => logs.push(line), request: async () => {
      requests++;
      fs.appendFileSync(path.join(dir, 'engine.tpl.html'), '\n// 用户外部修改');
      return replyCalls(['patch_text', patchArgs(dir, 0, 1)], ['finish_repair', {}]);
    } });
  assert.equal(result.status, 'paused'); assert.equal(requests, 1);
  assert.match(fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8'), /用户外部修改/);
  assert.match(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), /label = 0/);
  const ledger = readCheckpoint(dir, 'external-repair').pipelineState.productionRepairs;
  assert.equal(ledger.history.length, 1); assert.equal(ledger.history[0].submittedAt, undefined);
  assert.match(logs.join('\n'), /外部|未知变化/);
});

test('补丁落盘后同一文件又被外部修改时，不能把外部字节记成修复结果', async t => {
  const dir = fixture(t), logs = []; let requests = 0, altered = false;
  const result = await runAgent(dir, '完成当前片子', { mode: 'article', automation: { enabled: true, maxRepairs: 1 },
    providers, taskId: 'same-file-conflict', stepBudget: 20, log: line => {
      logs.push(line);
      if (!altered && line.includes('短片段已保存')) {
        altered = true; fs.appendFileSync(path.join(dir, 'scenes.src.js'), '\n// 用户随后修改');
      }
    }, request: async () => {
      requests++; return replyCalls(['patch_text', patchArgs(dir, 0, 1)], ['finish_repair', {}]);
    } });
  assert.equal(result.status, 'paused'); assert.equal(requests, 1); assert.equal(altered, true);
  const text = fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8');
  assert.match(text, /label = 1/); assert.match(text, /用户随后修改/);
  const ledger = readCheckpoint(dir, 'same-file-conflict').pipelineState.productionRepairs;
  assert.equal(ledger.history.length, 1); assert.equal(ledger.history[0].submittedAt, undefined);
  assert.match(logs.join('\n'), /提交结果或其他输入发生变化/);
});
