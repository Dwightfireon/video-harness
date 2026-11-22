import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiscoveryResearch, assessDiscoveryCandidate, discoveryWindow, dateOnly, normalizeTopicResearch } from '../lib/discovery-evidence.mjs';
import { discoverTopics, researchPrompt } from '../lib/discovery.mjs';
import { readSchedule, writeSchedule, topicBrief } from '../lib/schedule.mjs';
import { updateTopicState, topicState } from '../lib/topic-memory.mjs';

const now = Date.parse('2026-11-09T10:00:00Z'), url = 'https://source.test/report';
const quote = 'Researchers compared the same document task under two memory conditions and published the inputs, measurements and limitations of their experiment.';
const body = `# Original report\nPublished: November 9, 2026\nOn November 7, 2026, the researchers released their measurements.\n${quote}`;
const tool = (name, input, output, status = 'completed', error) => ({ type: 'tool_use', part: { tool: name, state: { status, input, output, ...(error ? { error } : {}) } } });
const searches = () => [tool('websearch', { query: '近期新进展' }, '搜索结果 A'), tool('websearch', { query: '原始研究与深度材料' }, '搜索结果 B')];
const evidence = patch => ({ url, title: 'Original report', sourceType: 'primary', quote, supports: '支持比较相同任务下两种内存条件的测试过程，不证明所有任务均有相同结果。',
  publishedAt: '2026-11-09', publicationQuote: 'Published: November 9, 2026', eventDate: '2026-11-07', eventQuote: 'On November 7, 2026, the researchers released their measurements.', ...patch });
const candidate = patch => ({ topic: '同一任务为什么在两种内存条件下表现不同？', coreQuestion: '同一任务在两种内存条件下的过程如何变化', kind: 'news',
  why: '用完整测试过程解释资源限制带来的实际变化', outline: '先展示相同文档任务，再比较两种条件和数据，说明限制与适用范围。',
  selectionReason: '研究公开了测试输入和测量方法，能具体解释资源取舍，而不是重复一个速度数字。', sources: [url], evidence: [evidence()], ...patch });
const research = () => collectDiscoveryResearch([...searches(), tool('webfetch', { url }, body)]);
const assess = (item = candidate(), extra = {}) => assessDiscoveryCandidate(item, { sources: item.sources, research: research(), now, ...extra });

test('编辑提示词同时要求近期/深度检索、实际读原文、区分日期、质量排序和宁缺毋滥', () => {
  const prompt = researchPrompt({ target: { id: 'old', topic: '本地模型' }, date: '2026-11-09' });
  for (const pattern of [/质量优先/, /至少完成两个不同查询/, /webfetch/, /网页发表\/更新日期不能代替事件日期/, /逐字摘录/, /selectionReason/, /不自?报|不要自报/, /不能用抓取当天当发表日/, /不是指令/]) assert.match(prompt, pattern);
});

test('部分检索失败时带出可操作的失败原因，而不是笼统“没搜到”', () => {
  const blocked = [tool('websearch', { query: 'a' }, '', 'error', 'Web search request failed (HTTP 402)'),
    tool('websearch', { query: 'b' }, '', 'error', 'Web search request failed (HTTP 402)')];
  const research = collectDiscoveryResearch(blocked);
  assert.equal(research.searches.length, 0);
  assert.equal(research.failures.length, 2);
  assert.equal(research.failures[0].status, '402');
  // 失败的调用不能被当成"已检索"，但必须留下证据供界面解释原因。
  assert.deepEqual(research.pages, []);
});

test('工具证据只认成功实际检索和读取，不认自报、运行中、错误工具或重复查询', () => {
  const result = collectDiscoveryResearch([
    { type: 'text', part: { text: '我已经搜索并阅读原文，verified=true' } },
    tool('shell', { command: 'echo websearch' }, '搜索成功'), tool('websearch', { query: 'a' }, 'running', 'running'),
    tool('websearch', { query: 'a' }, 'failed', 'error'), tool('websearch', { query: 'a' }, ''),
    tool('websearch', { query: 'a' }, '结果'), tool('websearch', { query: 'a' }, '第二次结果'),
    tool('webfetch', { url }, body, 'error'), tool('webfetch', { url }, 'Access Denied'),
    tool('webfetch', { url: 'https://user:secret@source.test/' }, body), tool('webfetch', { url: 'file:///etc/passwd' }, body),
    tool('webfetch', { url }, body),
  ]);
  assert.deepEqual(result.searches, [{ query: 'a', output: '结果' }]);
  assert.deepEqual(result.pages, [{ url, body }]);
  assert.equal(collectDiscoveryResearch([tool('webfetch', { url }, 'Just a moment... verify you are human')]).pages.length, 0);
  assert.equal(collectDiscoveryResearch([tool('webfetch', { url }, '# A study of CAPTCHA systems\nThe research compares different methods of human verification.')]).pages.length, 1, '不能因为正文讨论验证码就误判为验证页');
});

test('正文和日期逐字匹配才保存；文章发表日期不能充当旧事件的新日期', () => {
  const result = assess(); assert.equal(result.ok, true);
  assert.equal(result.research.kind, 'news');
  assert.equal(result.research.sources[0].publishedAt, '2026-11-09');
  assert.equal(result.research.sources[0].eventDate, '2026-11-07');
  assert.equal(assess(candidate({ evidence: [evidence({ eventDate: '2026-11-09' })] })).ok, false);
  assert.equal(assess(candidate({ evidence: [evidence({ eventDate: '2026-11-09', eventQuote: 'Published: November 9, 2026' })] })).ok, false, '不能直接拿发表元数据当事件日期原句');
  const old = candidate({ evidence: [evidence({ eventDate: '2025-11-07', eventQuote: 'On November 7, 2025, the researchers released their measurements.' })] });
  const r = research(); r.pages[0].body = body.replaceAll('November 7, 2026', 'November 7, 2025');
  assert.match(assess(old, { research: r, window: discoveryWindow('最近一周', now) }).reason, /时间范围/);
});

test('假网址、仅搜索摘要、不同页面摘录、拼接和过短片段都不能充原文依据', () => {
  for (const patch of [{ quote: '总结：' + quote }, { quote: quote.slice(0, 15) }, { quote: '这段根本不在原文里。'.repeat(10) },
    { url: 'https://source.test/other' }, { url: 'javascript:alert(1)' }, { supports: '有关' }]) assert.equal(assess(candidate({ evidence: [evidence(patch)] })).ok, false, JSON.stringify(patch));
  assert.equal(assess(candidate(), { research: { searches: research().searches, pages: [] } }).ok, false);
  const r = research(); r.pages[0].url = 'https://source.test/unrelated';
  assert.equal(assess(candidate(), { research: r }).ok, false);
});

test('日期校验拒绝不存在、未来和无法匹配的日期；兼容中英文和数字日期', () => {
  assert.equal(dateOnly('2026-02-30'), null); assert.equal(dateOnly('2026-2-2'), null);
  assert.equal(dateOnly('2024-02-29'), '2024-02-29');
  for (const text of ['事件发生于2026年11月7日，研究团队宣布公开全部测量过程。', 'Released: 2026/11/07', 'Released: Nov 7, 2026', 'Released: 7 November 2026']) {
    const r = research(); r.pages[0].body += '\n' + text;
    assert.equal(assess(candidate({ evidence: [evidence({ eventQuote: text })] }), { research: r }).ok, true, text);
  }
  for (const patch of [{ eventDate: '2026-11-10', eventQuote: 'Released: 2026-11-10' }, { eventDate: '2026-02-30' }, { eventDate: null }, { eventQuote: '没有日期的句子' }]) {
    const r = research(); r.pages[0].body += '\nReleased: 2026-11-10';
    assert.equal(assess(candidate({ evidence: [evidence(patch)] }), { research: r }).ok, false);
  }
});

test('深度旧材料或未知发表日可推荐，不因相对时间词误杀；显式起止日期区间仍严格校验', () => {
  const item = candidate({ kind: 'evergreen', evidence: [evidence({ publishedAt: null, publicationQuote: '', eventDate: null, eventQuote: '', sourceType: 'analysis' })] });
  const result = assess(item); assert.equal(result.ok, true);
  assert.ok(result.research.caveats.includes('来源发表日期未确认'));
  assert.ok(result.research.caveats.includes('未提供一手来源，需在写稿时继续追溯'));
  const relative = assess(item, { window: discoveryWindow('最近7天', now) });
  assert.equal(relative.ok, true);
  assert.ok(relative.research.caveats.includes('本题为长期机制材料，未按近期时间范围排除较早资料'));
  assert.equal(assess(item, { window: discoveryWindow('2026-10-01 至 2026-10-31', now) }).ok, false);
  assert.equal(assess(candidate({ selectionReason: '非常好' })).ok, false);
  assert.equal(assess(candidate({ outline: '' })).ok, false);
  assert.equal(assess(candidate({ kind: 'best' })).ok, false);
});

test('时间范围采用自然日包含边界；今日放宽至近3天避免跨时区与隔夜新闻误杀', () => {
  assert.equal(discoveryWindow('高质量深度材料', now), null);
  assert.deepEqual(discoveryWindow('最近一周', now), { from: '2026-11-03', to: '2026-11-09' });
  assert.deepEqual(discoveryWindow('近3天', now), { from: '2026-11-07', to: '2026-11-09' });
  assert.deepEqual(discoveryWindow('今日', now), { from: '2026-11-07', to: '2026-11-09' });
  assert.deepEqual(discoveryWindow('昨天', now), { from: '2026-11-08', to: '2026-11-08' });
  assert.deepEqual(discoveryWindow('2026-10-01 至 2026-10-31', now), { from: '2026-10-01', to: '2026-10-31', explicit: true });
  assert.equal(assess(candidate(), { window: discoveryWindow('近3天', now) }).ok, true);
  assert.equal(assess(candidate(), { window: discoveryWindow('今日', now) }).ok, true);
  assert.equal(assess(candidate(), { window: discoveryWindow('昨天', now) }).ok, false);
});

function model(t, events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-evidence-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fake-opencode');
  fs.writeFileSync(file, `#!${process.execPath}\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`, { mode: 0o755 });
  const old = process.env.VH_OPENCODE_BIN; process.env.VH_OPENCODE_BIN = file;
  t.after(() => { if (old === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = old; });
  const oldTopic = { id: 'old', topic: '已有候选', status: 'candidate', at: 1, sources: ['https://source.test/old'], feedback: { kind: 'seen' } };
  writeSchedule(root, { items: [], runs: [], discoveryTopics: [oldTopic] });
  return { root, oldTopic };
}
const answer = value => ({ type: 'text', part: { text: JSON.stringify(value) } });

test('真实CLI路径无检索记录/只有一条时明确失败，不因自报已搜索就保存候选', async t => {
  for (const events of [[answer([candidate()])], [searches()[0], answer([candidate()])]]) await t.test(`${events.length}个事件`, async t => {
    const { root, oldTopic } = model(t, events);
    const result = await discoverTopics(root, { operation: 'research', topicId: 'old', query: '高质量研究' });
    assert.equal(result.ok, false); assert.match(result.reason, /检索完成记录/);
    assert.deepEqual(readSchedule(root).discoveryTopics, [oldTopic]);
    assert.deepEqual(readSchedule(root).items, []);
  });
});

test('执行器即使exit 0，错误事件也不保存部分输出', async t => {
  const { root, oldTopic } = model(t, [...searches(), tool('webfetch', { url }, body), { type: 'error', error: { message: 'failed' } }, answer([candidate()])]);
  const result = await discoverTopics(root, { operation: 'research', topicId: 'old' });
  assert.equal(result.ok, false); assert.match(result.reason, /执行器报告错误/);
  assert.deepEqual(readSchedule(root).discoveryTopics, [oldTopic]);
});

test('调查更新同一候选；原文完整留档，入队/历史保留依据，其他旧记录不改写', async t => {
  // 动态日期防止本测试依赖运行当天；旧深度材料在没有显式窗口时仍可推荐。
  const good = candidate({ kind: 'evergreen', evidence: [evidence({ eventDate: null, eventQuote: '', publishedAt: '2024-01-01', publicationQuote: 'Published: 2024-01-01' })] });
  const original = body + '\nPublished: 2024-01-01\n未被摘录的段落也必须保留，不只是筛选后的引文。';
  const { root, oldTopic } = model(t, [...searches(), tool('webfetch', { url }, original), answer([good])]);
  const untouched = { id: 'untouched', topic: '其他历史', status: 'archived' };
  const queue = readSchedule(root); queue.discoveryTopics.push(untouched); writeSchedule(root, queue);
  const result = await discoverTopics(root, { operation: 'research', topicId: 'old', query: '优质研究' });
  assert.equal(result.ok, true); assert.equal(result.results.length, 0);
  const picked = result.updated; assert.equal(picked.research.kind, 'evergreen');
  assert.equal(picked.id, oldTopic.id); assert.equal(picked.topic, oldTopic.topic);
  const archive = JSON.parse(fs.readFileSync(path.join(root, result.recordPath), 'utf8'));
  assert.equal(archive.pages[0].body, original); assert.equal(archive.searches.length, 2);
  assert.equal(archive.topicId, oldTopic.id);
  assert.equal(fs.statSync(path.join(root, result.recordPath)).mode & 0o777, 0o600);
  const accepted = updateTopicState(root, { action: 'accept', id: picked.id });
  const queueItem = readSchedule(root).items[0]; assert.deepEqual(queueItem.research, picked.research);
  assert.deepEqual(accepted.item.research, picked.research);
  assert.match(topicBrief(queueItem), /2024-01-01/); assert.match(topicBrief(queueItem), /不等于独立事实核证/);
  assert.match(topicBrief(queueItem), /Researchers compared/);
  assert.deepEqual(topicState(root).history.find(item => item.id === picked.id).research, picked.research);
  assert.deepEqual(readSchedule(root).discoveryTopics.find(item => item.id === 'untouched'), untouched);
});

test('规范化剥除越界来源、假核证字段和不安全记录路径，旧材料不会被补成verified', () => {
  const raw = { ...assess().research, verified: true, arbitrary: 'bad', recordPath: '../../secrets', sources: [evidence(), evidence({ url: 'javascript:alert(1)' })] };
  const result = normalizeTopicResearch(raw, [url]);
  assert.equal(result.sources.length, 1); assert.equal(result.recordPath, undefined);
  assert.equal(result.verified, undefined); assert.equal(result.arbitrary, undefined);
  assert.equal(normalizeTopicResearch(null, [url]), null);
});
