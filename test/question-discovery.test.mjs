/* Question-first backend contract, through the real subprocess runner. No paid APIs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverTopics, discoveryPrompt, researchPrompt, DISCOVERY_CAPS } from '../lib/discovery.mjs';
import { discoveryPrompt as pureDiscoveryPrompt, researchPrompt as pureResearchPrompt, DISCOVERY_CAPS as pureCaps } from '../lib/discovery-prompts.mjs';
import { readSchedule, writeSchedule, topicDetails, topicBrief } from '../lib/schedule.mjs';
import { topicState, updateTopicState } from '../lib/topic-memory.mjs';
import { prepareDiscoveryRequest } from '../lib/discovery-request.mjs';
import { startJob, describeJob } from '../lib/discovery-job.mjs';
import { normalizeQuestion, normalizeTopicResearch } from '../lib/topic-contract.mjs';
import { normalizeTopicResearch as compatibleResearch } from '../lib/discovery-evidence.mjs';
import { discoveryFixtureEvents } from './helpers/discovery-fixture.mjs';

const question = (topic = '离线翻译怎样在长文中保持术语一致？', extra = {}) => ({ topic, subject: '长文离线翻译', coreQuestion: topic,
  why: '帮助翻译长文的用户理解术语处理的过程和取舍', outline: '从前后出现的同一术语讲起，比较不同上下文的处理过程。',
  question: { version: 1, audience: '翻译长文的普通用户', value: '知道何时需要术语表以及怎样检查结果',
    investigate: ['查看前后术语如何传递', '比较不同上下文与术语表的限制'], premises: ['不同上下文可能影响同一术语的译法，尚待核对'] }, ...extra });
const assessment = (status, extra = {}) => ({ version: 1, status, finding: '实际材料与原问题的关系和适用范围仍需具体分析', gaps: ['缺少长期案例'], suggestedQuestion: '', ...extra });
const text = value => ({ type: 'text', part: { text: JSON.stringify(value) } });
const seed = (root, records = [question(undefined, { id: 'q', status: 'candidate', at: 1, query: '离线翻译' })], extra = {}) =>
  writeSchedule(root, { ...readSchedule(root), discoveryTopics: records, ...extra });
const researchEvents = (patch = {}) => discoveryFixtureEvents([{ ...question(), sources: ['https://source.test/translation'],
  researchAssessment: assessment('leads'), ...patch }]);

test('pure prompt boundary retains named exports; focused research has no material-ranking or compulsory news query', () => {
  assert.equal(discoveryPrompt, pureDiscoveryPrompt);
  assert.equal(researchPrompt, pureResearchPrompt);
  assert.equal(DISCOVERY_CAPS, pureCaps);
  const target = question(undefined, { id: 'q', query: '2026-10-01 至 2026-10-31 的离线翻译',
    researchAssessment: assessment('insufficient', { finding: '已有一个受限案例', gaps: ['缺少相反条件下的对照'], suggestedQuestion: '哪些条件下术语表才有帮助？' }) });
  const before = JSON.stringify(target);
  const prompt = researchPrompt({ target, query: '无关的替代方向', date: '2026-11-13' });
  assert.equal(JSON.stringify(target), before);
  assert.doesNotMatch(prompt, /按材料选择|先比较材料|排序推荐|综合排序|兼顾最新|近期新进展|最近一周|扩至一个月|最多\s*\d+\s*个候选|旧题去重/);
  assert.match(prompt, /本轮唯一任务是调查现有问题/);
  assert.ok(prompt.includes(target.coreQuestion));
  for (const value of [...target.question.premises, ...target.question.investigate, target.query,
    target.researchAssessment.finding, ...target.researchAssessment.gaps, target.researchAssessment.suggestedQuestion]) assert.ok(prompt.includes(value), value);
  assert.doesNotMatch(prompt, /无关的替代方向/);
  assert.match(prompt, /至少完成两个不同查询/);
  assert.match(prompt, /一个检查待核前提/); assert.match(prompt, /另一个.*机制.*相反证据/);
  assert.match(prompt, /没有明确时限就不设置默认日期窗口/);
  assert.match(prompt, /长期问题可以使用旧研究或 evergreen/);
  assert.match(prompt, /不追求穷尽网络或做全站核查/);
  for (const field of ['kind', 'sources', 'evidence', 'quote', 'supports', 'publishedAt', 'publicationQuote', 'eventDate', 'eventQuote', 'researchAssessment']) assert.ok(prompt.includes(`"${field}"`), field);
  assert.match(prompt, /至少40字\/字符/);
  assert.match(prompt, /insufficient\/reframe 可只返回 researchAssessment/);
  assert.match(prompt, /完成检索和原文匹配都不等于事实已获核证/);
  assert.match(prompt, new RegExp(`最多 ${DISCOVERY_CAPS.searches} 次 websearch`));
  assert.match(prompt, new RegExp(`最多 ${DISCOVERY_CAPS.fetches} 次 webfetch`));
  assert.match(prompt, /合计不超过 12 次/);
  assert.match(prompt, new RegExp(`timeout 固定用 ${DISCOVERY_CAPS.fetchTimeoutSeconds} 秒`));
  const source = fs.readFileSync(new URL('../lib/discovery-prompts.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import\s|node:|spawn\(|readSchedule|writeSchedule|readFileSync|fetch\(/);
  const runner = fs.readFileSync(new URL('../lib/discovery.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runner, /materialPrompt|按材料选择|排序推荐|近期检索通常先看/);
});

function fixture(t, spec = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-questions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fake-opencode');
  const set = patch => fs.writeFileSync(path.join(root, 'response.json'), JSON.stringify({ questions: [text([question()])], research: researchEvents(), ...patch }));
  set(spec);
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'api') { fs.appendFileSync('interrupts', 'interrupt\\n'); console.log(JSON.stringify({interrupted:true})); process.exit(0); }
const prompt = process.argv.at(-1), operation = prompt.includes('本轮唯一任务是调查现有问题') ? 'research' : 'questions';
const spec = JSON.parse(fs.readFileSync('response.json', 'utf8'));
const selected = process.argv[process.argv.indexOf('--agent') + 1];
const modelIdx = process.argv.indexOf('-m');
const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : null;
const config = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {};
fs.appendFileSync('calls.jsonl', JSON.stringify({ operation, at: Date.now(), selected, model, agent: config.agents?.[selected],
  standalone: process.argv.includes('--standalone'), existingAgentPreserved: !!config.agents?.existing, fixtureProviderPreserved: !!config.providers?.fixture, prompt }) + '\\n');
console.log(JSON.stringify({ type:'step_start', sessionID:'ses_question_fixture' }));
setTimeout(() => {
  for (const [index, event] of spec[operation].entries()) {
    const line = JSON.stringify(event);
    if (spec.noFinalNewline && index === spec[operation].length - 1) process.stdout.write(line);
    else console.log(line);
  }
  if (spec.exitCode) process.exitCode = spec.exitCode;
  if (spec.hangAfter === operation) setTimeout(() => {}, 120000);
}, spec[operation + 'DelayMs'] || 0);
`, { mode: 0o755 });
  const old = process.env.VH_OPENCODE_BIN;
  process.env.VH_OPENCODE_BIN = bin;
  t.after(() => { if (old === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = old; });
  const calls = () => { try { return fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  return { root, set, calls };
}

test('default questions persist without any web tools/evidence and reject enqueue bypass', async t => {
  const { root, calls } = fixture(t);
  seed(root, [], { discoveryConfig: { enabled: true, autoQueue: true } });
  const result = await discoverTopics(root, { query: '离线翻译', autoQueue: true });
  assert.equal(result.ok, true); assert.equal(result.results.length, 1);
  const saved = readSchedule(root).discoveryTopics[0];
  assert.deepEqual(saved.question, question().question);
  assert.equal(saved.researchAssessment.status, 'unresearched');
  assert.deepEqual(saved.sources, []); assert.equal(saved.research, undefined);
  assert.deepEqual(result.added, []); assert.equal(readSchedule(root).items.length, 0);
  assert.equal(topicState(root).candidates[0].canEnqueue, false);
  assert.throws(() => updateTopicState(root, { action: 'accept', id: saved.id }), { statusCode: 409 });
  assert.equal(saved.feedback, undefined);
  assert.deepEqual(calls().map(call => call.operation), ['questions']);
  assert.equal(fs.existsSync(path.join(root, 'out/topic-research')), false);
  assert.deepEqual(calls()[0].agent.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
  assert.match(calls()[0].selected, /^vh-questions-/);
  assert.equal(calls()[0].standalone, true, '临时agent必须由继承该环境的私有服务加载');
  assert.match(describeJob({ state: 'running', operation: 'questions', startedAt: Date.now() }).text, /构思/);
});

test('recent mode enables capped websearch-only ideation while still requiring explicit research before enqueue', async t => {
  const websearch = i => ({ type: 'tool_use', part: { tool: 'websearch', state: { status: 'completed', input: { query: 'ChatGPT recent ' + i }, output: 'summary ' + i } } });
  const { root, set, calls } = fixture(t, { questions: [websearch(1), websearch(2), text([question('ChatGPT 这周更新了什么实用功能？')])] });
  const result = await discoverTopics(root, { query: 'ChatGPT', mode: 'recent' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].mode, 'recent');
  assert.equal(result.results[0].researchAssessment.status, 'unresearched');
  assert.deepEqual(result.results[0].sources, []);
  assert.equal(topicState(root).candidates[0].canEnqueue, false);
  assert.deepEqual(calls()[0].agent.permissions, [
    { action: 'websearch', resource: '*', effect: 'allow' },
    { action: '*', resource: '*', effect: 'deny' },
  ]);
  assert.match(calls()[0].selected, /^vh-recent-/);
  assert.match(describeJob({ state: 'running', operation: 'questions', mode: 'recent', startedAt: Date.now() }).text, /轻联网/);

  set({ questions: [websearch(1), websearch(2), websearch(3), websearch(4), text([question('超限问题')])] });
  const capped = await discoverTopics(root, { query: 'ChatGPT', mode: 'recent' });
  assert.equal(capped.ok, false);
  assert.equal(capped.aborted, 'budget');
  assert.match(capped.reason, /轻搜次数超过上限/);

  set({ questions: [{ type: 'tool_use', part: { tool: 'webfetch', state: { status: 'completed', input: { url: 'https://source.test/a' }, output: 'body' } } }, text([question('违禁抓全文')])] });
  const fetched = await discoverTopics(root, { query: 'ChatGPT', mode: 'recent' });
  assert.equal(fetched.ok, false);
  assert.equal(fetched.aborted, 'budget');
  assert.match(fetched.reason, /不允许读取原文/);

  set({ questions: [text([])] });
  const noSearch = await discoverTopics(root, { query: 'AI最近发展情况', mode: 'recent' });
  assert.equal(noSearch.ok, false);
  assert.match(noSearch.reason, /轻联网未能取得有效搜索结果/);

  set({ questions: [{ type: 'tool_use', part: { tool: 'websearch', state: { status: 'error', input: { query: 'AI 2026' }, error: 'HTTP 402' } } }, text([])] });
  const failedSearch = await discoverTopics(root, { query: 'AI最近发展情况', mode: 'recent' });
  assert.equal(failedSearch.ok, false);
  assert.match(failedSearch.reason, /402/);
});

test('真实CLI形状：退出1且stderr为空，仍显示stdout JSON中的具体错误，包括末尾无换行', async t => {
  for (const noFinalNewline of [false, true]) {
    const { root } = fixture(t, { questions: [{ type: 'error', error: { type: 'unknown', message: 'Agent not found: "vh-questions-regression"' } }], exitCode: 1, noFinalNewline });
    const result = await discoverTopics(root, { model: 'fixture/model' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Agent not found: "vh-questions-regression"/);
    assert.notEqual(result.reason, 'opencode 退出 1');
    assert.equal(readSchedule(root).discoveryTopics?.length || 0, 0);
  }
});

test('执行器错误脱敏后才截断，不把环境密钥、Bearer或URL凭证写进失败记录', async t => {
  const old = process.env.VH_FIXTURE_API_KEY;
  t.after(() => { if (old === undefined) delete process.env.VH_FIXTURE_API_KEY; else process.env.VH_FIXTURE_API_KEY = old; });
  process.env.VH_FIXTURE_API_KEY = 'fixture-private-discovery-key';
  const { root } = fixture(t, { questions: [{ type: 'error', error: { message: 'Authentication failed fixture-private-discovery-key Bearer authorization-private at https://user:password@fixture.invalid/private-key?token=private-query' } }], exitCode: 1 });
  const result = await discoverTopics(root, { model: 'fixture/model' });
  assert.equal(result.ok, false); assert.match(result.reason, /Authentication failed/);
  for (const secret of ['fixture-private-discovery-key', 'authorization-private', 'user:password', 'private-key', 'private-query']) assert.equal(result.reason.includes(secret), false, secret);
});

test('generation strips model evidence/status and requires actual question metadata, not legacy fallback', async t => {
  const q = question(undefined, { sources: ['https://source.test/fake'], researchAssessment: assessment('leads'), research: { version: 1, verified: true } });
  const { root } = fixture(t, { questions: [text([q, { ...question('另一个完整问题'), question: undefined },
    { ...question('缺步骤的问题'), question: { ...q.question, investigate: ['单一步'] } }])] });
  const result = await discoverTopics(root);
  assert.equal(result.ok, true); assert.equal(result.results.length, 1); assert.equal(result.materialRejected, 2);
  assert.equal(result.results[0].researchAssessment.status, 'unresearched');
  assert.equal(result.results[0].research, undefined); assert.deepEqual(result.results[0].sources, []);
  assert.equal(normalizeQuestion({ ...q.question, investigate: ['1', '2', '3', '4'] }), null);
});

test('tool narrowing is child-local, preserves runtime provider/agent settings and never rewrites authorization files', async t => {
  const old = process.env.OPENCODE_CONFIG_CONTENT;
  t.after(() => { if (old === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = old; });
  const runtime = JSON.stringify({ providers: { fixture: { models: { test: {} } } },
    agents: { existing: { permissions: [{ action: 'websearch', resource: '*', effect: 'allow' }] } } });
  process.env.OPENCODE_CONFIG_CONTENT = runtime;
  const { root, calls } = fixture(t);
  const config = '{"agents":{"existing":{"mode":"primary"}}}\n';
  fs.writeFileSync(path.join(root, 'opencode.json'), config);
  const result = await discoverTopics(root, { model: 'fixture/test', agent: 'existing' });
  assert.equal(result.ok, true);
  assert.equal(calls()[0].existingAgentPreserved, true);
  assert.equal(calls()[0].fixtureProviderPreserved, true);
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, runtime);
  assert.equal(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'), config);
});

test('explicit research updates same id/question, validates actual material, and never autoqueues manual request', async t => {
  const { root, calls } = fixture(t);
  seed(root, undefined, { discoveryConfig: { enabled: true, autoQueue: true } });
  const original = readSchedule(root).discoveryTopics[0];
  const result = await discoverTopics(root, { operation: 'research', topicId: 'q', origin: 'manual', autoQueue: true });
  assert.equal(result.ok, true, result.reason); assert.deepEqual(result.results, []); assert.equal(result.updated.id, 'q');
  assert.equal(result.updated.coreQuestion, original.coreQuestion); assert.equal(result.updated.topic, original.topic);
  assert.deepEqual(result.updated.question, original.question);
  assert.equal(result.updated.canEnqueue, true); assert.equal(result.updated.researchAssessment.status, 'leads');
  assert.equal(readSchedule(root).discoveryTopics.length, 1); assert.equal(readSchedule(root).items.length, 0);
  assert.deepEqual(calls().map(call => call.operation), ['research']);
  assert.match(describeJob({ state: 'running', operation: 'research', startedAt: Date.now() }).text, /调查/);
  const accepted = updateTopicState(root, { action: 'accept', id: 'q' });
  assert.equal(accepted.item.question.version, 1); assert.equal(accepted.item.researchAssessment.status, 'leads');
  assert.deepEqual(accepted.item.research, result.updated.research);
  assert.match(topicBrief(accepted.item), /不等于独立事实核证/);
  const brief = topicBrief(accepted.item);
  for (const value of [original.question.audience, original.question.value, ...original.question.investigate,
    ...original.question.premises, result.updated.researchAssessment.finding, ...result.updated.researchAssessment.gaps]) assert.ok(brief.includes(value), value);
});

test('focused evergreen investigation accepts old readable research; only an explicit time constraint excludes it', async t => {
  const events = researchEvents({ kind: 'evergreen' });
  events[0].part.state.input.query = '离线翻译术语一致性前提及范围';
  events[1].part.state.input.query = '离线翻译上下文机制与反例';
  for (const event of events) {
    if (event.part?.tool === 'webfetch') event.part.state.output = event.part.state.output.replace(/Published: \d{4}-\d{2}-\d{2}/g, 'Published: 2014-01-02');
  }
  const material = JSON.parse(events.at(-1).part.text);
  material[0].evidence[0].publishedAt = '2014-01-02';
  material[0].evidence[0].publicationQuote = 'Published: 2014-01-02';
  events.at(-1).part.text = JSON.stringify(material);
  const { root, calls } = fixture(t, { research: events });
  seed(root);
  const result = await discoverTopics(root, { operation: 'research', topicId: 'q' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.updated.canEnqueue, true);
  assert.equal(result.updated.research.kind, 'evergreen');
  assert.equal(result.updated.research.sources[0].publishedAt, '2014-01-02');
  assert.equal(result.updated.coreQuestion, question().coreQuestion);
  assert.doesNotMatch(calls()[0].prompt, /排序推荐|近期新进展|最近一周/);
  const archive = JSON.parse(fs.readFileSync(path.join(root, result.recordPath), 'utf8'));
  assert.equal(archive.window, null); assert.equal(archive.searches.length, 2);
  assert.match(archive.pages[0].body, /2014-01-02/);

  seed(root, [question(undefined, { id: 'constrained', status: 'candidate', query: '2026-10-01 至 2026-10-31 的离线翻译' })]);
  const constrained = await discoverTopics(root, { operation: 'research', topicId: 'constrained' });
  assert.equal(constrained.ok, false); assert.match(constrained.reason, /明确要求的时间范围/);
  assert.match(calls().at(-1).prompt, /2026-10-01 至 2026-10-31/);
  assert.equal(readSchedule(root).discoveryTopics[0].research, undefined);
});

test('semantic insufficient/reframe persist without fake sources or mutation and retain previous successful material', async t => {
  const { root, set } = fixture(t);
  seed(root);
  const good = await discoverTopics(root, { operation: 'research', topicId: 'q' });
  for (const status of ['insufficient', 'reframe']) {
    const proposed = assessment(status, { suggestedQuestion: '哪些条件下术语表才有帮助？' });
    set({ research: [text({ researchAssessment: proposed })] });
    const result = await discoverTopics(root, { operation: 'research', topicId: 'q' });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.updated.researchAssessment, proposed);
    assert.equal(result.updated.canEnqueue, false);
    assert.equal(result.updated.coreQuestion, question().coreQuestion);
    assert.deepEqual(result.updated.research, good.updated.research);
    assert.deepEqual(result.updated.sources, good.updated.sources);
    assert.throws(() => updateTopicState(root, { action: 'accept', id: 'q' }), { statusCode: 409 });
  }
  seed(root, [question('全新尚无线索问题', { id: 'new', status: 'candidate' })]);
  const result = await discoverTopics(root, { operation: 'research', topicId: 'new' });
  assert.equal(result.ok, true); assert.equal(result.updated.research, undefined); assert.equal(result.updated.sources, undefined);
});

test('failed tool execution preserves prior assessment/material/history and does not automatically retry', async t => {
  const { root, set, calls } = fixture(t);
  seed(root);
  assert.equal((await discoverTopics(root, { operation: 'research', topicId: 'q' })).ok, true);
  const before = readSchedule(root);
  const error = { type: 'tool_use', part: { tool: 'websearch', state: { status: 'error', input: { query: 'a' }, error: 'HTTP 402' } } };
  set({ research: [error, text({ researchAssessment: assessment('insufficient') })] });
  const result = await discoverTopics(root, { operation: 'research', topicId: 'q' });
  assert.equal(result.ok, false); assert.match(result.reason, /402/);
  assert.deepEqual(readSchedule(root).discoveryTopics, before.discoveryTopics);
  assert.deepEqual(readSchedule(root).discovery, before.discovery);
  assert.equal(topicState(root).candidates[0].canEnqueue, true);
  assert.equal(calls().filter(call => call.operation === 'research').length, 2);
});

test('a leads label or normalized research alone is not eligibility; replay detects tampered archives', async t => {
  const { root, set } = fixture(t);
  seed(root);
  set({ research: [text({ ...question(), kind: 'evergreen', sources: ['https://source.test/translation'], researchAssessment: assessment('leads') })] });
  assert.equal((await discoverTopics(root, { operation: 'research', topicId: 'q' })).ok, false);
  const queue = readSchedule(root);
  queue.discoveryTopics[0].researchAssessment = assessment('leads');
  writeSchedule(root, queue);
  assert.equal(topicState(root).candidates[0].canEnqueue, false);
  assert.throws(() => updateTopicState(root, { action: 'accept', id: 'q' }), { statusCode: 409 });
  set({});
  const good = await discoverTopics(root, { operation: 'research', topicId: 'q' });
  assert.equal(good.updated.canEnqueue, true);
  const changed = readSchedule(root);
  changed.discoveryTopics[0].coreQuestion = '后来被改成另一个问题'; writeSchedule(root, changed);
  assert.equal(topicState(root).candidates[0].canEnqueue, false, 'archive is bound to the original question snapshot, not just id');
  changed.discoveryTopics[0].coreQuestion = question().coreQuestion; writeSchedule(root, changed);
  assert.equal(topicState(root).candidates[0].canEnqueue, true);
  const file = path.join(root, good.recordPath), archive = JSON.parse(fs.readFileSync(file, 'utf8'));
  archive.pages = []; fs.writeFileSync(file, JSON.stringify(archive));
  assert.equal(topicState(root).candidates[0].canEnqueue, false);
  assert.throws(() => updateTopicState(root, { action: 'accept', id: 'q' }), { statusCode: 409 });
});

test('explicit research request/job carries operation/topicId; invalid combinations never dispatch', t => {
  const { root } = fixture(t), history = [question(undefined, { id: 'q' })];
  const prepared = prepareDiscoveryRequest({ operation: 'research', topicId: 'q' }, {}, history);
  assert.equal(prepared.operation, 'research'); assert.equal(prepared.topicId, 'q'); assert.equal(prepared.count, 1);
  for (const input of [{ operation: 'invalid' }, { operation: 'research' }, { operation: 'research', topicId: 'missing' },
    { topicId: 'q' }, { operation: 'research', topicId: 'q', followupId: 'q', followup: 'deeper' }]) {
    assert.throws(() => prepareDiscoveryRequest(input, {}, history), { statusCode: 400 });
  }
  const started = startJob(root, prepared, { spawnImpl: () => ({ pid: process.pid, on() {}, unref() {} }) });
  assert.equal(started.job.operation, 'research'); assert.equal(started.job.topicId, 'q');
  assert.equal(startJob(root, {}).busy, true);
});

test('followup context includes research gaps/proposed question, but merely generating suggestion never adopts it', async t => {
  const prior = question(undefined, { id: 'q', status: 'candidate', researchAssessment: assessment('reframe', { suggestedQuestion: '哪些术语需要人工维护？' }) });
  const { root, calls } = fixture(t, { questions: [text([question('哪些术语需要人工维护？')])] });
  seed(root, [prior]);
  const result = await discoverTopics(root, { followupId: 'q', followup: 'different' });
  assert.equal(result.results[0].status, 'suggestion');
  assert.deepEqual(readSchedule(root).discoveryTopics.find(item => item.id === 'q'), prior);
  assert.match(calls()[0].prompt, /哪些术语需要人工维护/);
  assert.match(calls()[0].prompt, /缺少长期案例/);
  assert.match(calls()[0].prompt, /查看前后术语如何传递/);
});

test('automatic default only generates questions; explicit autoQueue investigates and requires validated leads', async t => {
  for (const [autoQueue, status, queued] of [[false, 'leads', 0], [true, 'leads', 1], [true, 'insufficient', 0], [true, 'reframe', 0]]) {
    const { root, calls } = fixture(t, { research: status === 'leads' ? researchEvents() : [text({ researchAssessment: assessment(status) })] });
    seed(root, [], { discoveryConfig: { enabled: true, autoQueue, timeoutMs: 5000 } });
    const result = await discoverTopics(root, { origin: 'automatic' });
    assert.equal(result.ok, true); assert.equal(result.added.length, queued);
    assert.deepEqual(calls().map(call => call.operation), autoQueue ? ['questions', 'research'] : ['questions']);
    assert.equal(readSchedule(root).discoveryTopics.length, 1);
  }
});

test('whole automatic run shares deadline; timeout does not multiply by candidate count and untouched questions survive', { timeout: 15000 }, async t => {
  const { root, calls } = fixture(t, { questions: [text([question(), question('离线翻译怎样处理断句？', { coreQuestion: '长句怎样分段翻译' })])],
    questionsDelayMs: 100, researchDelayMs: 9000 });
  seed(root, [], { discoveryConfig: { enabled: true, autoQueue: true, timeoutMs: 3000 } });
  const started = Date.now();
  const result = await discoverTopics(root, { origin: 'automatic' });
  assert.equal(result.ok, true); assert.equal(result.results.length, 2); assert.equal(result.added.length, 0);
  assert.deepEqual(calls().map(call => call.operation), ['questions', 'research']);
  assert.ok(Date.now() - started < 5500, 'one shared wall budget plus bounded interrupt/cleanup, not one full timeout per question');
  assert.equal(readSchedule(root).discoveryTopics.filter(item => item.researchAssessment.status === 'unresearched').length, 2);
  assert.equal(fs.existsSync(path.join(root, 'out/.vh-topic-search.lock')), false);
  assert.match(fs.readFileSync(path.join(root, 'interrupts'), 'utf8'), /interrupt/);
});

test('automatic enqueue rechecks latest config/feedback after investigation and merges concurrent queue changes', { timeout: 15000 }, async t => {
  for (const change of ['disable', 'feedback']) {
    const { root, calls } = fixture(t, { researchDelayMs: 300 });
    seed(root, [], { discoveryConfig: { enabled: true, autoQueue: true, timeoutMs: 5000 } });
    const pending = discoverTopics(root, { origin: 'automatic' });
    const deadline = Date.now() + 3000;
    while (!calls().some(call => call.operation === 'research')) {
      assert.ok(Date.now() < deadline, 'investigation must start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const current = readSchedule(root).discoveryTopics[0];
    if (change === 'disable') updateTopicState(root, { action: 'config', config: { autoQueue: false } });
    else updateTopicState(root, { action: 'feedback', id: current.id, kind: 'not-interested', note: '调查期间不想做了' });
    const latest = readSchedule(root);
    latest.items.push({ id: 'concurrent', topic: '用户同时手动添加', custom: { retained: true } });
    writeSchedule(root, latest);
    const result = await pending;
    assert.equal(result.ok, true); assert.deepEqual(result.added, []);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));
    assert.equal(saved.items.length, 1); assert.deepEqual(saved.items[0].custom, { retained: true });
    assert.equal(saved.discoveryTopics[0].researchAssessment.status, 'leads');
    if (change === 'feedback') assert.equal(saved.discoveryTopics[0].feedback.note, '调查期间不想做了');
    else assert.equal(saved.discoveryConfig.autoQueue, false);
  }
});

test('research caps stop repeated URL / excess searches, interrupt the session and preserve the question', { timeout: 15000 }, async t => {
  for (const mode of ['repeat', 'searches']) {
    const events = researchEvents();
    const scripted = mode === 'repeat' ? [...events.slice(0, -1), events.find(event => event.part?.tool === 'webfetch'), events.at(-1)]
      : [...Array.from({ length: 7 }, (_, i) => ({ type: 'tool_use', part: { tool: 'websearch', state: { status: 'completed', input: { query: 'distinct-' + i }, output: 'result' } } })), events.at(-1)];
    const { root } = fixture(t, { research: scripted }); seed(root);
    const before = readSchedule(root).discoveryTopics;
    const result = await discoverTopics(root, { operation: 'research', topicId: 'q', timeoutMs: 5000 });
    assert.equal(result.ok, false); assert.equal(result.aborted, 'budget');
    assert.match(result.reason, mode === 'repeat' ? /重复读取同一原文/ : /搜索次数超过上限/);
    assert.equal(result.cleanup.localStopped, true);
    assert.deepEqual(readSchedule(root).discoveryTopics, before);
    assert.match(fs.readFileSync(path.join(root, 'interrupts'), 'utf8'), /interrupt/);
  }
});

test('question tasks ignore web evidence watchdog yet keep wall timeout/interruption/output cap', { timeout: 15000 }, async t => {
  const failed = i => ({ type: 'tool_use', part: { tool: 'webfetch', state: { status: 'error', input: { url: 'https://source.test/' + i }, error: 'HTTP 403' } } });
  const { root, set } = fixture(t, { questions: [...Array.from({ length: 10 }, (_, i) => failed(i)), text([question()])], questionsDelayMs: 1200 });
  const result = await discoverTopics(root, { timeoutMs: 4000, maxFetchFailures: 2, stallMs: 1000 });
  assert.equal(result.ok, true); assert.equal(result.results.length, 1);
  set({ questions: [], hangAfter: 'questions' });
  const timeout = await discoverTopics(root, { timeoutMs: 1000 });
  assert.equal(timeout.ok, false); assert.equal(timeout.aborted, 'timeout'); assert.equal(timeout.cleanup.localStopped, true);
  assert.equal(timeout.cleanup.service, 'private');
  assert.equal(timeout.cleanup.interrupt.notRequired, true, '私有服务随进程组停止，不向共享服务发送该会话的中断');
  assert.equal(fs.existsSync(path.join(root, 'interrupts')), false);
  assert.equal(readSchedule(root).discoveryTopics.length, 1);
  set({ questions: [text('x'.repeat(17 * 1024 * 1024))] });
  const capped = await discoverTopics(root, { timeoutMs: 4000 });
  assert.equal(capped.ok, false); assert.equal(capped.aborted, 'output'); assert.equal(capped.cleanup.localStopped, true);
});

test('shared pure topic contract/re-export roundtrip and legacy admission remain compatible', t => {
  assert.equal(compatibleResearch, normalizeTopicResearch);
  const details = topicDetails({ ...question(), researchAssessment: assessment('reframe') });
  assert.deepEqual(details.question, question().question); assert.equal(details.researchAssessment.status, 'reframe');
  const proposed = '人工维护术语表有什么成本？';
  const brief = topicBrief({ ...question(), researchAssessment: assessment('reframe', { suggestedQuestion: proposed }) });
  assert.match(brief, /调查建议问题（尚未采用，不替换核心问题）/);
  assert.ok(brief.includes(proposed)); assert.ok(brief.includes(question().coreQuestion));
  const { root } = fixture(t);
  seed(root, [{ id: 'legacy', topic: '旧的无来源手工候选', status: 'candidate' }]);
  assert.equal(topicState(root).candidates[0].canEnqueue, true);
  assert.equal(updateTopicState(root, { action: 'accept', id: 'legacy' }).item.topic, '旧的无来源手工候选');
  const prompt = discoveryPrompt({ query: '普通用户的任务' });
  assert.match(prompt, /不依赖来源/); assert.match(prompt, /premises/); assert.doesNotMatch(prompt, /至少完成两个不同查询/);
  assert.match(prompt, /文案去模板化/);
  const recentPrompt = discoveryPrompt({ query: 'ChatGPT', mode: 'recent' });
  assert.match(recentPrompt, /锚定本次搜到的具体近期变化或事件/);
  const rPrompt = researchPrompt({ target: question(undefined, { id: 'q' }), date: '2026-11-22' });
  assert.match(rPrompt, /核心结论/); assert.match(rPrompt, /大白话中文提炼/);
});

test('discovery and investigation follow provider-settings model unless explicitly overridden', async t => {
  const { root, calls } = fixture(t);
  const home = path.join(root, 'home');
  const cfgDir = path.join(home, '.config', 'video-harness');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'providers.json'), JSON.stringify({
    preferredProvider: 'opencode',
    models: { opencode: 'hy4-flash-free' },
  }));
  seed(root);
  const qRes = await discoverTopics(root, { query: '离线翻译', home });
  assert.equal(qRes.ok, true, qRes.reason);
  const rRes = await discoverTopics(root, { operation: 'research', topicId: 'q', home });
  assert.equal(rRes.ok, true, rRes.reason);
  assert.deepEqual(calls().map(call => [call.operation, call.model]), [
    ['questions', 'opencode/hy4-flash-free'],
    ['research', 'opencode/hy4-flash-free'],
  ]);

  const explicit = await discoverTopics(root, { operation: 'research', topicId: 'q', home, model: 'fixture/explicit' });
  assert.equal(explicit.ok, true, explicit.reason);
  assert.equal(calls().at(-1).model, 'fixture/explicit');

  fs.writeFileSync(path.join(cfgDir, 'providers.json'), '{broken json');
  const countBefore = calls().length;
  const broken = await discoverTopics(root, { operation: 'research', topicId: 'q', home });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /providers\.json|不会自动换渠道/);
  assert.equal(calls().length, countBefore, '配置损坏时不得静默回落到其他渠道或启动执行器');
});
