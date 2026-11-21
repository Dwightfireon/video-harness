import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { startServer } from '../lib/server.mjs';
import { writeSchedule, readSchedule, topicBrief } from '../lib/schedule.mjs';
import { discoveryFixtureEvents } from './helpers/discovery-fixture.mjs';

test('真实界面与HTTP/后台任务联调：先提问题再调查，来源随入队，刷新保留反馈', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-discovery-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const fake = path.join(root, 'fake-opencode');
  const result = [{ topic: '本地模型推理为什么受带宽限制？', subject: '本地推理', coreQuestion: '本地模型推理受内存带宽怎样的限制？',
    why: '从具体运行过程理解性能瓶颈', outline: '从权重搬运过程讲起，再讨论适用范围。', difference: '不做产品新闻，解释机制。', angle: '机制', sources: ['https://example.test/bandwidth'] },
  { topic: '什么任务适合离线模型？', subject: '离线任务', coreQuestion: '离线模型适合什么任务？', why: '帮助选择任务', outline: '比较不同任务的实际要求。', difference: '与性能机制题不同，讨论任务选择。', sources: ['https://example.test/offline'] }].map(item => ({ ...item,
    question: { version: 1, audience: '想尝试本地模型的普通用户', value: item.why,
      investigate: ['检查这一任务的具体过程与前提', '比较不同条件与适用范围'], premises: ['原问题的适用范围需要结合具体场景核对。'] } }));
  const modelOutput = (candidates, research = false) => {
    const events = research ? discoveryFixtureEvents(candidates.map(item => ({ ...item, researchAssessment: { version: 1, status: 'leads', finding: '已有具体过程的原文线索，仍需核对适用范围。', gaps: ['需要核对其他使用场景'], suggestedQuestion: '' } })))
      : [{ type: 'text', part: { text: JSON.stringify(candidates) } }];
    return '#!/usr/bin/env node\nfor(const event of ' + JSON.stringify(events) + ') console.log(JSON.stringify(event));\n';
  };
  fs.writeFileSync(fake, modelOutput(result), { mode: 0o755 });
  const previous = process.env.VH_OPENCODE_BIN;
  process.env.VH_OPENCODE_BIN = fake;
  t.after(() => { if (previous === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = previous; });
  writeSchedule(root, { items: [], runs: [], discovery: [], discoveryConfig: { query: '本地模型', count: 2, enabled: false, autoQueue: true, timeoutMs: 5000, model: 'fixture/model' } });
  const server = startServer(root, 0, { root, home, providerInfo: () => [] });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await launchBrowser(chromium, { headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.locator('#queueBox > summary').click();
  await page.waitForFunction(() => document.querySelector('#discQuery').value === '本地模型');
  await page.locator('#discoverySettings > summary').click();
  await page.selectOption('#discMode', 'explore');
  await page.click('#discBtn');
  await page.waitForFunction(() => document.querySelectorAll('#discCandidates article').length === 2);
  assert.equal(readSchedule(root).items.length, 0, 'manual search ignores automatic queue switch');
  assert.equal(readSchedule(root).discoveryTopics.length, 2);
  assert.equal(readSchedule(root).discoveryTopics[0].mode, 'explore');
  assert.deepEqual(readSchedule(root).discoveryTopics[0].sources, [], '构思不能自报已取得来源');
  assert.equal(readSchedule(root).discoveryTopics[0].research, undefined);
  if (process.env.VH_DESIGN_SCREENSHOTS) {
    fs.mkdirSync(process.env.VH_DESIGN_SCREENSHOTS, { recursive: true });
    await page.locator('#discoveryPanel').screenshot({ path: path.join(process.env.VH_DESIGN_SCREENSHOTS, 'topic-discovery-desktop.png') });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.locator('#discoveryPanel').screenshot({ path: path.join(process.env.VH_DESIGN_SCREENSHOTS, 'topic-discovery-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
  const first = page.locator('#discCandidates > article').first();
  assert.equal(await first.getByRole('button', { name: '想做并加入队列', exact: true }).isVisible(), false);
  fs.writeFileSync(fake, modelOutput([result[0]], true), { mode: 0o755 });
  await first.getByRole('button', { name: '调查此题', exact: true }).click();
  await first.getByRole('button', { name: '想做并加入队列', exact: true }).waitFor({ state: 'visible' });
  assert.equal(readSchedule(root).items.length, 0, '调查不自动入队');
  await first.getByRole('button', { name: '想做并加入队列', exact: true }).click();
  await page.waitForSelector('#queueList .queue-item', { state: 'attached' });
  const item = readSchedule(root).items[0];
  assert.equal(item.why, result[0].why);
  assert.equal(item.outline, result[0].outline);
  assert.deepEqual(item.sources, result[0].sources);
  assert.deepEqual(item.question, result[0].question);
  assert.equal(item.researchAssessment.status, 'leads');
  assert.match(topicBrief(item), /https:\/\/example.test\/bandwidth/);
  assert.equal(fs.existsSync(path.join(root, 'projects')), false, 'accept does not start production');
  let remaining = page.locator('#discCandidates > article').first();
  const originalId = await remaining.getAttribute('data-topic-id');
  const replacement = { ...result[1], topic: '离线模型能否处理含隐私的文档？', coreQuestion: '哪些隐私文档适合完全离线处理？', sources: ['https://example.test/privacy'] };
  fs.writeFileSync(fake, modelOutput([replacement, result[0]]), { mode: 0o755 });
  await page.fill('#discQuery', '无关方向不应污染单题'); await page.fill('#discCount', '10');
  await remaining.getByRole('button', { name: '换角度', exact: true }).click();
  await page.waitForSelector(`[data-topic-id="${originalId}"] .topic-suggestion`);
  const suggestion = readSchedule(root).discoveryTopics.find(record => record.status === 'suggestion');
  assert.equal(suggestion.parentId, originalId); assert.equal(suggestion.query, '本地模型');
  assert.equal(readSchedule(root).discoveryTopics.filter(record => record.status === 'suggestion').length, 1);
  assert.equal(readSchedule(root).discoveryTopics.find(record => record.id === originalId).status, 'candidate');
  assert.equal(readSchedule(root).items.length, 1);
  if (process.env.VH_DESIGN_SCREENSHOTS) {
    await page.locator('#discoveryPanel').screenshot({ path: path.join(process.env.VH_DESIGN_SCREENSHOTS, 'topic-single-suggestion-desktop.png') });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.locator('#discoveryPanel').screenshot({ path: path.join(process.env.VH_DESIGN_SCREENSHOTS, 'topic-single-suggestion-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
  await page.locator(`[data-topic-id="${suggestion.id}"]`).getByRole('button', { name: '采用这个角度' }).click();
  await page.waitForSelector(`#discCandidates > [data-topic-id="${suggestion.id}"]`);
  assert.equal(readSchedule(root).discoveryTopics.find(record => record.id === originalId).status, 'superseded');
  remaining = page.locator(`#discCandidates > [data-topic-id="${suggestion.id}"]`);
  const remainingId = suggestion.id;
  await remaining.locator('.topic-more > summary').click();
  await remaining.getByRole('button', { name: '不感兴趣', exact: true }).click();
  const receipt = page.locator(`[data-receipt-id="${remainingId}"]`);
  await receipt.getByRole('button', { name: '补充原因' }).click();
  await receipt.locator('select').selectOption('题目太泛');
  await receipt.locator('textarea').fill('希望对象更具体');
  await receipt.getByRole('button', { name: '保存反馈说明', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#discActionMsg').textContent.includes('反馈说明已保存'));
  await page.reload();
  await page.locator('#queueBox > summary').click();
  await page.click('#discHistoryToggle');
  await page.waitForFunction(() => document.querySelector('#discHistoryList').textContent.includes('希望对象更具体'));
  assert.equal(readSchedule(root).items.length, 1);
  await page.click('#queueTab');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#queueList .queue-item').getByRole('button', { name: '移除', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#discHistoryList .topic-state')?.textContent.includes('目前已移出') || [...document.querySelectorAll('#discHistoryList .topic-state')].some(el => el.textContent.includes('目前已移出')));
  await page.click('#ideasTab');
  const queuedHistory = page.locator(`[data-topic-id="${item.discoveryId}"]`);
  await queuedHistory.locator(':scope > details > summary').click();
  await queuedHistory.getByRole('button', { name: '重新加入队列' }).click();
  await page.waitForSelector('#queueList .queue-item', { state: 'attached' });
  assert.equal(readSchedule(root).items.length, 1);
  assert.deepEqual(errors, []);
});
