import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { launchBrowser } from '../lib/browser.mjs';
import { FALLBACK_PARTITIONS, PARTITION_TAXONOMY, HUMAN_PARTITION_TAXONOMY, flattenHumanPartitions } from '../desk/partitions.mjs';
import { createPublishService } from '../desk/service.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}

async function openPage(t) {
  const browser = await launchBrowser(chromium, { headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1240, height: 880 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const files = new Map([
    ['/desk/ui/index.html', ['text/html', new URL('../desk/ui/index.html', import.meta.url)]],
    ['/desk/ui/style.css', ['text/css', new URL('../desk/ui/style.css', import.meta.url)]],
    ['/desk/ui/app.js', ['text/javascript', new URL('../desk/ui/app.js', import.meta.url)]],
    ['/desk/partitions.mjs', ['text/javascript', new URL('../desk/partitions.mjs', import.meta.url)]],
    ['/desk/publish-contract.mjs', ['text/javascript', new URL('../desk/publish-contract.mjs', import.meta.url)]],
    ['/desk/promotion.mjs', ['text/javascript', new URL('../desk/promotion.mjs', import.meta.url)]],
    ['/lib/tags.mjs', ['text/javascript', new URL('../lib/tags.mjs', import.meta.url)]],
    ['/lib/publish-limits.mjs', ['text/javascript', new URL('../lib/publish-limits.mjs', import.meta.url)]],
    ['/lib/publish-audience.mjs', ['text/javascript', new URL('../lib/publish-audience.mjs', import.meta.url)]],
  ]);
  await page.route('**/*', route => {
    const entry = files.get(new URL(route.request().url()).pathname);
    return entry ? route.fulfill({ contentType: entry[0], body: fs.readFileSync(entry[1]) }) : route.abort();
  });
  return { page, errors };
}

test('发布台实际页面：模块加载、AI/Agent 搜索、分组、失效选择清空和提交规则联动', { skip: !chromium && '没有 playwright' }, async t => {
  const { page, errors } = await openPage(t);
  await page.addInitScript(({ list, taxonomy }) => {
    let live = true;
    const draft = { id: 'demo', fields: { title: 'Agent 入门', tags: 'AI Agent', desc: '测试简介' },
      copy: { comment: '测试评论' }, video: { path: '/fake/video.mp4', file: 'video.mp4', kind: '带配音成片', bytes: 123, duration: 60 },
      cover: { ok: false, reason: '测试不上传封面' },
      warnings: [{ code: 'review-pending', text: '发布审阅待核：audio 审阅未执行' }], blockers: [] };
    window.setCatalogOffline = () => { live = false; };
    window.vh = {
      init: async () => ({ version: 'test', account: { loggedIn: true, name: '测试账号（模拟）' },
        projects: localStorage.getItem('desk.test.noProjects') ? [] : [{ id: 'demo', title: 'Agent 入门', hasCopy: true, video: 'video.mp4' }], partitions: list }),
      partitions: async () => ({ live, taxonomy, list, reason: live ? '' : '模拟离线' }),
      draft: async () => draft,
      check: async () => ({ ok: true }),
      plan: async () => ({ payload: null, problems: ['请先选择分区'] }),
      onStep: () => {}, onProgress: () => {}, onPrepareLog: () => {},
      submit: async () => { throw new Error('测试禁止投稿'); },
      openExternal: async () => {},
    };
  }, { list: FALLBACK_PARTITIONS, taxonomy: PARTITION_TAXONOMY });
  await page.goto('http://desk.test/desk/ui/index.html');
  await page.waitForFunction(() => document.querySelector('#fTitle').value === 'Agent 入门' && !document.querySelector('#btnPlan').disabled);
  assert.equal(await page.locator('#btnSubmit').isDisabled(), true);
  assert.match(await page.locator('#submitBlockers').textContent(), /没有选择分区/);
  assert.match(await page.locator('#warnings').textContent(), /audio 审阅未执行/);
  for (const query of ['AI', 'Agent', '人工智能', '计算机科学']) {
    await page.locator('#fPartitionSearch').fill(query);
    assert.match(await page.locator('#fPartition option[value="231"]').textContent(), /科技.*计算机技术/);
    assert.equal(await page.locator('#fPartition').inputValue(), '', '搜索不应代选');
  }
  assert.equal(await page.locator('#fPartition optgroup[label="科技"]').count(), 1);
  await page.locator('#fPartition').selectOption('231');
  assert.match(await page.locator('#partitionAdvice').textContent(), /Agent/);
  assert.equal(await page.locator('#btnSubmit').isEnabled(), true);
  await page.locator('#fTags').fill('x'.repeat(21));
  assert.equal(await page.locator('#btnSubmit').isDisabled(), true);
  assert.match(await page.locator('#submitBlockers').textContent(), /标签超过 20 字/);
  await page.locator('#fTags').fill('DNS、域名解析、计算机网络');
  assert.equal(await page.locator('#btnSubmit').isEnabled(), true);
  await page.locator('summary').click();
  await page.locator('#fCopyright').selectOption('2');
  assert.equal(await page.locator('#btnSubmit').isDisabled(), true);
  await page.locator('#fSource').fill('https://example.com/source');
  assert.equal(await page.locator('#btnSubmit').isEnabled(), true);
  await page.locator('#fCopyright').selectOption('1');
  await page.locator('#fPartitionSearch').fill('AI音乐');
  assert.equal(await page.locator('#fPartition').inputValue(), '');
  assert.equal(await page.locator('#btnSubmit').isDisabled(), true);
  await page.locator('#fPartitionSearch').fill('AI');
  await page.locator('#fPartition').selectOption('231');
  assert.equal(await page.locator('#btnSubmit').isEnabled(), true);
  if (process.env.VH_DESK_TEST_SCREENSHOT) await page.screenshot({ path: process.env.VH_DESK_TEST_SCREENSHOT });
  await page.evaluate(() => window.setCatalogOffline());
  await page.locator('#btnReloadPartitions').click();
  await page.waitForFunction(() => document.querySelector('#partitionNote').textContent.includes('离线参考'));
  assert.equal(await page.locator('#btnSubmit').isDisabled(), true);
  assert.deepEqual(errors, []);
  await page.evaluate(() => localStorage.setItem('desk.test.noProjects', '1'));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#appVersion').textContent === 'vtest');
  assert.equal(await page.locator('#btnSubmit').isDisabled(), true, '没有项目时启动也应禁用提交');
  assert.equal(await page.locator('#btnPlan').isDisabled(), true);
});

test('发布台新版页面：直接选人工智能，真实预览合同包含 human_type2，模式切换清空选择', { skip: !chromium && '没有 playwright' }, async t => {
  const { page, errors } = await openPage(t);
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/desk-partitions-human-type2.json', import.meta.url)));
  let catalog = { live: true, taxonomy: HUMAN_PARTITION_TAXONOMY, list: flattenHumanPartitions(fixture) };
  const draft = { id: 'demo', fields: { title: 'AI Agent 原理', tags: 'AI Agent', desc: '新版分区测试' },
    copy: { comment: '测试用草稿，不投稿' }, video: { path: '/fake/video.mp4', file: 'video.mp4', kind: '带配音成片', bytes: 1024, duration: 60 },
    cover: { ok: false }, warnings: [], blockers: [] };
  const seenForms = [];
  const service = createPublishService({ getDraft: async () => draft,
    getCredentials: () => ({ cookies: { SESSDATA: 'fake', bili_jct: 'fake' } }),
    createClient: () => ({ partitions: async () => catalog }), prepareCover: () => {}, cleanupCover: () => {} });
  await page.exposeFunction('deskTestPartitions', () => service.loadPartitions());
  await page.exposeFunction('deskTestPlan', input => { seenForms.push(input); return service.plan(input); });
  await page.addInitScript(({ list, draft }) => {
    window.vh = {
      init: async () => ({ version: 'test', account: { loggedIn: true, name: '新版界面测试（模拟）' },
        projects: [{ id: 'demo', title: draft.fields.title, hasCopy: true, video: 'video.mp4' }], partitions: list }),
      partitions: () => window.deskTestPartitions(), plan: input => window.deskTestPlan(input), draft: async () => draft,
      check: async () => ({ ok: true }), onStep: () => {}, onProgress: () => {}, onPrepareLog: () => {},
      submit: async () => { throw new Error('本测试禁止真实投稿'); }, openExternal: async () => {},
    };
  }, { list: FALLBACK_PARTITIONS, draft });
  await page.goto('http://desk.test/desk/ui/index.html');
  await page.waitForFunction(() => document.querySelector('#fTitle').value === 'AI Agent 原理' && !document.querySelector('#btnPlan').disabled);
  assert.match(await page.locator('#partitionLabel').textContent(), /新版/);
  assert.equal(await page.locator('#fPartition option[value="231"]').count(), 0);
  for (const query of ['AI', 'Agent', '人工智能']) {
    await page.locator('#fPartitionSearch').fill(query);
    assert.equal(await page.locator('#fPartition option[value="1011"]').count(), 1);
    assert.equal(await page.locator('#fPartition').inputValue(), '');
  }
  await page.locator('#fPartition').selectOption('1011');
  assert.equal(await page.locator('#btnSubmit').isEnabled(), true);
  await page.locator('#btnPlan').click();
  await page.waitForFunction(() => document.querySelector('#planJson').textContent.includes('"human_type2": 1011'));
  assert.match(await page.locator('#planJson').textContent(), /人工智能/);
  assert.match(await page.locator('#planJson').textContent(), /"tid": 21/);
  assert.equal(seenForms.at(-1).humanType2, 1011);
  assert.equal(seenForms.at(-1).partitionTaxonomy, HUMAN_PARTITION_TAXONOMY);
  await page.locator('#fTitle').fill('AI Agent 进阶');
  assert.equal(await page.locator('#planBody').isHidden(), true);
  assert.match(await page.locator('#planEmpty').textContent(), /预览已失效/);
  if (process.env.VH_DESK_HUMAN_SCREENSHOT) await page.screenshot({ path: process.env.VH_DESK_HUMAN_SCREENSHOT });
  // 刷新变为旧模式时，不把上次的 1011 沿用为 tid。
  catalog = { live: true, taxonomy: PARTITION_TAXONOMY, list: FALLBACK_PARTITIONS };
  await page.locator('#btnReloadPartitions').click();
  await page.waitForFunction(() => document.querySelector('#partitionLabel').textContent.includes('旧版'));
  assert.equal(await page.locator('#fPartition').inputValue(), '');
  assert.equal(await page.locator('#planBody').isHidden(), true, '模式切换后不能继续展示旧的预览 JSON');
  assert.equal(await page.locator('#btnSubmit').isDisabled(), true);
  assert.deepEqual(errors, []);
});
