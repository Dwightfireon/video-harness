/* 找选题的中途收手、中断与成果挽救。
 *
 * 这些行为来自 11-10 的三次真实运行：成功两轮 221–257 秒，
 * 失败那轮 955 秒，其中 421 秒耗在 14 次读取失败上；
 * 超时后本地杀进程，但会话仍跑了 9 分钟并产出完整答案，结果整批丢弃。
 * 测试只模拟事件流，不联网、不调用真实模型。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverTopics, researchPrompt, DISCOVERY_CAPS } from '../lib/discovery.mjs';
import { writeSchedule, readSchedule } from '../lib/schedule.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-discovery-watchdog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSchedule(dir, { items: [], runs: [], discoveryTopics: [{ id: 'investigate', topic: '原始问题', coreQuestion: '原始问题不被调查自动改写',
    status: 'candidate', why: '通过具体过程解释性能差别和适用范围', outline: '先观察具体任务过程，再讨论条件差异和限制。',
    question: { version: 1, audience: '普通用户', value: '理解任务差别', investigate: ['调查过程', '比较条件'], premises: [] } }] });
  return dir;
}
const investigate = (dir, options) => discoverTopics(dir, { ...options, operation: 'research', topicId: 'investigate' });

const search = query => ({ type: 'tool_use', part: { tool: 'websearch', state: { status: 'completed', input: { query }, output: '结果 ' + query } } });
const fetched = (url, body) => ({ type: 'tool_use', part: { tool: 'webfetch', state: { status: 'completed', input: { url }, output: body } } });
const failedFetch = url => ({ type: 'tool_use', part: { tool: 'webfetch', state: { status: 'error', input: { url }, error: 'Request timed out' } } });

/* 假 CLI：先按步骤输出事件，然后按模式挂起或退出。
 * 第二次被调用时（interrupt）把参数写进 fake-interrupt.json，用它证明超时后确实通知了服务。 */
function fakeCli(dir, t, steps, { hangMs = 0, exitAfterHang = false } = {}) {
  const bin = path.join(dir, 'fake-opencode');
  fs.writeFileSync(path.join(dir, 'fake-steps.json'), JSON.stringify({ steps, hangMs, exitAfterHang }));
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (argv[0] === 'api') {
  fs.writeFileSync(path.join(process.cwd(), 'fake-interrupt.json'), JSON.stringify(argv));
  console.log(JSON.stringify({ interrupted: true }));
  process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), 'fake-argv.json'), JSON.stringify(argv));
const spec = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fake-steps.json'), 'utf8'));
console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture_watchdog', part: {} }));
let i = 0;
function next() {
  if (i >= spec.steps.length) {
    if (!spec.hangMs) { console.log(JSON.stringify({ type: 'step_finish', part: {} })); return; }
    setTimeout(() => { if (spec.exitAfterHang) process.exit(3); }, spec.hangMs);
    return;
  }
  const step = spec.steps[i++];
  if (step.delayMs) setTimeout(() => { if (step.event) console.log(JSON.stringify(step.event)); next(); }, step.delayMs);
  else { if (step.event) console.log(JSON.stringify(step.event)); setTimeout(next, 5); }
}
next();
`, { mode: 0o755 });
  const previous = process.env.VH_OPENCODE_BIN;
  process.env.VH_OPENCODE_BIN = bin;
  t.after(() => { if (previous === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = previous; });
  return {
    argv: () => JSON.parse(fs.readFileSync(path.join(dir, 'fake-argv.json'), 'utf8')),
    /* 兼容文件尚未出现时的读取；主流程现已等待有界中断请求收尾。 */
    interrupted: async (timeout = 3000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake-interrupt.json'), 'utf8')); } catch { await sleep(10); }
      }
      return null;
    },
  };
}

const quote = '这是一份仅供自动测试使用的原文材料，完整描述了具体任务、实际处理过程、观察到的结果，以及证据适用的条件和限制，不代表任何真实新闻。';
const candidate = (topic, url) => ({ topic, subject: '测试对象', coreQuestion: topic + '的机制',
  why: '解释具体过程与适用范围，避免只复述一句结论', outline: '先展示一次具体过程，再对照材料说明限制。',
  difference: '与历史题目讲述内容不同。', angle: '机制', kind: 'evergreen',
  selectionReason: '材料公开了过程与限制，能解释具体问题而不是重复结论。',
  limitations: '', sources: [url],
  evidence: [{ url, title: '测试原文', sourceType: 'primary', quote, supports: '这段材料提供讨论过程与适用边界的依据。',
    publishedAt: null, publicationQuote: '', eventDate: null, eventQuote: '' }] });

test('提示词给出检索硬上限与单 URL 只读一次，避免无限扩张', () => {
  const prompt = researchPrompt({ target: { id: 'investigate', topic: '本地模型' }, date: '2026-11-09' });
  assert.match(prompt, new RegExp(`最多 ${DISCOVERY_CAPS.searches} 次 websearch`));
  assert.match(prompt, new RegExp(`最多 ${DISCOVERY_CAPS.fetches} 次 webfetch`));
  assert.match(prompt, /同一地址只读一次/);
  assert.match(prompt, new RegExp(`timeout 固定用 ${DISCOVERY_CAPS.fetchTimeoutSeconds} 秒`));
  assert.match(prompt, /用满一半预算还没拿到可用材料时，直接按已有材料收尾/);
  /* 下限仍然保留：不能因为加预算就把"至少两个查询"删掉。 */
  assert.match(prompt, /至少完成两个不同查询/);
});

test('长时间读不到新原文时提前收手，并通知执行器中断，不留孤儿会话', { timeout: 20000 }, async t => {
  const dir = root(t);
  const url = 'https://source.test/blocked';
  const model = fakeCli(dir, t, [
    { event: search('近期进展') }, { event: search('深度材料') },
    { event: fetched('https://source.test/ok', '# 原文\n' + quote) },
    { event: failedFetch(url), delayMs: 40 }, { event: failedFetch(url + '-other'), delayMs: 40 },
  ], { hangMs: 120000 });
  const started = Date.now();
  const result = await investigate(dir, { query: '本地模型', count: 1, stallMs: 60, timeoutMs: 30000 });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, 'stall');
  assert.match(result.reason, /没读到任何新原文/);
  assert.match(result.reason, /原有内容保留/);
  assert.ok(Date.now() - started < 10000, '不该等满预算才收手');
  /* 关键：本地进程组之外还要通知 opencode 服务中断这个会话。 */
  const interrupt = await model.interrupted();
  assert.ok(interrupt, '必须调用 opencode api post 中断会话');
  assert.deepEqual(interrupt.slice(0, 3), ['api', 'post', '/api/session/ses_fixture_watchdog/interrupt']);
  assert.equal(result.cleanup.localStopped, true);
  assert.equal(result.cleanup.interrupt.confirmed, true);
  /* 失败原因要能看出是站点不可读，不是"没搜到"。 */
  assert.ok(result.searchFailures.some(item => item.tool === 'webfetch' && item.status === null));
  assert.ok(result.hints.length > 0);
});

test('始终读不到原文时按预算比例收手，不再拖到整轮超时', { timeout: 20000 }, async t => {
  const dir = root(t);
  const model = fakeCli(dir, t, [
    { event: search('近期进展') }, { event: search('深度材料') },
    ...[1, 2, 3].map(i => ({ event: failedFetch('https://source.test/' + i), delayMs: 30 })),
  ], { hangMs: 120000 });
  // Leave room for process startup and the 1s heartbeat under parallel suites;
  // the no-page ratio still expires well before this whole wall budget.
  const result = await investigate(dir, { query: '本地模型', noPageBudgetRatio: 0.1, stallMs: 60000, timeoutMs: 4000 });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, 'no-page');
  assert.match(result.reason, /一篇原文都没读到/);
  assert.equal((await model.interrupted())?.[2], '/api/session/ses_fixture_watchdog/interrupt');
});

test('超时前已产出完整 JSON 时按原文校验保存，不整批丢弃已付费的结果', { timeout: 20000 }, async t => {
  const dir = root(t);
  const url = 'https://source.test/report';
  const item = candidate('同一任务在两种条件下为什么表现不同', url);
  const model = fakeCli(dir, t, [
    { event: search('近期进展') }, { event: search('深度材料') },
    { event: fetched(url, '# 原文\n' + quote) },
    { event: { type: 'text', part: { text: JSON.stringify([item]) } } },
  ], { hangMs: 120000 });
  /* 预算极小：答案出来之后才超时，走的正是"晚了但做完了"的挽救路径。 */
  const result = await investigate(dir, { query: '本地模型', count: 1, timeoutMs: 700, stallMs: 600000 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.results.length, 0);
  assert.equal(result.updated.id, 'investigate');
  assert.equal(result.updated.coreQuestion, '原始问题不被调查自动改写');
  assert.equal(readSchedule(dir).discoveryTopics.length, 1);
  assert.equal((await model.interrupted())?.[2], '/api/session/ses_fixture_watchdog/interrupt');
});

test('正常收尾不触发中断，也不把中途旁白当成答案', { timeout: 20000 }, async t => {
  const dir = root(t);
  const url = 'https://source.test/report';
  const item = candidate('正常收尾的题目', url);
  const model = fakeCli(dir, t, [
    { event: search('近期进展') }, { event: search('深度材料') },
    { event: fetched(url, '# 原文\n' + quote) },
    { event: { type: 'text', part: { text: '我会先检索再整理。' } } },
    { event: { type: 'text', part: { text: JSON.stringify([item]) } } },
  ]);
  const result = await investigate(dir, { query: '本地模型', count: 1 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.updated.id, 'investigate', '答案应取可解析的调查结果，而不是最后一句旁白');
  assert.equal(await model.interrupted(200), null, '正常结束不该通知中断');
  assert.ok(!JSON.stringify(model.argv()).includes('--standalone'), '沿用后台服务，才能被 api 中断');
});

test('中断调用失败不能影响结果回写', { timeout: 20000 }, async t => {
  const dir = root(t);
  /* 没有 api 分支的假 CLI 会直接退出非零，模拟 interrupt 打不通。 */
  const bin = path.join(dir, 'fake-broken');
  fs.writeFileSync(bin, `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv[0] === 'api') process.exit(1);
console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture_broken', part: {} }));
for (const event of [
  { type: 'tool_use', part: { tool: 'websearch', state: { status: 'completed', input: { query: 'a' }, output: 'A' } } },
  { type: 'tool_use', part: { tool: 'websearch', state: { status: 'completed', input: { query: 'b' }, output: 'B' } } },
  { type: 'tool_use', part: { tool: 'webfetch', state: { status: 'error', input: { url: 'https://source.test/x' }, error: 'Request timed out' } } },
  { type: 'tool_use', part: { tool: 'webfetch', state: { status: 'error', input: { url: 'https://source.test/y' }, error: 'Request timed out' } } },
]) console.log(JSON.stringify(event));
setTimeout(() => {}, 120000);
`, { mode: 0o755 });
  const previous = process.env.VH_OPENCODE_BIN;
  process.env.VH_OPENCODE_BIN = bin;
  t.after(() => { if (previous === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = previous; });
  const result = await investigate(dir, { query: '本地模型', stallMs: 50, timeoutMs: 30000 });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, 'stall');
  assert.equal(result.cleanup.interrupt.confirmed, false);
  assert.match(result.reason, /服务端会话中断未确认/);
  await sleep(50);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-topic-search.lock')), false, '锁必须释放，否则下一次永远"正在启动"');
});
