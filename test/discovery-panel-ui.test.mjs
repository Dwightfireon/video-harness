import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { safeSourceURL } from '../www/discovery-panel.mjs';

const WWW = new URL('../www/', import.meta.url);
const topic = id => ({ id, topic: '本地模型为什么运行慢？' + id, subject: '本地模型', coreQuestion: '显存足够时，速度为什么仍受内存带宽限制？',
  why: '从真实使用问题理解性能瓶颈', outline: '比较运行场景，再解释瓶颈与适用范围。', difference: '不做参数排行榜，讨论具体瓶颈', angle: '硬件与推理',
  sources: ['https://example.com/source?q=1&x=2', 'javascript:alert(1)', 'https://u:secret@example.com/'],
   query: '本地模型', at: 1000, status: 'candidate' });
const questionTopic = (id, extra = {}) => ({ ...topic(id), topic: '工具节省的时间去了哪里？', coreQuestion: 'AI 工具省下的时间，为什么未必变成更少的工作？', sources: [],
  question: { version: 1, audience: '使用 AI 工具的普通上班族', value: '弄清省时与工作量之间有哪些变化，帮助判断工具是否真的减轻了负担。',
    investigate: ['比较同类任务在使用工具前后的耗时', '调查任务数量与交付标准是否随之变化'], premises: ['并非所有人使用工具以后工作量都会增加，需先确认适用场景。'] },
  researchAssessment: { version: 1, status: 'unresearched', finding: '', gaps: [], suggestedQuestion: '' }, ...extra });
const researchFixture = () => ({ version: 1, kind: 'evergreen', selectionReason: '材料说明了一个工作流程变化，但不足以外推到所有人。', checkedAt: 1000, caveats: [],
  sources: [{ url: 'https://example.com/work', title: '具体工作流程的观察', sourceType: 'reporting', quote: '这里是已经读取并匹配的具体工作流程材料摘录，用于展示研究线索，不代表所有人的情况，也不等于已经完成事实核实。', supports: '用于调查工作量与交付标准之间的变化。', publishedAt: null, eventDate: null }] });
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
async function setup(t, { width = 1280, autoQueue, job, extra = [], beforeResponse } = {}) {
  const browser = await launchBrowser(chromium, { headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const h = { page, errors: [], calls: [], topics: [topic('a'), topic('b'), ...extra], notes: '偏好具体问题', revision: 1,
    config: { enabled: false, query: '本地模型', count: 5, mode: 'focused', autoQueue }, queue: [],
    job: job || { view: { state: 'idle' }, job: null }, failAction: '', failTopics: false, beforeResponse };
  const state = (view = {}) => {
    const records = h.topics.map(item => ({ ...item, canEnqueue: item.canEnqueue ?? (item.question?.version !== 1 || item.researchAssessment?.status === 'leads' && Boolean(item.research?.sources?.length)), inQueue: h.queue.some(q => q.id === item.queueId), queueState: item.queueId ? h.queue.some(q => q.id === item.queueId) ? 'present' : 'removed' : 'none' }));
    const candidates = records.filter(item => item.status === 'candidate' && item.placement !== 'history'), suggestions = records.filter(item => item.status === 'suggestion');
    const filter = view.historyFilter || 'all', query = view.historyQuery || '', limit = Number(view.historyLimit) || 20;
    const history = records.filter(item => !candidates.includes(item) && !suggestions.includes(item))
      .filter(item => filter === 'all' || item.status === filter || filter === 'queued' && item.queueId || filter === 'archived' && item.status === 'superseded')
      .filter(item => JSON.stringify([item.topic, item.coreQuestion, item.feedback]).includes(query));
    const offset = history.length ? Math.min(Number(view.historyOffset) || 0, Math.floor((history.length - 1) / limit) * limit) : 0;
    return { topics: records, total: records.length, candidates, suggestions, history: history.slice(offset, offset + limit), historyTotal: history.length,
      historyOffset: offset, historyLimit: limit, historyFilter: filter, historyQuery: query, historyNextOffset: offset + limit < history.length ? offset + limit : null,
      revision: h.revision, preferences: { notes: h.notes }, config: h.config, feedbackCount: records.filter(item => item.feedback).length };
  };
  page.on('pageerror', error => h.errors.push(error.message));
  page.on('dialog', dialog => { h.errors.push('unexpected dialog'); dialog.dismiss(); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (p.startsWith('/_vh/')) {
      const file = new URL(p.slice(5), WWW); if (!file.href.startsWith(WWW.href) || !fs.existsSync(file)) return route.abort();
      return route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
    }
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(new URL('index.html', WWW)) });
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    h.calls.push({ path: p, method: request.method(), body, query: Object.fromEntries(url.searchParams) });
    if (p === '/_api/schedule/discover/topics') {
      if (h.failTopics) return json(route, { error: '模拟候选读取失败' }, 503);
      if (!body) { const value = state(Object.fromEntries(url.searchParams)); if (h.beforeResponse) await h.beforeResponse({ body, value, path: p }); return json(route, value); }
      if (body.action === h.failAction) return json(route, { error: '模拟保存失败' }, 409);
      const item = h.topics.find(item => item.id === body.id);
      if (body.action === 'config') Object.assign(h.config, body.config);
      else if (body.action === 'preferences') h.notes = body.notes;
      else if (body.action === 'accept' || body.action === 'requeue') {
        if (!h.queue.some(q => q.id === item.queueId)) { item.queueId = 'q-' + item.id; h.queue.push({ id: item.queueId, topic: item.topic, state: 'todo' }); }
        item.status = 'queued'; item.feedback = { kind: 'interested', at: Date.now() };
      } else if (body.action === 'feedback') {
        item.feedback = { kind: body.kind, reason: body.reason || '', note: body.note || '', at: Date.now() };
        if (!item.queueId && !['duplicate', 'archived', 'superseded', 'suggestion'].includes(item.status)) item.status = body.kind === 'seen' ? 'seen' : 'dismissed';
      } else if (body.action === 'clear-feedback') {
        for (const entry of h.topics.filter(item => !body.id || item.id === body.id)) {
          delete entry.feedback;
          if (body.id && ['seen', 'dismissed'].includes(entry.status) && !entry.queueId && entry.placement !== 'history') entry.status = 'candidate';
        }
      } else if (body.action === 'archive' || body.action === 'dismiss-suggestion') { item.status = 'archived'; item.placement = 'history'; }
      else if (body.action === 'restore') { item.status = 'candidate'; delete item.placement; }
      else if (body.action === 'adopt') {
        const parent = h.topics.find(entry => entry.id === item.parentId);
        if (body.replace && (parent.status !== 'candidate' || parent.feedback || parent.queueId)) return json(route, { error: '原题状态已变化，请另存为候选' }, 409);
        if (body.replace) { parent.status = 'superseded'; parent.placement = 'history'; parent.replacedBy = item.id; }
        item.status = 'candidate'; delete item.placement;
      }
      h.revision++;
      const value = { ...state(body.view), updated: item ? state(body.view).topics.find(entry => entry.id === item.id) : undefined };
      if (h.beforeResponse) await h.beforeResponse({ body, value, path: p }); return json(route, value);
    }
    if (p === '/_api/schedule/discover') {
      if (body) h.job = { view: { state: 'running', text: '模拟检索中' }, job: { id: 'mock-job', operation: body.operation || 'questions', topicId: body.topicId, followupId: body.followupId, followup: body.followup, results: [] } };
      const value = h.job; if (h.beforeResponse) await h.beforeResponse({ body, value, path: p });
      return json(route, value);
    }
    if (p === '/_api/schedule') return json(route, { items: h.queue, timing: {} });
    if (p === '/_api/projects') return json(route, { projects: [] });
    if (p === '/_api/trash') return json(route, { items: [], totalBytes: 0 });
    if (p === '/_api/agent-ready') return json(route, { ready: true, provider: 'mock' });
    if (p === '/_api/providers') return json(route, { providers: [], current: {} });
    return json(route, {});
  });
  await page.goto('http://discovery.test/'); await page.locator('#queueBox > summary').click();
  await page.waitForSelector('[data-topic-id="a"]');
  await page.waitForFunction(() => document.querySelector('#discQuery').value === '本地模型');
  return h;
}
const card = (page, id) => page.locator(`[data-topic-id="${id}"]`);
const receipt = (page, id) => page.locator(`[data-receipt-id="${id}"]`);
const posts = (h, endpoint) => h.calls.filter(item => item.method === 'POST' && (!endpoint || item.path === endpoint));
async function settings(page) { if (!await page.locator('#discoverySettings').evaluate(el => el.open)) await page.locator('#discoverySettings > summary').click(); }
async function topicAction(page, id, name) {
  const target = card(page, id).getByRole('button', { name, exact: true });
  if (!await target.isVisible()) await card(page, id).locator('.topic-more > summary').click();
  await target.click();
}
async function done(h, results = []) { h.job = { view: { state: 'done' }, job: { ...h.job.job, results } }; await h.page.click('#discRefresh'); await h.page.waitForFunction(() => !document.querySelector('#discBtn').disabled); }
async function openHistory(page, id) { if (await page.getAttribute('#discHistoryToggle', 'aria-expanded') !== 'true') await page.click('#discHistoryToggle'); if (id) await card(page, id).locator(':scope > details > summary').click(); }

test('问题卡片先展示问题价值与受众，无来源也可保存，未调查不出现入队按钮', async t => {
  const h = await setup(t, { extra: [questionTopic('q')] }), { page } = h, q = card(page, 'q');
  assert.equal(await q.locator(':scope > h3').textContent(), questionTopic('q').coreQuestion);
  assert.match(await q.locator('.topic-summary').textContent(), /弄清省时与工作量/);
  assert.match(await q.locator('.topic-audience').textContent(), /普通上班族/);
  assert.match(await q.locator('.topic-evidence-meta').textContent(), /尚未调查/);
  assert.equal(await q.getByRole('button', { name: '调查此题', exact: true }).isVisible(), true);
  assert.equal(await q.getByRole('button', { name: '想做并加入队列', exact: true }).isDisabled(), true);
  await q.locator(':scope > details > summary').click();
  assert.match(await q.locator('dl').textContent(), /调查方向.*比较同类任务/s);
  assert.match(await q.locator('dl').textContent(), /待查前提.*需先确认适用场景/s);
  assert.match(await q.locator('.topic-sources').textContent(), /问题可以先保留/);
  assert.equal(posts(h).length, 0, '读取问题不隐式联网调查');
  assert.deepEqual(h.errors, []);
});

test('调查只提交当前题ID：忽略未保存方向与数量，完成后原位展示依据再允许入队', async t => {
  const h = await setup(t, { extra: [questionTopic('q')] }), { page } = h, q = card(page, 'q');
  await page.evaluate(() => { window.originalQ = document.querySelector('[data-topic-id="q"]'); });
  await page.fill('#discQuery', '无关方向'); await settings(page); await page.fill('#discCount', '0');
  await q.getByRole('button', { name: '调查此题', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#discMsg').textContent.includes('调查问题'));
  assert.deepEqual(posts(h, '/_api/schedule/discover').at(-1).body, { operation: 'research', topicId: 'q' });
  assert.equal(await q.getByRole('button', { name: '正在调查此题…', exact: true }).isDisabled(), true);
  assert.equal(await page.textContent('#discBtn'), '查找选题', '单题调查不冒充新一批选题');
  const saved = h.topics.find(item => item.id === 'q');
  Object.assign(saved, { sources: ['https://example.com/work'], research: researchFixture(), researchAssessment: { version: 1, status: 'leads', finding: '已有一个具体案例，还需要核对适用范围。', gaps: ['缺少不同岗位的对照'], suggestedQuestion: '' } });
  h.revision++; await done(h, [saved]);
  assert.equal(await page.evaluate(() => window.originalQ === document.querySelector('[data-topic-id="q"]')), true);
  assert.equal(await q.locator(':scope > h3').textContent(), questionTopic('q').coreQuestion);
  assert.match(await q.locator('.topic-evidence-meta').textContent(), /已有研究线索.*不代表已回答/);
  assert.equal(await q.getByRole('button', { name: '想做并加入队列', exact: true }).isEnabled(), true);
  assert.equal(h.queue.length, 0, '调查完成不自动入队');
  await q.locator(':scope > details > summary').click();
  assert.match(await q.locator('dl').textContent(), /尚缺什么.*不同岗位/s);
  assert.match(await q.locator('.topic-evidence').textContent(), /不等于独立事实核证/);
  await q.getByRole('button', { name: '想做并加入队列', exact: true }).click();
  await page.waitForSelector('[data-receipt-id="q"]');
  assert.equal(h.queue.length, 1);
  assert.deepEqual(h.errors, []);
});

test('材料不足与前提需调整仍保留问题，建议问法只作文字展示、不自动替换或入队', async t => {
  const revised = questionTopic('q', { researchAssessment: { version: 1, status: 'reframe', finding: '现有材料不足以支持原来猜测的前提。', gaps: ['需要区分任务和人群'], suggestedQuestion: '哪些任务真正减少了工作量？<img src=x onerror="alert(1)">' } });
  const h = await setup(t, { extra: [revised] }), { page } = h, q = card(page, 'q');
  assert.match(await q.locator('.topic-evidence-meta').textContent(), /建议调整问题.*原题未改动/);
  assert.equal(await q.locator(':scope > h3').textContent(), revised.coreQuestion);
  await q.locator(':scope > details > summary').click();
  assert.match(await q.locator('dl').textContent(), /建议问法（尚未采用）.*哪些任务/s);
  assert.equal(await q.locator('img').count(), 0);
  assert.equal(await q.getByRole('button', { name: '想做并加入队列', exact: true }).isDisabled(), true);
  Object.assign(revised.researchAssessment, { status: 'insufficient', finding: '本轮没有找到足够材料。' }); h.revision++;
  await page.click('#discRefresh');
  await page.waitForFunction(() => document.querySelector('[data-topic-id="q"] .topic-evidence-meta').textContent.includes('材料不足'));
  assert.equal(await q.getByRole('button', { name: '继续调查', exact: true }).isVisible(), true);
  assert.equal(h.queue.length, 0); assert.equal(revised.status, 'candidate');
  assert.deepEqual(h.errors, []);
});

test('界面服从服务端入队资格，不因已有来源或模型标为leads就自行解锁', async t => {
  const h = await setup(t, { extra: [questionTopic('q', { sources: ['https://example.com/work'], research: researchFixture(), canEnqueue: false,
    researchAssessment: { version: 1, status: 'leads', finding: '模型声称有线索，服务端仍未允许入队。', gaps: [], suggestedQuestion: '' } })] }), { page } = h;
  const queueButton = card(page, 'q').getByRole('button', { name: '想做并加入队列', exact: true });
  assert.equal(await queueButton.isVisible(), true);
  assert.equal(await queueButton.isDisabled(), true);
  assert.equal(await card(page, 'q').getByRole('button', { name: '继续调查', exact: true }).isEnabled(), true);
  assert.equal(h.queue.length, 0); assert.deepEqual(posts(h), []); assert.deepEqual(h.errors, []);
});

test('调查失败保留先前依据与问题，只刷新任务不自动重发调查', async t => {
  const saved = questionTopic('q', { sources: ['https://example.com/work'], research: researchFixture(), researchAssessment: { version: 1, status: 'leads', finding: '此前取得的材料', gaps: [], suggestedQuestion: '' } });
  const h = await setup(t, { extra: [saved] }), { page } = h, q = card(page, 'q');
  await q.getByRole('button', { name: '继续调查', exact: true }).click();
  h.job = { view: { state: 'failed', text: '模拟网络错误', hints: ['检查网络后再试'] }, job: h.job.job };
  await page.click('#discRefresh');
  await page.waitForFunction(() => document.querySelector('#discMsg').textContent.includes('调查失败'));
  assert.match(await page.textContent('#discMsg'), /已有材料.*保留/);
  assert.equal(await q.getByRole('button', { name: '想做并加入队列', exact: true }).isEnabled(), true);
  await q.locator(':scope > details > summary').click();
  assert.match(await q.locator('.topic-evidence').textContent(), /具体工作流程/);
  await page.click('#discRefresh');
  assert.equal(posts(h, '/_api/schedule/discover').length, 1);
  assert.deepEqual(h.errors, []);
});

test('继续调查期间手动入队，完成提示不把真实队列状态说成尚未入队', async t => {
  const saved = questionTopic('q', { sources: ['https://example.com/work'], research: researchFixture(), researchAssessment: { version: 1, status: 'leads', finding: '已有可继续调查的材料。', gaps: [], suggestedQuestion: '' } });
  const h = await setup(t, { extra: [saved] }), { page } = h, q = card(page, 'q');
  await q.getByRole('button', { name: '继续调查', exact: true }).click();
  await q.getByRole('button', { name: '想做并加入队列', exact: true }).click();
  await page.waitForSelector('[data-receipt-id="q"]');
  await done(h, [saved]);
  assert.equal(h.queue.length, 1);
  assert.match(await page.textContent('#discMsg'), /本次调查不会自动入队/);
  assert.doesNotMatch(await page.textContent('#discMsg'), /尚未入队/);
  assert.deepEqual(h.errors, []);
});

test('调查POST未确认时，刷新读到旧任务终态不解锁或允许重复提交', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { started = resolve; });
  const oldJob = { view: { state: 'done' }, job: { id: 'previous-job', operation: 'research', topicId: 'q', results: [] } };
  let newJob;
  const h = await setup(t, { extra: [questionTopic('q')], job: oldJob, beforeResponse: async ({ path, body, value }) => {
    if (path === '/_api/schedule/discover' && body?.operation === 'research') {
      newJob = value; h.job = oldJob; started(); await gate;
    }
  } }), { page } = h;
  t.after(() => release());
  await card(page, 'q').getByRole('button', { name: '调查此题', exact: true }).click(); await arrived;
  const oldRead = page.waitForResponse(response => response.url().endsWith('/_api/schedule/discover') && response.request().method() === 'GET');
  await page.click('#discRefresh'); await oldRead;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.isDisabled('#discBtn'), true);
  assert.equal(await card(page, 'q').getByRole('button', { name: '正在调查此题…', exact: true }).isDisabled(), true);
  assert.equal(posts(h, '/_api/schedule/discover').length, 1);
  h.job = newJob; release();
  await page.waitForFunction(() => document.querySelector('[data-topic-id="q"] .topic-local-message').textContent.includes('正在检查问题前提'));
  await done(h, []);
  assert.deepEqual(h.errors, []);
});

test('新调查POST已确认后，更早发出的旧任务GET回包不能覆盖新作业', async t => {
  let release, started, holdOld = false;
  const gate = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { started = resolve; });
  const h = await setup(t, { extra: [questionTopic('q')], job: { view: { state: 'done' }, job: { id: 'previous-job', results: [] } }, beforeResponse: async ({ path, body }) => {
    if (path === '/_api/schedule/discover' && !body && holdOld) { holdOld = false; started(); await gate; }
  } }), { page } = h;
  t.after(() => release());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  holdOld = true;
  await page.click('#discRefresh'); await arrived;
  await card(page, 'q').getByRole('button', { name: '调查此题', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-topic-id="q"] .topic-local-message').textContent.includes('正在检查问题前提'));
  const response = page.waitForResponse(res => res.url().endsWith('/_api/schedule/discover') && res.request().method() === 'GET');
  release(); await response;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.isDisabled('#discBtn'), true);
  assert.match(await page.textContent('#discMsg'), /调查问题/);
  assert.equal(posts(h, '/_api/schedule/discover').length, 1);
  await done(h, []); assert.deepEqual(h.errors, []);
});

test('初始任务基线未读到时，不能把同一题的旧终态误认成本次未确认调查', async t => {
  let releaseInitial, initialStarted, releasePost, postStarted, firstRead = true, newJob;
  const initialGate = new Promise(resolve => { releaseInitial = resolve; }), initialArrived = new Promise(resolve => { initialStarted = resolve; });
  const postGate = new Promise(resolve => { releasePost = resolve; }), postArrived = new Promise(resolve => { postStarted = resolve; });
  const oldJob = { view: { state: 'done' }, job: { id: 'old-research', operation: 'research', topicId: 'q', results: [] } };
  const h = await setup(t, { extra: [questionTopic('q')], job: oldJob, beforeResponse: async ({ path, body, value }) => {
    if (path !== '/_api/schedule/discover') return;
    if (!body && firstRead) { firstRead = false; initialStarted(); await initialGate; }
    if (body?.operation === 'research') { newJob = value; h.job = oldJob; postStarted(); await postGate; }
  } }), { page } = h;
  t.after(() => { releaseInitial(); releasePost(); });
  await initialArrived;
  await card(page, 'q').getByRole('button', { name: '调查此题', exact: true }).click(); await postArrived;
  const initialResponse = page.waitForResponse(res => res.url().endsWith('/_api/schedule/discover') && res.request().method() === 'GET');
  releaseInitial(); await initialResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const oldRead = page.waitForResponse(res => res.url().endsWith('/_api/schedule/discover') && res.request().method() === 'GET');
  await page.click('#discRefresh'); await oldRead;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.isDisabled('#discBtn'), true);
  assert.equal(await card(page, 'q').getByRole('button', { name: '正在调查此题…', exact: true }).isDisabled(), true);
  assert.doesNotMatch(await page.textContent('#discMsg'), /调查已结束/);
  h.job = newJob; releasePost();
  await page.waitForFunction(() => document.querySelector('[data-topic-id="q"] .topic-local-message').textContent.includes('正在检查问题前提'));
  await done(h, []); assert.deepEqual(h.errors, []);
});

test('问题与研究缺口在移动和桌面布局均无横向溢出', async t => {
  const h = await setup(t, { width: 320, extra: [questionTopic('q', { researchAssessment: { version: 1, status: 'reframe', finding: '需要缩小范围', gaps: ['未确认前提'.repeat(40)], suggestedQuestion: '哪些任务可以减少负担？'.repeat(20) } })] }), { page } = h;
  await card(page, 'q').locator(':scope > details > summary').click();
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no overflow at ' + width);
  }
  assert.deepEqual(h.errors, []);
});

test('来源只允许无凭证HTTP(S)，详情与历史默认收起且可真实展开/收起', async t => {
  for (const value of ['javascript:alert(1)', 'data:text/html,bad', '//example.com', '/local', 'https://u:p@example.com', null]) assert.equal(safeSourceURL(value), null);
  const h = await setup(t, { extra: [{ ...topic('old'), status: 'archived' }] }), { page } = h;
  assert.equal(await card(page, 'a').locator('.topic-sources a').count(), 1);
  assert.equal(await card(page, 'a').locator('.topic-sources a').isVisible(), false);
  await card(page, 'a').locator(':scope > details > summary').click();
  assert.equal(await card(page, 'a').locator('.topic-sources a').isVisible(), true);
  assert.equal(await page.isVisible('#discHistoryBody'), false);
  await page.click('#discHistoryToggle'); assert.equal(await page.isVisible('#discHistoryBody'), true);
  assert.equal(await page.textContent('#discHistoryArrow'), '−');
  await page.click('#discHistoryToggle'); assert.equal(await page.isVisible('#discHistoryBody'), false);
  assert.deepEqual(h.errors, []);
});

test('换角度只请求一条：不带全局方向/数量，建议挂原题下，采用只替换原题并保持其他DOM', async t => {
  const h = await setup(t), { page } = h;
  await page.evaluate(() => { window.originalB = document.querySelector('[data-topic-id="b"]'); });
  await page.fill('#discQuery', '完全无关的方向'); await settings(page); await page.fill('#discCount', '0');
  const searchResponse = page.waitForResponse(response => response.url().endsWith('/_api/schedule/discover') && response.request().method() === 'POST');
  await card(page, 'a').getByRole('button', { name: '换角度', exact: true }).click(); await searchResponse;
  assert.deepEqual(posts(h, '/_api/schedule/discover').at(-1).body, { followupId: 'a', followup: 'different' });
  assert.equal(await card(page, 'b').getByRole('button', { name: '想做并加入队列', exact: true }).isEnabled(), true);
  const alt = { ...topic('alt'), topic: '带宽限制下怎样选择本地模型？', status: 'suggestion', parentId: 'a', followup: 'different' };
  h.topics.push(alt); h.revision++; await done(h, [alt]);
  assert.equal(await page.locator('#discCandidates > article').count(), 2);
  assert.equal(await card(page, 'a').locator('[data-topic-id="alt"]').count(), 1);
  assert.match(await card(page, 'a').locator(':scope > h3').textContent(), /运行慢/);
  assert.equal(await page.evaluate(() => window.originalB === document.querySelector('[data-topic-id="b"]')), true);
  await card(page, 'alt').getByRole('button', { name: '采用这个角度', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#discCandidates > article')?.dataset.topicId === 'alt');
  assert.deepEqual(await page.locator('#discCandidates > article').evaluateAll(els => els.map(el => el.dataset.topicId)), ['alt', 'b']);
  assert.equal(h.topics.find(item => item.id === 'a').status, 'superseded');
  assert.equal(h.topics.find(item => item.id === 'b').status, 'candidate');
  assert.equal(await card(page, 'alt').getByRole('button', { name: '换角度', exact: true }).isVisible(), true, '采用后的候选仍有正常操作');
  await page.waitForFunction(() => document.activeElement?.closest('[data-topic-id="alt"]'));
  await page.click('#discRefresh');
  await page.waitForFunction(() => document.querySelector('#discMsg').textContent.includes('单条建议已处理'));
  assert.equal(h.queue.length, 0); assert.deepEqual(h.errors, []);
});

test('子题建议另存、不替换；不用建议和空结果均保留原题，无负反馈', async t => {
  const h = await setup(t), { page } = h;
  await topicAction(page, 'a', '找一个子题');
  const sub = { ...topic('sub'), status: 'suggestion', parentId: 'a', followup: 'deeper' }; h.topics.push(sub); h.revision++;
  await done(h, [sub]);
  assert.equal(await card(page, 'sub').getByRole('button', { name: '采用这个角度' }).isVisible(), false);
  await card(page, 'sub').getByRole('button', { name: '另存为候选' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#discCandidates > article').length === 3);
  assert.equal(h.topics[0].status, 'candidate');
  await card(page, 'a').getByRole('button', { name: '换角度', exact: true }).click(); await done(h, []);
  assert.equal(await page.locator('#discCandidates > article').count(), 3);
  assert.match(await page.textContent('#discMsg'), /原题保留/);
  assert.equal(h.topics.every(item => !item.feedback), true);
});

test('看过/不感兴趣一点击即生效，原位置有确认与撤销，可选原因不需要第二次确认才能反馈', async t => {
  const h = await setup(t), { page } = h;
  await topicAction(page, 'a', '不感兴趣');
  await page.waitForSelector('[data-receipt-id="a"]');
  assert.equal(h.topics[0].feedback.kind, 'not-interested');
  assert.equal(await page.locator('#discCandidates > article').count(), 1);
  await receipt(page, 'a').getByRole('button', { name: '补充原因' }).click();
  await receipt(page, 'a').locator('select').selectOption('题目太泛');
  await receipt(page, 'a').locator('textarea').fill('希望有具体场景 <img src=x onerror="alert(1)">');
  await receipt(page, 'a').getByRole('button', { name: '保存反馈说明' }).click();
  await page.waitForFunction(() => document.querySelector('#discActionMsg').textContent.includes('反馈说明已保存'));
  assert.equal(h.topics[0].feedback.reason, '题目太泛');
  await receipt(page, 'a').getByRole('button', { name: '撤销', exact: true }).click();
  await page.waitForSelector('#discCandidates > [data-topic-id="a"]');
  assert.equal(h.topics[0].feedback, undefined);
  await topicAction(page, 'b', '已经看过');
  await page.waitForSelector('[data-receipt-id="b"]'); assert.equal(h.topics[1].feedback.kind, 'seen');
  assert.deepEqual(h.errors, []);
});

test('收起不是负反馈；历史恢复、重新入队及批量清反馈的范围明确', async t => {
  const h = await setup(t), { page } = h;
  await topicAction(page, 'a', '先收起'); await page.waitForSelector('[data-receipt-id="a"]');
  assert.equal(h.topics[0].feedback, undefined);
  await receipt(page, 'a').getByRole('button', { name: '撤销', exact: true }).click(); await page.waitForSelector('#discCandidates > [data-topic-id="a"]');
  await card(page, 'a').getByRole('button', { name: '想做并加入队列', exact: true }).click(); await page.waitForSelector('[data-receipt-id="a"]');
  assert.equal(h.queue.length, 1); h.queue.length = 0; await page.click('#discRefresh'); await openHistory(page, 'a');
  assert.match(await card(page, 'a').locator('.topic-state').textContent(), /目前已移出/);
  await card(page, 'a').getByRole('button', { name: '重新加入队列' }).click(); await page.waitForFunction(() => document.querySelector('#queueList .queue-item'));
  assert.equal(h.queue.length, 1);
  await topicAction(page, 'b', '不感兴趣'); await page.waitForSelector('[data-receipt-id="b"]');
  await settings(page); await page.click('#discPreferencesToggle'); await page.click('#discFeedbackClear');
  assert.equal(h.topics.some(item => item.feedback), true, '首击只询问确认');
  await page.click('#discFeedbackConfirmYes'); await page.waitForFunction(() => document.querySelector('#discPreferencesMsg').textContent.includes('全部反馈已清空'));
  assert.equal(h.topics.every(item => !item.feedback), true); assert.equal(h.queue.length, 1);
  assert.equal(await page.locator('#discCandidates > article').count(), 0, '清反馈不把历史批量复活');
  assert.equal(posts(h).some(item => item.path.includes('/start')), false);
});

test('历史分页计数、搜索和状态筛选独立于候选，并保留页码而非每次回首页', async t => {
  const extra = Array.from({ length: 25 }, (_, i) => ({ ...topic('old-' + i), topic: '历史选题' + i, status: i % 2 ? 'seen' : 'archived' }));
  const h = await setup(t, { extra }), { page } = h; await openHistory(page);
  assert.match(await page.textContent('#discHistoryCount'), /25/);
  assert.equal(await page.locator('#discHistoryList > article').count(), 20);
  await page.click('#discHistoryNext'); await page.waitForFunction(() => document.querySelector('#discHistoryPageStatus').textContent.includes('21–25'));
  assert.equal(await page.locator('#discHistoryList > article').count(), 5);
  await card(page, 'old-20').locator(':scope > details > summary').click();
  await card(page, 'old-20').getByRole('button', { name: '已经看过', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#discActionMsg').textContent.includes('已经看过'));
  assert.match(await page.textContent('#discHistoryPageStatus'), /21–25/);
  await page.fill('#discHistoryQuery', '历史选题24'); await page.locator('#discHistorySearchForm button').click();
  await page.waitForFunction(() => document.querySelector('#discHistoryPageStatus').textContent.includes('共 1 条'));
  assert.equal(await page.locator('#discHistoryList > article').count(), 1);
  assert.equal(await page.locator('#discCandidates > article').count(), 2);
});

test('最后一页仅剩的历史放回候选后，返回有效页', async t => {
  const extra = Array.from({ length: 21 }, (_, i) => ({ ...topic('old-' + i), status: 'archived' }));
  const h = await setup(t, { extra }), { page } = h; await openHistory(page);
  await page.click('#discHistoryNext'); await page.waitForFunction(() => document.querySelector('#discHistoryPageStatus').textContent.includes('21–21'));
  await card(page, 'old-20').locator(':scope > details > summary').click();
  await card(page, 'old-20').getByRole('button', { name: '放回候选' }).click();
  await page.waitForFunction(() => document.querySelector('#discHistoryPageStatus').textContent.includes('1–20'));
  assert.equal(await page.locator('#discHistoryList > article').count(), 20);
  assert.equal(await page.locator('#discCandidates > article').count(), 3);
  assert.equal(await page.isEnabled('#discHistoryNext'), false);
});

test('轮询和刷新保留偏好、方向、备注、DOM及焦点；错误不被设置保存吞掉', async t => {
  const h = await setup(t), { page } = h;
  await settings(page); await page.click('#discPreferencesToggle'); await page.fill('#discNotes', '正在输入的新偏好'); await page.fill('#discQuery', '正在编辑的方向');
  await topicAction(page, 'a', '不感兴趣'); await page.waitForSelector('[data-receipt-id="a"]');
  await receipt(page, 'a').getByRole('button', { name: '补充原因' }).click(); await receipt(page, 'a').locator('textarea').fill('未提交的备注');
  await page.evaluate(() => { window.editor = document.activeElement; });
  h.job = { view: { state: 'failed', text: '模拟模型失败' }, job: { results: [] } };
  await page.click('#discRefresh'); await receipt(page, 'a').locator('textarea').focus();
  await page.waitForFunction(() => document.querySelector('#discMsg').textContent.includes('模拟模型失败'));
  assert.equal(await page.inputValue('#discNotes'), '正在输入的新偏好'); assert.equal(await page.inputValue('#discQuery'), '正在编辑的方向');
  assert.equal(await page.evaluate(() => window.editor === document.activeElement), true);
  assert.equal(await receipt(page, 'a').locator('textarea').inputValue(), '未提交的备注');
  await page.check('#discEnabled'); await page.waitForFunction(() => document.querySelector('#discConfigMsg').textContent.includes('未改变'));
  await page.check('#discAutoQueue'); await page.waitForFunction(() => document.querySelector('#discConfigMsg').textContent.includes('只影响自动发现'));
  await page.click('#discNotesSave'); await page.waitForFunction(() => document.querySelector('#discPreferencesMsg').textContent.includes('个人偏好已保存'));
  await page.click('#discNotesClear'); await page.waitForFunction(() => document.querySelector('#discPreferencesMsg').textContent.includes('已清空个人偏好'));
  assert.equal(await page.inputValue('#discNotes'), ''); assert.match(await page.textContent('#discMsg'), /模拟模型失败/);
  h.failAction = 'config'; await page.uncheck('#discAutoQueue'); await page.waitForFunction(() => document.querySelector('#discConfigMsg').textContent.includes('模拟保存失败'));
  assert.equal(await page.isChecked('#discAutoQueue'), true); assert.deepEqual(h.errors, []);
});

test('不同卡片可独立保存，迟到旧revision不能抹掉另一个操作', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await setup(t, { beforeResponse: async ({ body }) => { if (body?.action === 'feedback' && body.id === 'a') await gate; } }), { page } = h;
  await topicAction(page, 'a', '已经看过');
  assert.equal(await card(page, 'b').getByRole('button', { name: '想做并加入队列', exact: true }).isEnabled(), true);
  await topicAction(page, 'b', '不感兴趣'); await page.waitForSelector('[data-receipt-id="b"]');
  release(); await page.waitForSelector('[data-receipt-id="a"]');
  assert.equal(await page.locator('#discCandidates > article').count(), 0);
  assert.equal(h.topics.filter(item => item.feedback).length, 2);
  assert.deepEqual(h.errors, []);
});

test('反馈确认和撤销自动交接焦点；历史改变反馈后旧提示不会改回旧类型', async t => {
  const h = await setup(t), { page } = h;
  await topicAction(page, 'a', '不感兴趣');
  await page.waitForFunction(() => document.activeElement?.closest('[data-receipt-id="a"]'));
  await openHistory(page, 'a');
  await card(page, 'a').getByRole('button', { name: '已经看过', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-receipt-id="a"]').textContent.includes('已经看过'));
  await receipt(page, 'a').getByRole('button', { name: '补充原因' }).click();
  await receipt(page, 'a').locator('textarea').fill('只补充原因，不改反馈类型');
  await receipt(page, 'a').getByRole('button', { name: '保存反馈说明' }).click();
  await page.waitForFunction(() => document.querySelector('#discActionMsg').textContent.includes('反馈说明已保存'));
  assert.equal(h.topics[0].feedback.kind, 'seen');
  await receipt(page, 'a').getByRole('button', { name: '撤销', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.closest('#discCandidates > [data-topic-id="a"]'));
  assert.equal(h.topics[0].feedback, undefined);
  assert.deepEqual(h.errors, []);
});

test('不用建议只收起该建议并交还焦点；原题和其他候选不变', async t => {
  const h = await setup(t), { page } = h;
  h.topics.push({ ...topic('alt'), parentId: 'a', status: 'suggestion', followup: 'different' }); h.revision++;
  await page.click('#discRefresh');
  await card(page, 'alt').getByRole('button', { name: '不用这个建议' }).click();
  await page.waitForFunction(() => !document.querySelector('#discCandidates [data-topic-id="alt"]'));
  assert.deepEqual(h.topics.slice(0, 2).map(item => item.status), ['candidate', 'candidate']);
  assert.equal(h.topics[2].feedback, undefined);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-topic-id]')?.dataset.topicId), 'a');
});

test('迟到检索POST不能覆盖已开始的新任务', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await setup(t, { beforeResponse: async ({ path, body }) => {
    if (path === '/_api/schedule/discover' && body?.followupId === 'a') await gate;
  } }), { page } = h;
  await card(page, 'a').getByRole('button', { name: '换角度', exact: true }).click();
  await done(h, []);
  await topicAction(page, 'b', '找一个子题');
  await page.waitForFunction(() => document.querySelector('#discMsg').textContent.includes('运行慢？b'));
  const response = page.waitForResponse(response => response.url().endsWith('/_api/schedule/discover') && response.request().method() === 'POST' && response.request().postDataJSON().followupId === 'a');
  release();
  // 等待迟到的HTTP响应处理，不使用付费检索或固定睡眠。
  await response;
  assert.match(await page.textContent('#discMsg'), /运行慢？b/);
  assert.deepEqual(h.errors, []);
});

test('任务完成后读取候选失败会重试读取，不重新提交检索', async t => {
  const h = await setup(t), { page } = h;
  await card(page, 'a').getByRole('button', { name: '换角度', exact: true }).click();
  h.job = { view: { state: 'done' }, job: { ...h.job.job, results: [topic('alt')] } };
  h.failTopics = true;
  await page.waitForFunction(() => document.querySelector('#discActionMsg').textContent.includes('将重试读取'), { timeout: 10000 });
  h.failTopics = false; h.topics.push({ ...topic('alt'), parentId: 'a', status: 'suggestion', followup: 'different' }); h.revision++;
  await page.waitForSelector('#discCandidates [data-topic-id="alt"]', { timeout: 10000 });
  assert.equal(posts(h, '/_api/schedule/discover').length, 1);
  assert.deepEqual(h.errors, []);
});

test('移动布局和展开建议/历史/备注无溢出；恢复已有任务只轮询不重发', async t => {
  const h = await setup(t, { width: 320, job: { view: { state: 'running', text: '恢复已有任务' }, job: { followupId: 'a', followup: 'different', results: [] } } }), { page } = h;
  await page.waitForFunction(() => document.querySelector('#discMsg').textContent.includes('其他候选保持不变'));
  assert.equal(posts(h).length, 0);
  await topicAction(page, 'b', '不感兴趣'); await page.waitForSelector('[data-receipt-id="b"]');
  await receipt(page, 'b').getByRole('button', { name: '补充原因' }).click(); await receipt(page, 'b').locator('textarea').fill('备注'.repeat(100));
  await settings(page); await page.click('#discPreferencesToggle'); await openHistory(page);
  for (const width of [320, 375, 768, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no overflow at ' + width); }
  assert.deepEqual(h.errors, []);
});

test('面板可只用注入API独立挂载：无需队列DOM，订阅可解除', async t => {
  const browser = await launchBrowser(chromium, { headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/favicon.ico') return route.fulfill({ status: 204 });
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(new URL('index.html', WWW), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') });
    if (p.startsWith('/_vh/')) {
      const file = new URL(p.slice(5), WWW);
      if (file.href.startsWith(WWW.href) && fs.existsSync(file)) return route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
    }
    requests.push(p); return route.abort();
  });
  await page.goto('http://isolated.test/');
  await page.evaluate(async item => {
    const root = document.querySelector('#discoveryPanel').cloneNode(true); document.body.replaceChildren(root);
    const { attachDiscoveryPanel } = await import('/_vh/discovery-panel.mjs');
    const h = window.isolated = { revision: 0, refreshes: 0, views: 0, reads: 0, unsubscribed: false, item };
    const state = () => ({ revision: h.revision, topics: [h.item], candidates: h.item.status === 'candidate' ? [h.item] : [], suggestions: [], history: h.item.status === 'queued' ? [h.item] : [], historyTotal: h.item.status === 'queued' ? 1 : 0, preferences: {}, config: {} });
    h.panel = attachDiscoveryPanel(root, {
      api: { topics: async () => { h.reads++; return state(); }, job: async () => ({ job: null, view: { state: 'idle' } }),
        update: async () => { h.item = { ...h.item, status: 'queued', queueId: 'q-a', inQueue: true, queueState: 'present' }; h.revision++; return state(); },
        search: async () => { throw Error('not used'); } },
      refreshQueue: async () => { h.refreshes++; }, showQueue: () => { h.views++; },
      subscribeQueueChanges: callback => { h.signal = callback; return () => { h.unsubscribed = true; h.signal = null; }; },
    });
    await h.panel.ready;
  }, topic('a'));
  assert.equal(await page.locator('#queueList').count(), 0);
  const initialRefreshes = await page.evaluate(() => window.isolated.refreshes);
  await card(page, 'a').getByRole('button', { name: '想做并加入队列', exact: true }).click();
  await receipt(page, 'a').getByRole('button', { name: '查看待做队列' }).click();
  assert.deepEqual(await page.evaluate(() => [window.isolated.refreshes, window.isolated.views]), [initialRefreshes + 1, 1]);
  const reads = await page.evaluate(() => { const h = window.isolated; h.item.inQueue = false; h.item.queueState = 'removed'; const reads = h.reads; h.signal(); return reads; });
  await page.waitForFunction(n => window.isolated.reads > n && document.querySelector('#discHistoryList .topic-state').textContent.includes('目前已移出'), reads);
  await page.evaluate(() => window.isolated.panel.dispose());
  assert.equal(await page.evaluate(() => window.isolated.unsubscribed), true);
  assert.deepEqual(requests, []); assert.deepEqual(errors, []);
});

test('新材料简洁显示类型/来源/日期，详细原文按需展开；旧推荐不冒充核实结果', async t => {
  const quote = 'This original report describes a concrete process, its measurements and limitations. <img src=x onerror="alert(1)">';
  const item = { ...topic('rich'), why: '材料看点', research: { version: 1, kind: 'news', checkedAt: 123,
    selectionReason: '研究公开了输入与测量方法，适合解释具体任务里的取舍。', recordPath: 'out/topic-research/abc-123.json', caveats: ['测量不代表全部场景'],
    sources: [{ url: 'https://example.com/report', title: '原始研究报告', sourceType: 'primary', quote, supports: '比较相同任务的两个条件，不推出所有情况。',
      eventDate: '2026-11-07', publishedAt: '2026-11-09', publicationQuote: 'Published: 2026-11-09', eventQuote: 'On 2026-11-07 the team released its measurements.' }] } };
  const h = await setup(t, { width: 375, extra: [item] }), { page } = h;
  const rich = card(page, 'rich');
  assert.match(await rich.locator('.topic-summary').textContent(), /公开了输入/);
  assert.match(await rich.locator('.topic-evidence-meta').textContent(), /新闻进展.*example.com.*事件 2026-11-07/);
  assert.equal(await rich.locator('blockquote').isVisible(), false);
  assert.match(await card(page, 'a').locator('.topic-evidence-meta').textContent(), /旧推荐.*未记录/);
  await rich.locator('.topic-explanation > summary').click();
  assert.equal(await rich.locator('blockquote').textContent(), quote);
  assert.equal(await rich.locator('blockquote img').count(), 0);
  assert.match(await rich.locator('.topic-evidence').textContent(), /不等于独立事实核证/);
  assert.match(await rich.locator('.topic-evidence').textContent(), /发表：2026-11-09.*事件：2026-11-07/);
  assert.match(await rich.locator('.topic-evidence').textContent(), /测量不代表全部场景/);
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  assert.deepEqual(h.errors, []); assert.deepEqual(posts(h), []);
});
