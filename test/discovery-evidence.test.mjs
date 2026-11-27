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

test('按学科分层的权威依据标准校验：自然科学付费墙组合、社科权威报告、哲学学术百科合法通过，营销号与死链被拒', () => {
  // 1. 自然科学类（非一手，来自 Nature 摘要 + Quanta Magazine 权威解读）
  const natUrl = 'https://www.quantamagazine.org/crispr-mechanism-2026';
  const natQuote = 'The researchers used cryo-EM to observe the conformational changes during DNA cleavage at high resolution.';
  const natBody = `# CRISPR Mechanism\nPublished: November 9, 2026\n${natQuote}`;
  const natResearch = collectDiscoveryResearch([...searches(), tool('webfetch', { url: natUrl }, natBody)]);
  const natItem = candidate({
    kind: 'evergreen',
    topic: 'CRISPR 基因编辑如何精准识别目标 DNA',
    subject: 'CRISPR 基因编辑',
    coreQuestion: 'CRISPR 酶在切割 DNA 时发生怎样的构象变化',
    sources: [natUrl],
    evidence: [evidence({
      url: natUrl,
      sourceType: 'analysis',
      quote: natQuote,
      publicationQuote: 'Published: November 9, 2026',
      eventDate: null,
      eventQuote: '',
    })],
  });
  const natResult = assessDiscoveryCandidate(natItem, { sources: natItem.sources, research: natResearch, now });
  assert.equal(natResult.ok, true);
  assert.ok(natResult.research.caveats.some(c => /权威机构解读/.test(c)));

  // 2. 社会科学类（来自 OECD 报告）
  const socUrl = 'https://www.oecd.org/reports/income-inequality-2026';
  const socQuote = 'Across OECD countries, the Gini coefficient increased slightly from 0.31 to 0.33 following labor market shifts.';
  const socBody = `# Income Inequality Report\nPublished: November 9, 2026\n${socQuote}`;
  const socResearch = collectDiscoveryResearch([...searches(), tool('webfetch', { url: socUrl }, socBody)]);
  const socItem = candidate({
    kind: 'evergreen',
    topic: 'OECD 成员国收入不平等现象为何持续拉大',
    subject: '收入不平等',
    coreQuestion: '劳动力市场结构变化如何影响不同收入阶层的分配差距',
    sources: [socUrl],
    evidence: [evidence({
      url: socUrl,
      sourceType: 'reporting',
      quote: socQuote,
      publicationQuote: 'Published: November 9, 2026',
      eventDate: null,
      eventQuote: '',
    })],
  });
  const socResult = assessDiscoveryCandidate(socItem, { sources: socItem.sources, research: socResearch, now });
  assert.equal(socResult.ok, true);
  assert.ok(socResult.research.caveats.some(c => /权威机构报告/.test(c)));

  // 3. 哲学/思辨类（来自 SEP 斯坦福哲学百科）
  const philUrl = 'https://plato.stanford.edu/entries/free-will/';
  const philQuote = 'Compatibilism is the thesis that free will is compatible with determinism even under physical constraints.';
  const philBody = `# Free Will\nPublished: November 9, 2026\n${philQuote}`;
  const philResearch = collectDiscoveryResearch([...searches(), tool('webfetch', { url: philUrl }, philBody)]);
  const philItem = candidate({
    kind: 'evergreen',
    topic: '决定论与自由意志能否在相容论下达成调和',
    subject: '自由意志哲学',
    coreQuestion: '相容论如何重新定义自由意志以避开物理决定论的排斥',
    sources: [philUrl],
    evidence: [evidence({
      url: philUrl,
      sourceType: 'analysis',
      quote: philQuote,
      publicationQuote: 'Published: November 9, 2026',
      eventDate: null,
      eventQuote: '',
    })],
  });
  const philResult = assessDiscoveryCandidate(philItem, { sources: philItem.sources, research: philResearch, now });
  assert.equal(philResult.ok, true);
  assert.ok(philResult.research.caveats.some(c => /权威学术百科/.test(c)));

  // 4. 营销号/垃圾域名依然被拒（即使文本完全匹配且字数足够）
  const junkUrl = 'https://zhuanlan.zhihu.com/p/123456';
  const junkQuote = '这是一份营销号水文，详细介绍了各种未核实的技术与所谓内幕爆料，不提供原始出处与数据支撑。';
  const junkBody = `# 知乎专栏文章\nPublished: November 9, 2026\n${junkQuote}`;
  const junkResearch = collectDiscoveryResearch([...searches(), tool('webfetch', { url: junkUrl }, junkBody)]);
  const junkItem = candidate({
    topic: '知乎热帖讨论的某种技术现象',
    sources: [junkUrl],
    evidence: [evidence({
      url: junkUrl,
      sourceType: 'primary',
      quote: junkQuote,
      publicationQuote: 'Published: November 9, 2026',
    })],
  });
  const junkResult = assessDiscoveryCandidate(junkItem, { sources: junkItem.sources, research: junkResearch, now });
  assert.equal(junkResult.ok, false);
  assert.match(junkResult.reason, /有效片段/);

  // 5. 死链/未读取的 URL 依然被拒
  const deadUrl = 'https://iep.utm.edu/epistemo-broken';
  const deadResearch = collectDiscoveryResearch([...searches()]); // webfetch 未完成或失败
  const deadItem = candidate({
    topic: '认识论中的怀疑论挑战如何回应',
    sources: [deadUrl],
    evidence: [evidence({
      url: deadUrl,
      sourceType: 'analysis',
      quote: 'Epistemological skepticism questions the possibility of knowledge and justification under standard criteria.',
    })],
  });
  const deadResult = assessDiscoveryCandidate(deadItem, { sources: deadItem.sources, research: deadResearch, now });
  assert.equal(deadResult.ok, false);
  assert.match(deadResult.reason, /有效片段/);
});

test('全领域新闻默认启用 90 天时效护栏；非技术选题归入 general/opinion，不再误套 AI 论文标准', () => {
  // 1. 非 AI 领域的旧新闻（超过 90 天且无显式放宽窗口）同样被拦下
  const oldBizUrl = 'https://www.reuters.com/business/retail-shift-2026';
  const oldBizQuote = 'On June 1, 2026, the retail chain announced a nationwide store restructuring plan across twelve cities.';
  const oldBizBody = `# Retail Restructuring\nPublished: June 2, 2026\n${oldBizQuote}`;
  const oldBizResearch = collectDiscoveryResearch([...searches(), tool('webfetch', { url: oldBizUrl }, oldBizBody)]);
  const oldBizItem = candidate({
    kind: 'news',
    topic: '连锁零售品牌门店重组调整为什么集中在二线城市',
    subject: '连锁零售品牌',
    coreQuestion: '本轮门店调整涉及哪些区域与成本结构变化',
    sources: [oldBizUrl],
    evidence: [evidence({
      url: oldBizUrl,
      sourceType: 'reporting',
      quote: oldBizQuote,
      publishedAt: '2026-06-02',
      publicationQuote: 'Published: June 2, 2026',
      eventDate: '2026-06-01',
      eventQuote: oldBizQuote,
    })],
  });
  const oldBizResult = assessDiscoveryCandidate(oldBizItem, { sources: oldBizItem.sources, research: oldBizResearch, now });
  assert.equal(oldBizResult.ok, false);
  assert.match(oldBizResult.reason, /近 90 天默认时效窗口/);

  // 2. 观点思辨类（kind: 'opinion'）不因早于 18 个月或无实证论文被拒，且学科不再误判为 tech
  const opinionUrl = 'https://aeon.co/essays/why-modern-workplaces-overvalue-busyness';
  const opinionQuote = 'Visible busyness has become a proxy for commitment whenever creative output is difficult to measure directly.';
  const opinionBody = `# Overvaluing Busyness\nPublished: March 10, 2024\n${opinionQuote}`;
  const opinionResearch = collectDiscoveryResearch([...searches(), tool('webfetch', { url: opinionUrl }, opinionBody)]);
  const opinionItem = candidate({
    kind: 'opinion',
    topic: '为什么我不再建议用忙碌程度衡量创作型工作的投入？职场取舍漫谈',
    subject: '创作型工作评价',
    coreQuestion: '当产出难以量化时用忙碌度替代评价会带来怎样的扭曲',
    sources: [opinionUrl],
    evidence: [evidence({
      url: opinionUrl,
      sourceType: 'analysis',
      quote: opinionQuote,
      publishedAt: '2024-03-10',
      publicationQuote: 'Published: March 10, 2024',
      eventDate: null,
      eventQuote: '',
    })],
  });
  const opinionResult = assessDiscoveryCandidate(opinionItem, { sources: opinionItem.sources, research: opinionResearch, now });
  assert.equal(opinionResult.ok, true);
  assert.equal(opinionResult.discipline, 'opinion');
  assert.equal(opinionResult.research.kind, 'opinion');
  assert.ok(opinionResult.research.caveats.some(c => /观点与思辨类依据/.test(c)));
});
