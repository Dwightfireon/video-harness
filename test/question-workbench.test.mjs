import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { startServer } from '../lib/server.mjs';
import { readSchedule, writeSchedule, topicBrief } from '../lib/schedule.mjs';
import { topicState } from '../lib/topic-memory.mjs';

const WWW = new URL('../www/', import.meta.url);

test('历史先分页再读取依据，当前回包复用同一条资格判断，不扫描未返回的研究正文', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-question-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordPath = 'out/topic-research/abc123.json', url = 'https://research.test/workflow';
  fs.mkdirSync(path.join(root, 'out/topic-research'), { recursive: true });
  fs.writeFileSync(path.join(root, recordPath), JSON.stringify({ version: 1 }));
  const topics = Array.from({ length: 150 }, (_, index) => ({ id: 'old-' + index, topic: '历史问题' + index, at: index + 1, status: 'archived', sources: [url],
    question: { version: 1, audience: '普通用户', value: '解释一个具体问题的价值', investigate: ['检查具体前提', '比较不同条件'], premises: [] },
    researchAssessment: { version: 1, status: 'leads', finding: '过去保存的研究判断', gaps: [], suggestedQuestion: '' },
    research: { version: 1, kind: 'evergreen', recordPath, selectionReason: '历史材料', sources: [{ url, quote: '历史摘录', supports: '历史判断' }] } }));
  writeSchedule(root, { ...readSchedule(root), discoveryTopics: topics });
  const archiveFile = fs.realpathSync(path.join(root, recordPath));
  const originalRead = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (String(file) === archiveFile) reads++;
    return originalRead.call(this, file, ...args);
  });
  const state = topicState(root, { limit: 1, historyLimit: 1, historyOffset: 149 });
  assert.equal(state.historyTotal, 150);
  assert.equal(state.topics.length, 1); assert.equal(state.history.length, 1);
  assert.equal(reads, 2, '只校验回包中两条不同记录，不读取其他148条');
  reads = 0;
  topicState(root, { limit: 1, historyLimit: 1, historyOffset: 0 });
  assert.equal(reads, 1, '兼容topics与当前history包含同一记录时，只读取一次');
});

test('真实HTTP与工作进程：无来源问题先保存，绕过调查被拒，按题调查后人工入队', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-question-workbench-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const item = { topic: 'AI 工具省下的时间去了哪里？', subject: '工作中的 AI 工具', coreQuestion: 'AI 工具省下的时间，为什么未必变成更少的工作？',
    why: '理解省时与实际工作量之间的关系，帮助普通用户判断工具是否减轻了负担。', difference: '关注使用后的任务安排，不比较工具排行榜。',
    question: { version: 1, audience: '使用 AI 工具的普通上班族', value: '理解省时与实际工作量之间的关系，帮助判断工具是否减轻了负担。',
      investigate: ['比较相同任务使用工具前后的时间', '检查任务数量和交付要求的变化'], premises: ['使用工具后是否更忙尚未确认，不能假定所有人的情况相同。'] } };
  const executable = path.join(root, 'fake-opencode');
  const url = 'https://research.test/workflow', body = '这份案例记录了同一类工作任务在使用辅助工具前后的安排。任务处理时间有所变化，但交付要求和任务数量也可能不同，因此需要区分具体任务和人群，不能把单一案例外推到所有工作场景。';
  const researched = { ...item, sources: [url], kind: 'evergreen', outline: '先比较相同任务的处理步骤，再核对任务数量和交付要求的变化。', selectionReason: '案例保留了具体流程及适用限制，可作为进一步调查任务变化的起点。',
    researchAssessment: { version: 1, status: 'leads', finding: '取得一个具体流程案例，但仍需核对适用范围。', gaps: ['缺少不同岗位的对照'], suggestedQuestion: '' },
    evidence: [{ url, title: '任务流程案例', sourceType: 'reporting', quote: body, supports: '为调查处理时间与任务安排之间的变化提供一个案例，不推出普遍因果。', publishedAt: null, publicationQuote: '', eventDate: null, eventQuote: '' }] };
  const researchEvents = [
    ...['辅助工具 任务耗时 工作流程', '辅助工具 任务数量 交付要求'].map(query => ({ type: 'tool_use', part: { tool: 'websearch', state: { status: 'completed', input: { query }, output: '任务流程案例 ' + url } } })),
    { type: 'tool_use', part: { tool: 'webfetch', state: { status: 'completed', input: { url }, output: body } } },
    { type: 'text', part: { text: JSON.stringify([researched]) } },
  ];
  fs.writeFileSync(path.join(root, 'answer.json'), JSON.stringify([item]));
  fs.writeFileSync(path.join(root, 'research-events.json'), JSON.stringify(researchEvents));
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const research = fs.existsSync('model-called');
fs.writeFileSync('model-called', research ? 'research' : 'questions');
const events = research ? JSON.parse(fs.readFileSync('research-events.json', 'utf8')) : [{ type: 'text', part: { text: fs.readFileSync('answer.json', 'utf8') } }];
for (const event of events) console.log(JSON.stringify(event));
`, { mode: 0o755 });
  const previous = process.env.VH_OPENCODE_BIN; process.env.VH_OPENCODE_BIN = executable;
  t.after(() => { if (previous === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = previous; });
  writeSchedule(root, { ...readSchedule(root), discoveryConfig: { model: 'fixture/model', query: 'AI 工具与普通人的工作', count: 3 } });
  const server = startServer(null, 0, { root, home, providerInfo: () => [] });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser(chromium, { headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (url.origin !== base) return route.abort();
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(new URL('index.html', WWW), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') });
    if (p.startsWith('/_vh/')) {
      const file = new URL(p.slice(5), WWW);
      if (file.href.startsWith(WWW.href) && fs.existsSync(file)) return route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
    }
    if (p.startsWith('/_api/schedule/discover')) {
      if (request.method() === 'POST') posts.push({ path: p, body: request.postDataJSON() });
      return route.continue();
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto(base);
  await page.evaluate(async () => {
    document.querySelector('#queueBox').open = true;
    const { attachDiscoveryPanel } = await import('/_vh/discovery-panel.mjs');
    const request = async (url, options) => {
      const response = await fetch(url, options), value = await response.json();
      if (!response.ok) throw new Error(value.error || value.reason || 'request failed');
      return value;
    };
    window.questionPanel = attachDiscoveryPanel(document.querySelector('#discoveryPanel'), { request, pollMs: 50 });
    await window.questionPanel.ready;
  });
  await page.click('#discBtn');
  await page.waitForSelector('#discCandidates > article', { timeout: 20000 });
  const card = page.locator('#discCandidates > article');
  assert.equal(await card.locator(':scope > h3').textContent(), item.coreQuestion);
  assert.match(await card.locator('.topic-evidence-meta').textContent(), /尚未调查/);
  assert.equal(await card.getByRole('button', { name: '调查此题', exact: true }).isVisible(), true);
  assert.equal(await card.getByRole('button', { name: '想做并加入队列', exact: true }).isVisible(), false);
  const saved = readSchedule(root).discoveryTopics[0];
  assert.equal(saved.question.version, 1);
  assert.equal(saved.research, undefined);
  assert.equal(readSchedule(root).items.length, 0);
  const response = await fetch(base + '/_api/schedule/discover/topics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept', id: saved.id }) });
  assert.equal(response.status, 409, '直接调用接口不能跳过调查');
  assert.equal(readSchedule(root).items.length, 0);
  assert.equal(posts.filter(call => call.path === '/_api/schedule/discover').length, 1, '不隐式执行第二次调查');
  await page.waitForFunction(() => !document.querySelector('#discBtn').disabled);
  await card.getByRole('button', { name: '调查此题', exact: true }).click();
  await card.getByRole('button', { name: '想做并加入队列', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(readSchedule(root).items.length, 0, '调查完成不自动入队');
  assert.equal(await card.locator(':scope > h3').textContent(), item.coreQuestion, '原题不被调查替换');
  assert.match(await card.locator('.topic-evidence-meta').textContent(), /已有研究线索/);
  const researchPost = posts.filter(call => call.path === '/_api/schedule/discover').at(-1).body;
  assert.deepEqual(researchPost, { operation: 'research', topicId: saved.id });
  await card.getByRole('button', { name: '想做并加入队列', exact: true }).click();
  await page.waitForSelector('[data-receipt-id]');
  const queued = readSchedule(root).items;
  assert.equal(queued.length, 1); assert.equal(queued[0].question.version, 1);
  assert.match(topicBrief(queued[0]), /调查方向/);
  assert.match(topicBrief(queued[0]), /缺少不同岗位/);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.questionPanel.dispose());
});
