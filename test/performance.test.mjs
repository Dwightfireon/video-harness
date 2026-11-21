import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { recordPerformance, performanceSummary, performanceReport, ingestRendererEvents, performanceRunId } from '../lib/performance.mjs';
import { createProviderPool, ProviderRequestError } from '../lib/provider-pool.mjs';

test('stage timings separate inclusive commands from steps and keep failures', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-performance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(performanceSummary(dir).ok, false);
  assert.equal(recordPerformance(dir, { kind: 'step', stage: 'render', elapsedMs: 200, ok: false }), true);
  recordPerformance(dir, { kind: 'step', stage: 'render', elapsedMs: 100, ok: true });
  recordPerformance(dir, { kind: 'command', stage: 'go', elapsedMs: 400, ok: true });
  assert.equal(recordPerformance(dir, { kind: 'step', stage: 'bad', elapsedMs: NaN, ok: true }), false);
  const summary = performanceSummary(dir);
  assert.equal(summary.events, 3);
  assert.deepEqual(summary.groups.find(g => g.stage === 'render'), { kind: 'step', stage: 'render', count: 2, failed: 1, totalMs: 300, lastMs: 100 });
  assert.match(performanceReport(summary), /不能相加/);
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  const before = fs.readFileSync(path.join(dir, 'out/.vh-performance.jsonl'), 'utf8');
  const result = spawnSync(process.execPath, ['vh.mjs', 'performance', '--json', '--dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).events, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'out/.vh-performance.jsonl'), 'utf8'), before, 'report is read-only');
});

test('renderer stage events from another run or malformed lines are never trusted', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-performance-renderer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = performanceRunId();
  const good = { schemaVersion: 1, runId: run, kind: 'renderer-stage', stage: 'screenshot', elapsedMs: 12, ok: true, frames: 30 };
  const stdout = [
    'progress noise\r' + JSON.stringify(good),
    'VH_RENDER_STAGE ' + JSON.stringify(good),
    'VH_RENDER_STAGE ' + JSON.stringify({ ...good, runId: '00000000-0000-4000-8000-000000000000' }),
    'VH_RENDER_STAGE ' + JSON.stringify({ ...good, schemaVersion: 2 }),
    'VH_RENDER_STAGE ' + JSON.stringify({ ...good, stage: 'unknown' }),
    'VH_RENDER_STAGE not json',
    'VH_RENDER_STAGE ' + JSON.stringify({ ...good, stage: 'encode', elapsedMs: -1 }),
    'VH_RENDER_STAGE ' + JSON.stringify({ ...good, stage: 'encode' }),
    'VH_RENDER_STAGE ' + JSON.stringify({ ...good, stage: 'concat', ok: false }),
  ].join('\n');
  assert.equal(ingestRendererEvents(dir, stdout, { runId: run }), 3);
  // Not a fresh-line prefix (carriage-return suffix) is ignored, not guessed.
  assert.equal(ingestRendererEvents(dir, stdout, { runId: 'wrong' }), 0);
  const summary = performanceSummary(dir);
  assert.deepEqual(summary.groups.map(g => [g.stage, g.count]).filter(x => x[0].startsWith('渲染')), [['渲染截图（30 帧）', 1], ['渲染编码', 1], ['渲染拼接', 1]]);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].stage, '渲染拼接');
});

test('failure diagnostics correlate steps with commands without recording raw errors', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-performance-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  recordPerformance(dir, { kind: 'step', stage: 'render', elapsedMs: 200, ok: true, exitCode: 0 });
  recordPerformance(dir, { kind: 'command', stage: 'go', elapsedMs: 220, ok: false, exitCode: 1, failureCode: 'inputs-changed' });
  recordPerformance(dir, { kind: 'command', stage: 'voice', elapsedMs: 20, ok: false, failureCode: 'secret-token-should-not-be-recorded' });
  const rows = fs.readFileSync(path.join(dir, 'out/.vh-performance.jsonl'), 'utf8');
  assert.doesNotMatch(rows, /secret-token/);
  const parsed = rows.trim().split('\n').map(JSON.parse);
  assert.equal(parsed[0].runId, parsed[1].runId);
  const summary = performanceSummary(dir);
  assert.equal(summary.failures[0].failureCode, 'inputs-changed');
  assert.equal(summary.failures[0].exitCode, 1);
  assert.equal(summary.failures[1].failureCode, 'unknown');
  assert.match(performanceReport(summary), /inputs-changed/);
});

test('iteration observations use actual stage counts without summing nested times or promising savings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-performance-iterations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 2; i++) {
    recordPerformance(dir, { kind: 'step', stage: '渲染器（截图与编码）', elapsedMs: 1000, ok: true });
    recordPerformance(dir, { kind: 'step', stage: '渲染截图（30 帧）', elapsedMs: 800, ok: true });
  }
  recordPerformance(dir, { kind: 'command', stage: 'build', elapsedMs: 100, ok: false });
  const res = performanceSummary(dir);
  assert.equal(res.observations.length, 3);
  assert.match(res.observations[0], /启动 2 次，累计 2.00s/);
  assert.match(res.observations[1], /不能据此推算可节省时长/);
  assert.match(performanceReport(res), /先检查纯旁白/);
  assert.deepEqual(performanceSummary(path.join(dir, 'missing')).observations, []);
});

test('模型请求逐次实测，失败和重试等待分开记录，不泄露请求或凭证、不推算端到端收益', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-performance-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const timings = []; let attempts = 0;
  const pool = createProviderPool({ candidates: [{ name: 'opendesign', base: 'http://private.invalid', key: 'sensitive-key' }], retryDelayMs: 2,
    onTiming: event => { timings.push(event); recordPerformance(dir, { kind: 'model', ...event, failureCode: 'model-request-failed' }); },
    request: async () => { if (++attempts === 1) throw new ProviderRequestError('timeout'); return { choices: [] }; } });
  await pool.chat([{ role: 'user', content: 'private-user-prompt' }], []);
  assert.deepEqual(timings.map(t => [t.stage, t.ok]), [['模型请求', false], ['模型重试等待', true], ['模型请求', true]]);
  assert.ok(timings.every(t => Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0));
  const summary = performanceSummary(dir);
  assert.equal(summary.groups.find(g => g.stage === '模型请求').count, 2);
  assert.equal(summary.failures[0].failureCode, 'model-request-failed');
  assert.match(summary.scope, /ask也包含model，不能相加/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'out/.vh-performance.jsonl'), 'utf8'), /sensitive-key|private\.invalid|private-user-prompt/);
});

test('计时回调异常不会重放已成功请求；取消也留下失败记录', async () => {
  const candidates = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture' }];
  let calls = 0;
  const pool = createProviderPool({ candidates, request: async () => { calls++; return {}; }, onTiming: () => { throw new Error('log failed'); } });
  await pool.chat([], []);
  assert.equal(calls, 1);
  const timings = [], controller = new AbortController();
  const cancelled = createProviderPool({ candidates, request: async () => { controller.abort(); return {}; }, onTiming: event => timings.push(event) });
  await assert.rejects(cancelled.chat([], [], controller.signal));
  assert.deepEqual(timings.map(t => t.ok), [false]);
});
