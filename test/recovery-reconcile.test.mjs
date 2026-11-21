/* 真实事故：用户从命令行补完 build/render/voice 后，网页任务仍带着旧的
 * 「修复额度耗尽」暂停记录；再点继续仍按旧错误停下，而实际产物早已就绪。
 * 旧记录只能描述当时的失败，不能冒充现在的失败。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../lib/agent.mjs';
import { writeCheckpoint, readCheckpoint } from '../lib/checkpoint.mjs';
import { currentArtifactInputs, hashFile } from '../lib/artifact-status.mjs';
import { productionFailure, productionRepairSignature } from '../lib/automation.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({
    'PROJECT.json': '{"deliveryTarget":"video"}',
    '方案.md': '# 方案\n\n| 场 | 内容 |\n|---|---|\n| S1 | 展示 |\n',
    '脚本.md': '**主体**：测试窗口\n## S1 · 一\n1. 测试窗口展示当前内容。\n← 依赖：无\n',
    'claims.json': '[]',
    'scenes.src.js': '// @layout 测试\nroot => { const el = mk("div","","测试窗口"); root.appendChild(el); return {render(){}}; }',
    'engine.tpl.html': "const ORIENT = 'landscape';",
    'scene.html': 'const scenes = []; addScene(0, 10, ()=>{}); const DURATION = 10;',
  })) fs.writeFileSync(path.join(dir, name), content);
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  return dir;
}
function stamp(dir) {
  fs.writeFileSync(path.join(dir, 'out/.vh-state.json'), JSON.stringify({ genStamp: {
    scriptHash: hashFile(path.join(dir, '脚本.md')), scenesHash: hashFile(path.join(dir, 'scenes.src.js')),
    sourceHashes: currentArtifactInputs(dir).sourceHashes,
  } }));
}
function seed(dir, reason, stage = 'build') {
  // These are historical bad records, not new failures: today's classifier
  // must never interpret a successful exit=0 build warning as repairable failure.
  const ledger = productionFailure({}, { stage, reason: reason.replace(/^exit=0/, 'exit=1'), sourceSignature: productionRepairSignature(dir), maxRepairs: 0 });
  ledger.stoppedReason = reason;
  ledger.stop = ledger.stop.replace('exit=1', 'exit=0');
  assert.match(ledger.stop, /0 轮上限/);
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'reconcile', mode: 'article', task: '完成视频', status: 'paused',
    pending: [], messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '完成视频' }],
    changeContracts: [], automation: { enabled: true, maxRepairs: 0 }, pipelineState: { productionRepairs: ledger } });
  return ledger;
}

test('旧停止记录已不成立：当前产物满足该阶段时清除暂停，但保留已用修复次数', async t => {
  const dir = fixture(t); stamp(dir);
  seed(dir, 'exit=0\n阶段 build；完整日志 out/.v.log\nFAIL 结构检查');
  const logs = [];
  const result = await runAgent(dir, '完成视频', { mode: 'article', taskId: 'reconcile', resume: true, stepBudget: 1,
    providers, log: line => logs.push(line), request: async () => ({ choices: [{ message: { role: 'assistant', content: '继续核对' }, finish_reason: 'stop' }] }) });
  assert.match(logs.join('\n'), /实际产物已就绪，清除旧的失败\/暂停记录/);
  assert.doesNotMatch(result.paused || '', /0 轮上限/);
  const ledger = readCheckpoint(dir, 'reconcile').pipelineState.productionRepairs;
  assert.equal(ledger.stop, null);
  assert.equal(ledger.history.length, 0, '不清零、也不伪造修复轮次');
});

test('阶段仍不成立时保持暂停，不调用模型、不改作者文件', async t => {
  const dir = fixture(t); // 故意不写 build 基线
  seed(dir, 'exit=0\n阶段 build；完整日志 out/.v.log\nFAIL 结构检查');
  const before = fs.readFileSync(path.join(dir, 'scenes.src.js'));
  let requests = 0;
  const result = await runAgent(dir, '完成视频', { mode: 'article', taskId: 'reconcile', resume: true, stepBudget: 1,
    providers, request: async () => { requests++; throw new Error('不应请求模型'); } });
  assert.equal(requests, 0);
  assert.equal(result.status, 'paused');
  assert.match(result.paused, /0 轮上限/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'scenes.src.js')), before);
});

test('上报的阶段与当前状态不符时不误清：产物状态里的其他过期项仍会阻止', async t => {
  const dir = fixture(t); stamp(dir);
  // 让 timeline.mjs 可判 measure 无效：无 timing.json，measure 状态不成立。
  seed(dir, 'exit=0\n阶段 measure；完整日志 out/.v.log\nFAIL 时间轴不一致', 'measure');
  let requests = 0;
  const result = await runAgent(dir, '完成视频', { mode: 'article', taskId: 'reconcile', resume: true, stepBudget: 1,
    providers, request: async () => { requests++; throw new Error('不应请求模型'); } });
  assert.equal(requests, 0);
  assert.equal(result.status, 'paused');
  assert.match(result.paused, /0 轮上限/);
});
