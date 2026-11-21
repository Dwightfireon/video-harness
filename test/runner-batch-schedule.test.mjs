import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildQueue, normalizeInterval, runBatch, summarize, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS } from '../desk/batch.mjs';
import { addTopic, readSchedule, attachProject, firstUnstarted, slugify } from '../lib/schedule.mjs';
import { composeTask, TASK_MODES } from '../lib/task-prompts.mjs';
import { runnerConfig, RUNNERS } from '../lib/runners/index.mjs';
import { discoveryFixtureEvents } from './helpers/discovery-fixture.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-batch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('批量发布：按给定顺序执行，条目之间按间隔等待，复用同一套单条结果', async () => {
  const calls = [];
  const result = await runBatch({
    ids: ['a', 'b', 'c'], intervalMs: 2000,
    submitOne: async id => { calls.push('submit:' + id); return { ok: true, bvid: 'BV' + id }; },
    sleep: async ms => { calls.push('sleep:' + ms); },
  });
  assert.deepEqual(calls, ['submit:a', 'sleep:2000', 'submit:b', 'sleep:2000', 'submit:c']);
  assert.equal(result.ok, true);
  assert.equal(result.submitted.length, 3);
  assert.deepEqual(result.submitted.map(item => item.bvid), ['BVa', 'BVb', 'BVc']);
});

test('批量发布：一条失败就停止，后面的不再提交，也不自动重试', async () => {
  const calls = [];
  const result = await runBatch({
    ids: ['a', 'b', 'c'], intervalMs: 2000,
    submitOne: async id => {
      calls.push(id);
      return id === 'b' ? { ok: false, outcome: 'not-submitted', message: '分区不可用' } : { ok: true, bvid: 'BV' + id };
    },
    sleep: async () => {},
  });
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(result.ok, false);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'b');
  assert.equal(result.results.length, 2);
});

test('批量发布：抛错的单条按未知结果记录，且仍然停止', async () => {
  const result = await runBatch({ ids: ['a'], submitOne: async () => { throw new Error('网络中断'); }, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].outcome, 'unknown');
  assert.match(result.results[0].message, /网络中断/);
});

test('批量发布：间隔被夹在安全范围内，重复 id 只发一次', async () => {
  assert.equal(normalizeInterval(0), DEFAULT_INTERVAL_MS);
  assert.equal(normalizeInterval(0.1), MIN_INTERVAL_MS);
  assert.equal(normalizeInterval(9999), MAX_INTERVAL_MS);
  assert.equal(normalizeInterval(3), 3000);
  assert.deepEqual(buildQueue(['a', 'a', 'b']), ['a', 'b']);
  assert.throws(() => buildQueue([]), /空的/);
  assert.throws(() => buildQueue([undefined]), /不能为空/);
});

test('批量发布：用户中止后不再派下一条', async () => {
  let stop = false;
  const calls = [];
  const result = await runBatch({
    ids: ['a', 'b'], submitOne: async id => { calls.push(id); return { ok: true, bvid: 'BV' + id }; },
    sleep: async () => { stop = true; }, shouldCancel: () => stop,
  });
  // 第一条已经提交成功，中止发生在它之后的等待里：第二条不应被派发。
  assert.deepEqual(calls, ['a']);
  assert.equal(result.results.length, 1);
});

test('批量发布：汇总区分已提交与失败，不把部分成功说成全部成功', async () => {
  const summary = summarize([{ ok: true, id: 'a', bvid: 'BVa' }, { ok: false, id: 'b', outcome: 'not-submitted', message: 'x' }]);
  assert.equal(summary.ok, false);
  assert.equal(summary.submitted.length, 1);
  assert.equal(summary.failed.length, 1);
});

/* 队列只记「想做哪些」，执行状态从项目推导。
 * 这里只测队列该管的部分；项目状态怎么算由 schedule.test.mjs 覆盖。 */
test('选题队列：加选题与去重', t => {
  const root = tmp(t);
  addTopic(root, '本地大模型为什么突然好用了');
  assert.throws(() => addTopic(root, '本地大模型为什么突然好用了'), /已有同一个选题/);
  addTopic(root, '第二条选题');
  const queue = readSchedule(root);
  assert.equal(queue.items.length, 2);
  assert.equal(firstUnstarted(queue).topic, '本地大模型为什么突然好用了');
});

test('选题队列：已开工的项不再自动重派', t => {
  const root = tmp(t);
  const first = addTopic(root, '一');
  addTopic(root, '二');
  attachProject(root, first.id, 'projects/一');
  const queue = readSchedule(root);
  assert.equal(firstUnstarted(queue).topic, '二');
  assert.equal(queue.items[0].project, 'projects/一');
});

test('选题队列：项目名可读', t => {
  assert.equal(slugify('本地大模型为什么突然好用了'), '本地大模型为什么突然好用了');
  assert.equal(slugify('   '), 'auto');
});

test('派发指令：用户原话单独成段，不被规则吞掉；各模式都有模板', () => {
  const task = composeTask({ project: '/repo/projects/p', repo: '/repo', mode: 'topic', message: '选题一句话', policyNote: '【策略】' });
  assert.match(task, /选题一句话/);
  assert.equal(task.split('用户的指令是：\n')[1], '选题一句话');
  assert.match(task, /node vh\.mjs <命令> --dir \/repo\/projects\/p/);
  for (const mode of TASK_MODES) assert.ok(composeTask({ project: 'p', repo: 'r', mode, message: 'm' }).length > 20);
});

test('执行器选择：项目配置优先，未知值明确拒绝而非静默换执行器', t => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'PROJECT.json'), JSON.stringify({ runner: { name: 'opencode', agent: 'vh-builder' } }));
  const config = runnerConfig(root, {});
  assert.equal(config.name, 'opencode');
  assert.equal(config.agent, 'vh-builder');
  fs.writeFileSync(path.join(root, 'PROJECT.json'), JSON.stringify({ runner: 'nonsense' }));
  assert.throws(() => runnerConfig(root, {}), /未回落/);
  assert.ok(RUNNERS.opencode && RUNNERS.local);
});

test('事件流解析：工具与文本翻成日志，错误归类对齐既有词表', async () => {
  const { describeEvent, classifyEventError, stageFromCommand } = await import('../lib/runners/opencode.mjs');
  assert.equal(describeEvent({ type: 'text', part: { text: '写作完成' } }), '写作完成');
  assert.match(describeEvent({ type: 'tool_use', tool: 'shell', part: { state: { status: 'error', output: '拒绝' } } }), /被拒绝/);
  assert.match(describeEvent({ type: 'tool_use', tool: 'websearch', part: { state: { status: 'completed', output: '结果' } } }), /websearch 完成/);
  assert.equal(describeEvent({ type: 'step_finish' }), null);
  assert.equal(classifyEventError({ error: { status: 402 } }), 'quota');
  assert.equal(classifyEventError({ error: { status: 401 } }), 'auth');
  assert.equal(classifyEventError({ error: { status: 429 } }), 'rate');
  assert.equal(stageFromCommand('node vh.mjs render --dir .'), 'render');
  assert.equal(stageFromCommand('node vh.mjs go --srt'), 'render');
  assert.equal(stageFromCommand('ls -la'), null);
});

test('选题发现：JSON解析兼容代码块，新问题不要求来源，旧式过滤仍兼容', async () => {
  const { discoveryPrompt, parseCandidates, filterCandidates } = await import('../lib/discovery.mjs');
  const prompt = discoveryPrompt({ query: '本地大模型', count: 2, exclude: ['旧选题'] });
  assert.match(prompt, /只输出 JSON 数组本身/);
  assert.match(prompt, /旧选题/);
  const parsed = parseCandidates('```json\n[{"topic":"甲","sources":["https://a"]},{"topic":"乙"}]\n```');
  assert.equal(parsed.length, 2);
  assert.equal(parseCandidates('我不知道'), null);
  assert.deepEqual(parseCandidates('[]'), []);
  const picked = filterCandidates(parsed, { items: [] });
  assert.deepEqual(picked.map(item => item.topic), ['甲']);
  assert.deepEqual(filterCandidates(parsed, { items: [{ topic: '甲' }] }), []);
  const newQuestion = { topic: '怎样检查离线翻译的专名？', question: { version: 1, audience: '离线翻译用户', value: '知道怎样检查专名', investigate: ['调查专名处理过程', '比较字典和上下文'], premises: [] } };
  assert.deepEqual(filterCandidates([newQuestion], { items: [] }).map(item => item.topic), [newQuestion.topic]);
  assert.deepEqual(filterCandidates([{ topic: '旧式无来源' }], { items: [] }), []);
});

test('选题发现：模型没给数组时整批作废，不入队', async t => {
  const { discoverTopics } = await import('../lib/discovery.mjs');
  const root = tmp(t);
  // 假 opencode：只回一句普通文本，不是 JSON 数组。
  const fake = path.join(root, 'fake-opencode');
  const events = [...discoveryFixtureEvents([]).slice(0, -1), { type: 'text', part: { text: '我觉得可以聊聊 AI' } }];
  fs.writeFileSync(fake, `#!${process.execPath}\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`, { mode: 0o755 });
  const previous = process.env.VH_OPENCODE_BIN;
  process.env.VH_OPENCODE_BIN = fake;
  t.after(() => { if (previous === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = previous; });
  const result = await discoverTopics(root, { query: 'AI', count: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /JSON 数组/);
  const { readSchedule } = await import('../lib/schedule.mjs');
  assert.equal(readSchedule(root).items.length, 0);
});

test('选题发现：无工具记录也保存结构完整的问题，旧式输出不伪装新问题', async t => {
  const { discoverTopics } = await import('../lib/discovery.mjs');
  const { readSchedule } = await import('../lib/schedule.mjs');
  const root = tmp(t);
  const fake = path.join(root, 'fake-opencode');
  const events = [{ type: 'text', part: { text: JSON.stringify([
    { topic: '甲选题', subject: '离线翻译', coreQuestion: '离线翻译怎样处理专名', why: '帮助用户检查专名处理结果',
      question: { version: 1, audience: '离线翻译用户', value: '知道怎样检查专名', investigate: ['调查专名处理过程', '比较字典和上下文'], premises: [] } },
    { topic: '只有旧式字段', sources: ['https://a.test'] },
  ]) } }];
  fs.writeFileSync(fake, `#!${process.execPath}\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`, { mode: 0o755 });
  const previous = process.env.VH_OPENCODE_BIN;
  process.env.VH_OPENCODE_BIN = fake;
  t.after(() => { if (previous === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = previous; });
  const result = await discoverTopics(root, { query: 'AI', count: 3 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.results.map(item => item.topic), ['甲选题']);
  const queue = readSchedule(root);
  assert.equal(queue.items.length, 0);
  assert.equal(queue.discoveryTopics.length, 1);
  assert.equal(queue.discoveryTopics[0].question.version, 1);
  assert.equal(queue.discoveryTopics[0].researchAssessment.status, 'unresearched');
  assert.equal(queue.discoveryTopics[0].research, undefined);
  assert.equal(queue.discovery.length, 1);
  assert.equal(queue.discovery[0].candidates, 2);
});
