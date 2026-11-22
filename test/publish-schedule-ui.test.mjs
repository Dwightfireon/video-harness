import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { startServer } from '../lib/server.mjs';
import { validateInput } from '../desk/publish-contract.mjs';
import { splitTags } from '../lib/tags.mjs';

const publication = ready => ready
  ? { state: 'ready', label: '可发布', reason: '成片检查通过', eligible: true, waiting: false }
  : { state: 'producing', label: '制作中', reason: '等待制作完成', eligible: false, waiting: true };

async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publish-calendar-ui-'));
  const h = {
    saves: [], plans: [], promotionSaves: [], formSaves: [], submittedInputs: [], referenceIds: [], submits: 0, reads: 0, projectReads: 0, release: null, delay: false,
    delayFormSave: false, releaseFormSave: null, holdPreflight: false, releasePreflight: null, realPlan: options.realPlan || false,
    holdSubmit: false, releaseSubmit: null,
    promotionSaveError: false, promotionCatalogError: false, legacyPromotion: false, legacyMarketing: false, submitResult: null,
    holdPartitions: options.holdPartitions || false, releasePartitions: null,
    loggedIn: options.loggedIn ?? true, partitionsFail: false, overviewFail: false, projectsFail: false,
    scheduleError: options.scheduleError || 0,
    legacyProtocol: options.legacyProtocol || false,
    projects: options.empty ? [] : ['unfinished', 'ready'].map((id, i) => ({ id, title: id, tags: ['AI'], desc: '测试简介', hasCopy: true,
      hasVideo: Boolean(i), video: i ? { bytes: 123, duration: 60, file: 'video.mp4' } : null, warnings: [],
      task: { status: i ? 'completed' : 'running', running: !i, productionBusy: !i }, publication: publication(Boolean(i)) })),
    state: { enabled: false, revision: 0, times: ['20:00'], ids: [], scope: { kind: 'selected' }, partition: null, timezone: 'Asia/Shanghai' },
  };
  function view() {
    const items = h.projects.filter(item => h.state.scope.kind === 'production-queue' || h.state.ids.includes(item.id))
      .map(item => ({ id: item.id, ...item.publication }));
    return { ...h.state, ...(!h.legacyProtocol ? { protocolVersion: options.protocolVersion ?? 3 } : {}), nextSlot: '2026-11-11 20:00',
      pending: { total: items.length, ready: items.filter(item => item.eligible).length, waiting: items.filter(item => item.waiting).length,
        needsAttention: items.filter(item => item.state === 'needs-attention').length, submitted: 0, items },
      calendar: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${10 + i}`, weekday: '二', times: h.state.times })) };
  }
  // 只借用真实页面/静态资源服务；所有发布 API 在浏览器里模拟，不连账号、不投稿。
  const server = startServer(null, 0, { root, home: root, publish: {} });
  await once(server, 'listening');
  const browser = await launchBrowser(chromium);
  t.after(async () => {
    h.release?.();
    h.releasePartitions?.();
    h.releaseFormSave?.(); h.releasePreflight?.();
    h.releaseSubmit?.();
    await browser.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: options.width || 1280, height: 1000 } });
  page.setDefaultTimeout(8000);
  if (options.clock) await page.clock.install();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') void dialog.accept(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/_api/publish/')) return route.continue();
    const endpoint = url.pathname.slice('/_api/publish'.length);
    const reply = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (endpoint === '/schedule') {
      if (h.scheduleError === 'network') return route.abort('connectionfailed');
      if (h.scheduleError) return reply({ error: h.scheduleError === 404 ? '项目不存在' : '排程读取失败' }, h.scheduleError);
      if (req.method() === 'GET') { h.reads++; return reply(view()); }
      const input = req.postDataJSON(); h.saves.push(input);
      if (input.revision !== h.state.revision) return reply({ error: '版本冲突' }, 409);
      if (!['save', 'enable', 'pause'].includes(input.action)) return reply({ error: '必须指定 action' }, 400);
      if (input.action === 'enable' && (!input.confirmed || !h.loggedIn || !input.partition?.tid)) return reply({ error: '启用条件不足' }, 400);
      if (h.delay) await new Promise(resolve => { h.release = resolve; });
      if (input.action !== 'pause') h.state = { ...h.state, times: input.times ?? h.state.times, trigger: input.trigger ?? h.state.trigger,
        ids: input.ids, scope: input.scope, partition: input.partition };
      h.state = { ...h.state, enabled: input.action === 'enable', revision: h.state.revision + 1 };
      return reply(view());
    }
    if (endpoint === '/overview') return h.overviewFail ? reply({ error: '账号连接失败' }, 503) : reply({ accountKey: 'mock-account', account: { loggedIn: h.loggedIn, name: '测试账号' } });
    if (endpoint === '/partitions') {
      if (h.holdPartitions) await new Promise(resolve => { h.releasePartitions = resolve; });
      return h.partitionsFail ? reply({ error: '分区连接失败' }, 503)
        : reply({ live: true, taxonomy: 'legacy-tid', human: false, list: [
          { id: 231, name: '计算机技术', parent: '科技' }, { id: 232, name: '科学科普', parent: '科技' },
        ] });
    }
    if (endpoint === '/projects') {
      h.projectReads++;
      return h.projectsFail ? reply({ error: '项目连接失败' }, 503) : reply({ projects: h.projects });
    }
    if (endpoint === '/references') { h.referenceIds.push(req.postDataJSON().id); return reply({ sources: [] }); }
    if (endpoint === '/promotion-catalog') return h.promotionCatalogError ? reply({ error: '选项不可用' }, 503)
      : reply({ industries: [{ id: 9, name: '软件应用' }], showTypes: [{ id: 11, name: '口播' }, { id: 13, name: '字幕推广' }] });
    if (endpoint === '/promotion') {
      if (h.promotionSaveError) return reply({ error: '模拟保存失败' }, 500);
      const input = req.postDataJSON(); h.promotionSaves.push(input);
      h.projects.find(item => item.id === input.id).promotion = input.promotion;
      return reply({ promotion: input.promotion });
    }
    if (endpoint === '/form') {
      if (h.promotionSaveError) return reply({ error: '模拟保存失败' }, 500);
      const input = req.postDataJSON(), item = h.projects.find(item => item.id === input.id); h.formSaves.push(input);
      if (input.revision !== (item.savedForm?.revision || 0)) return reply({ error: '其他页面已修改投稿资料' }, 409);
      if (h.delayFormSave) await new Promise(resolve => { h.releaseFormSave = resolve; });
      const f = input.form, savedForm = { version: 1, revision: input.revision + 1, savedAt: new Date().toISOString(),
        fields: { title: f.title, desc: f.desc, tags: splitTags(f.tags), cover: f.cover, promotion: f.promotion },
        partition: f.tid ? { partitionTaxonomy: f.partitionTaxonomy, tid: f.tid, humanType2: f.humanType2 } : null };
      Object.assign(item, savedForm.fields, { savedForm, coverWanted: f.cover });
      return reply({ savedForm });
    }
    if (endpoint === '/plan') {
      const input = req.postDataJSON(); h.plans.push(input);
      const item = h.projects.find(item => item.id === input.id);
      const problems = h.realPlan ? validateInput(input, { video: item?.hasVideo ? { path: '/fake/video' } : null, cover: { ok: Boolean(item?.cover) } }) : input.problems || [];
      return reply({ problems, warnings: item?.warnings || [], ready: !problems.length, formSupported: true, promotionSupported: !h.legacyPromotion,
        ...(!h.legacyMarketing ? { promotionProtocolVersion: 2 } : {}) });
    }
    if (endpoint === '/preflight') { if (h.holdPreflight) await new Promise(resolve => { h.releasePreflight = resolve; }); return reply({ ok: true }); }
    if (endpoint === '/progress') return reply(h.progress || { available: false });
    if (endpoint === '/submit' || endpoint === '/batch') {
      h.submits++; h.submittedInputs.push(req.postDataJSON());
      if (h.holdSubmit) await new Promise(resolve => { h.releaseSubmit = resolve; });
      return reply(h.submitResult || { outcome: 'rejected', message: '模拟平台拒绝：请补充推广资料' });
    }
    if (endpoint === '/verify') return reply({ found: true, stateDesc: '已创建', title: '模拟稿件' });
    return reply({ error: '未模拟的 API：' + endpoint }, 400);
  });
  await page.goto(base + '/publish');
  await page.waitForFunction(() => !document.querySelector('#pubScheduleStatus')?.textContent.includes('正在读取'));
  return { h, page, errors, base };
}

const waitNotice = (page, text) => page.waitForFunction(text => document.querySelector('#pubNotice')?.textContent.includes(text), text);

test('成片后投稿：间隔校验、明确授权可立即投稿、刷新恢复，不从界面直接提交', async t => {
  const { h, page, errors } = await setup(t);
  const trigger = page.locator('#pubScheduleTrigger'), interval = page.locator('#pubScheduleInterval');
  await trigger.selectOption('ready'); await interval.fill('29');
  await page.locator('#pubScheduleScope').selectOption('production-queue');
  await page.locator('#pubSchedulePartition').selectOption('legacy-tid:231');
  assert.equal(await page.locator('#pubScheduleTimes').isVisible(), false);
  await page.locator('#pubScheduleEnable').click(); await waitNotice(page, '30–86400');
  assert.equal(h.saves.length, 0);
  await interval.fill('45');
  page.once('dialog', dialog => { assert.match(dialog.message(), /可能立即开始投稿.*至少等 45 秒/); return dialog.accept(); });
  await page.locator('#pubScheduleEnable').click(); await waitNotice(page, '自动发布已启用');
  assert.deepEqual(h.saves[0].trigger, { kind: 'ready', intervalSeconds: 45 });
  assert.equal(h.saves[0].times, undefined);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#pubScheduleStatus').textContent.includes('最短间隔 45 秒'));
  assert.equal(await interval.inputValue(), '45');
  assert.equal(await page.locator('#pubScheduleCalendarWrap').isVisible(), false);
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('仅支持每日时点的旧后端仍可配置原模式，不能静默启用成片后投稿', async t => {
  const { page } = await setup(t, { protocolVersion: 2 });
  assert.equal(await page.locator('#pubScheduleTrigger').isDisabled(), true);
  assert.match(await page.locator('#pubScheduleTriggerHint').textContent(), /需重启/);
  assert.equal(await page.locator('#pubScheduleSave').isEnabled(), true);
});
const queueIds = page => page.locator('#pubScheduleQueue .pub-queue-id').allTextContents();

test('营销标注：旧后端即使支持 porder 也不能当作已接入创作者声明', async t => {
  const { h, page, errors } = await setup(t);
  h.legacyMarketing = true;
  await page.locator('#pubProjects .pub-item').nth(1).click();
  await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubPromotion').check();
  await page.locator('#pubPlanBtn').click();
  await page.waitForFunction(() => document.querySelector('#pubReady').textContent.includes('尚未接入营销内容标注'));
  assert.equal(await page.locator('#pubSubmit').isDisabled(), true);
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('营销标注：收稿与声明确认分开，泛用 BV 查询不能覆盖不符/未核实警告', async t => {
  for (const state of ['confirmed', 'mismatch', 'unverified']) await t.test(state, async t => {
    const { h, page, errors } = await setup(t, { width: state === 'unverified' ? 390 : 1280 });
    const message = state === 'confirmed' ? '平台资料已确认「内容含营销信息」；不代表观众端已显示或审核通过。'
      : state === 'mismatch' ? '平台返回的创作者声明不是「内容含营销信息」。稿件已收下，请人工核对，不要重发。'
        : '营销声明尚未确认。稿件已收下，请人工核对，不要重发。';
    h.submitResult = { ok: true, outcome: 'submitted', bvid: 'BV1234567890',
      declarationVerification: { state, expectedId: 3, actualId: state === 'confirmed' ? 3 : state === 'mismatch' ? -1 : null, message } };
    await page.locator('#pubProjects .pub-item').nth(1).click();
    await page.locator('#pubPartition').selectOption('231');
    await page.locator('#pubPromotion').check();
    await page.locator('#pubPlanBtn').click(); await waitNotice(page, '尚未上传或投稿');
    page.once('dialog', dialog => { assert.match(dialog.message(), /内容含营销信息/); return dialog.accept(); });
    await page.locator('#pubSubmit').click();
    await waitNotice(page, '已在稿件管理确认');
    const notice = await page.locator('#pubNotice').textContent();
    assert.match(notice, state === 'confirmed' ? /平台资料已确认/ : state === 'mismatch' ? /声明不是/ : /尚未确认/);
    assert.equal(await page.locator('#pubNotice').evaluate(node => node.classList.contains('bad')), state !== 'confirmed');
    assert.equal(h.submits, 1); assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.VH_PUBLISH_MARKETING_SCREENSHOTS) {
      fs.mkdirSync(process.env.VH_PUBLISH_MARKETING_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.VH_PUBLISH_MARKETING_SCREENSHOTS, state + '.png') });
    }
  });
});

test('投稿资料：未保存修改跨作品和刷新保留；统一保存并回填，不启用排程', async t => {
  const { h, page, errors } = await setup(t);
  await page.locator('#pubProjects .pub-item').nth(1).click();
  await page.locator('#pubTitle').fill('手动编辑的标题');
  await page.locator('#pubDesc').fill('手动编辑的简介');
  await page.locator('#pubTags').fill('测试 网站');
  await page.locator('#pubCover').uncheck();
  await page.locator('#pubPromotion').check();
  await page.locator('#pubPromotionBrand').fill('自己的网站');
  await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubProjects .pub-item').nth(0).click();
  await page.locator('#pubProjects .pub-item').nth(1).click();
  assert.equal(await page.locator('#pubTitle').inputValue(), '手动编辑的标题');
  assert.equal(await page.locator('#pubPromotionBrand').inputValue(), '自己的网站');
  assert.equal(await page.locator('#pubCover').isChecked(), false);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#pubProjects .pub-item'));
  await page.locator('#pubProjects .pub-item').nth(1).click();
  assert.equal(await page.locator('#pubTitle').inputValue(), '手动编辑的标题');
  assert.equal(await page.locator('#pubDesc').inputValue(), '手动编辑的简介');
  assert.equal(await page.locator('#pubPartition').inputValue(), '231');
  assert.match(await page.locator('#pubFormStatus').textContent(), /尚未保存/);
  await page.locator('#pubSaveForm').click(); await waitNotice(page, '投稿资料已保存');
  assert.equal(h.formSaves[0].form.title, '手动编辑的标题');
  assert.equal(h.formSaves[0].form.cover, false); assert.equal(h.formSaves[0].form.promotion.enabled, true);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#pubProjects .pub-item'));
  await page.locator('#pubProjects .pub-item').nth(1).click();
  assert.equal(await page.locator('#pubTitle').inputValue(), '手动编辑的标题');
  assert.equal(await page.locator('#pubCover').isChecked(), false);
  assert.match(await page.locator('#pubFormStatus').textContent(), /已保存至本机/);
  assert.equal(h.state.enabled, false); assert.equal(h.submits, 0); assert.deepEqual(errors, []);
  if (process.env.VH_PUBLISH_OPTIMIZATION_SCREENSHOTS) {
    fs.mkdirSync(process.env.VH_PUBLISH_OPTIMIZATION_SCREENSHOTS, { recursive: true });
    await page.locator('#pubSaveForm').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(process.env.VH_PUBLISH_OPTIMIZATION_SCREENSHOTS, 'saved-form-desktop.png') });
  }
});

test('投稿资料：保存期间新增编辑不被回包覆盖，版本冲突保留编辑，主动读取可恢复', async t => {
  const { h, page, errors } = await setup(t);
  await page.locator('#pubProjects .pub-item').nth(1).click();
  await page.locator('#pubTitle').fill('保存的版本'); h.delayFormSave = true;
  await page.locator('#pubSaveForm').click();
  await page.waitForFunction(() => document.querySelector('#pubSaveForm').disabled);
  await page.locator('#pubTitle').fill('保存中继续编辑');
  h.releaseFormSave(); h.delayFormSave = false; await waitNotice(page, '新增的修改仍未保存');
  assert.equal(await page.locator('#pubTitle').inputValue(), '保存中继续编辑');
  const item = h.projects.find(item => item.id === 'ready'); item.savedForm.revision++; item.savedForm.fields.title = '其他页面保存'; item.title = '其他页面保存';
  await page.locator('#pubSaveForm').click(); await waitNotice(page, '其他页面已修改');
  assert.equal(await page.locator('#pubTitle').inputValue(), '保存中继续编辑');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#pubRestoreForm').click(); await waitNotice(page, '已载入服务器');
  assert.equal(await page.locator('#pubTitle').inputValue(), '其他页面保存');
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('缺封面：取消上传可操作，实际校验与摘要一致；状态不冒充平台审核通过', async t => {
  const { h, page, errors } = await setup(t, { realPlan: true, width: 390 });
  await page.locator('#pubProjects .pub-item').nth(1).click(); await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubPlanBtn').click(); await page.waitForFunction(() => document.querySelector('#pubReady').textContent.includes('没有可用封面'));
  assert.equal(await page.locator('#pubCover').isEnabled(), true);
  await page.locator('#pubCover').uncheck(); await page.locator('#pubPlanBtn').click();
  await page.waitForFunction(() => document.querySelector('#pubReady').textContent.includes('当前表单可提交'));
  assert.equal(await page.locator('#pubSubmit').isEnabled(), true);
  assert.match(await page.locator('#pubSummary').textContent(), /本次不上传封面/);
  assert.match(await page.locator('#pubReadyBadge').textContent(), /当前表单可提交/);
  assert.equal(await page.locator('#pubCoverBox').evaluate(node => node.classList.contains('bad')), false);
  assert.doesNotMatch(await page.locator('#pubIssues').textContent(), /没有可用封面/);
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.VH_PUBLISH_OPTIMIZATION_SCREENSHOTS) {
    fs.mkdirSync(process.env.VH_PUBLISH_OPTIMIZATION_SCREENSHOTS, { recursive: true });
    await page.locator('#pubSaveForm').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(process.env.VH_PUBLISH_OPTIMIZATION_SCREENSHOTS, 'optional-cover-mobile.png') });
  }
});

test('提交预检即冻结快照和表单，不能中途切换作品，取消确认后恢复', async t => {
  const { h, page, errors } = await setup(t);
  await page.locator('#pubProjects .pub-item').nth(1).click(); await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubPlanBtn').click(); await waitNotice(page, '尚未上传或投稿');
  h.holdPreflight = true;
  await page.locator('#pubSubmit').click();
  await page.waitForFunction(() => document.querySelector('#pubTitle').disabled);
  assert.equal(await page.locator('#pubPartition').isDisabled(), true);
  await page.locator('#pubProjects .pub-item').nth(0).click(); await waitNotice(page, '请等本次处理结束');
  assert.equal(await page.locator('#pubTitle').inputValue(), 'ready');
  page.once('dialog', dialog => { assert.match(dialog.message(), /作品：ready/); return dialog.dismiss(); });
  h.releasePreflight();
  await page.waitForFunction(() => !document.querySelector('#pubTitle').disabled);
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('网页真实进度按字节显示，不用计时器编造百分比；失败不自动重提', async t => {
  const { h, page, errors } = await setup(t);
  await page.locator('#pubProjects .pub-item').nth(1).click(); await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubPlanBtn').click(); await waitNotice(page, '尚未上传或投稿');
  h.holdSubmit = true; h.progress = { available: true, stage: '上传视频', bytes: 10, total: 20, elapsedMs: 2000 };
  page.once('dialog', dialog => dialog.accept()); await page.locator('#pubSubmit').click();
  await page.waitForFunction(() => document.querySelector('#pubUploadInfo').textContent.includes('50%'));
  assert.equal(await page.locator('#pubUploadBar').getAttribute('value'), '50');
  assert.equal(await page.locator('#pubTitle').isDisabled(), true);
  h.progress = { ...h.progress, stage: '提交投稿', bytes: 20, elapsedMs: 3000 };
  await page.waitForFunction(() => document.querySelector('#pubUploadStage').textContent === '提交投稿');
  h.releaseSubmit(); await waitNotice(page, '请补充推广资料');
  assert.equal(h.submits, 1); assert.equal(await page.locator('#pubTitle').isEnabled(), true); assert.deepEqual(errors, []);
});

test('商业声明：桌面/手机可只勾选不填资料，按作品保存、切换与刷新回填，不自动投稿', async t => {
  for (const width of [1280, 390]) await t.test(String(width), async t => {
    const { h, page, errors } = await setup(t, { width });
    await page.locator('#pubProjects .pub-item').nth(1).click();
    await page.locator('#pubPromotion').check();
    await page.waitForFunction(() => document.querySelector('#pubPromotionCatalogStatus').textContent.includes('选项来自'));
    assert.match(await page.locator('.pub-promotion').textContent(), /品牌 \/ 网站名称（选填）/);
    for (const id of ['pubPromotionBrand', 'pubPromotionIndustry']) assert.equal(await page.locator('#' + id).getAttribute('required'), null);
    assert.match(await page.locator('#pubFormStatus').textContent(), /尚未保存/);
    assert.equal(await page.locator('#pubPromotionBrand').inputValue(), '');
    assert.equal(await page.locator('#pubPromotionIndustry').inputValue(), '');
    assert.equal(await page.locator('#pubPromotionTypes input:checked').count(), 0);
    await page.locator('#pubSaveForm').click(); await waitNotice(page, '投稿资料已保存');
    assert.equal(h.formSaves[0].id, 'ready');
    assert.deepEqual(h.formSaves[0].form.promotion, { enabled: true, brandName: '', industryId: null, showTypes: [] });
    await page.locator('#pubProjects .pub-item').nth(0).click(); assert.equal(await page.locator('#pubPromotion').isChecked(), false);
    await page.locator('#pubProjects .pub-item').nth(1).click(); assert.equal(await page.locator('#pubPromotion').isChecked(), true);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#pubScheduleStatus').textContent.includes('已暂停'));
    await page.locator('#pubProjects .pub-item').nth(1).click(); assert.equal(await page.locator('#pubPromotion').isChecked(), true);
    await page.locator('#pubPromotion').scrollIntoViewIfNeeded();
    if (process.env.VH_PROMOTION_SCREENSHOTS) {
      fs.mkdirSync(process.env.VH_PROMOTION_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.VH_PROMOTION_SCREENSHOTS, `promotion-${width}.png`) });
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false); assert.equal(h.submits, 0); assert.deepEqual(errors, []);
  });
});

test('商业声明：网站名/行业/形式进入预览与单次模拟提交，平台拒绝不去掉声明重发', async t => {
  const { h, page, errors } = await setup(t);
  await page.locator('#pubProjects .pub-item').nth(1).click();
  await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubPromotion').check();
  await page.locator('#pubPromotionBrand').fill('我的网站');
  await page.locator('#pubPromotionIndustry').selectOption('9');
  await page.locator('#pubPromotionTypes input[value="11"]').check();
  await page.locator('#pubPlanBtn').click();
  await waitNotice(page, '尚未上传或投稿');
  const expected = { enabled: true, brandName: '我的网站', industryId: 9, showTypes: [11] };
  assert.deepEqual(h.plans.at(-1).promotion, expected);
  assert.match(await page.locator('#pubSummary').textContent(), /含商业推广.*我的网站/);
  page.once('dialog', dialog => { assert.match(dialog.message(), /商业声明：含商业推广.*我的网站/); return dialog.accept(); });
  await page.locator('#pubSubmit').click(); await waitNotice(page, '请补充推广资料');
  assert.equal(h.submits, 1); assert.deepEqual(h.submittedInputs[0].promotion, expected);
  assert.equal(h.submittedInputs[0].expectedAccountKey, 'mock-account');
  assert.equal(h.formSaves.length, 0, '本次手动表单不能偷偷变成排程配置');
  assert.deepEqual(errors, []);
});

test('商业声明：选项不可用仍可留空保存，保存失败如实提示；旧后端不能静默忽略声明', async t => {
  const { h, page, errors } = await setup(t);
  h.promotionCatalogError = true; h.promotionSaveError = true;
  await page.locator('#pubProjects .pub-item').nth(1).click();
  await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubPromotion').check();
  await page.waitForFunction(() => document.querySelector('#pubPromotionCatalogStatus').textContent.includes('暂不可用'));
  await page.locator('#pubSaveForm').click(); await waitNotice(page, '保存失败');
  assert.match(await page.locator('#pubFormStatus').textContent(), /尚未保存/);
  h.promotionSaveError = false; await page.locator('#pubSaveForm').click(); await waitNotice(page, '投稿资料已保存');
  assert.equal(h.formSaves[0].form.promotion.enabled, true);
  h.legacyPromotion = true; await page.locator('#pubPlanBtn').click();
  await page.waitForFunction(() => document.querySelector('#pubReady').textContent.includes('后端尚不支持商业声明'));
  assert.equal(await page.locator('#pubSubmit').isDisabled(), true);
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('旧后端 404 明确提示安全重启，可重试；其他初始化失败不阻塞排程', async t => {
  const { h, page, errors } = await setup(t, { scheduleError: 404 });
  const text = await page.locator('#pubScheduleStatus').textContent();
  assert.match(text, /后端版本过旧/); assert.match(text, /安全重启/); assert.doesNotMatch(text, /项目不存在|已暂停/);
  assert.equal(await page.locator('#pubScheduleSave').isDisabled(), true);
  assert.equal(await page.locator('#pubScheduleRetry').isEnabled(), true);
  h.scheduleError = 0; h.overviewFail = true; h.partitionsFail = true; h.projectsFail = true;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#pubScheduleStatus').textContent.includes('已暂停'));
  await page.waitForFunction(() => document.querySelector('#pubProjectsStatus').textContent.includes('读取项目失败'));
  assert.equal(await page.locator('#pubScheduleSave').isEnabled(), true);
  assert.doesNotMatch(await page.locator('#pubProjects').textContent(), /还没有项目/);
  h.scheduleError = 404; await page.locator('#pubScheduleRetry').click();
  await page.waitForFunction(() => document.querySelector('#pubScheduleStatus').textContent.includes('后端版本过旧'));
  h.scheduleError = 0; await page.locator('#pubScheduleRetry').click();
  await page.waitForFunction(() => document.querySelector('#pubScheduleStatus').textContent.includes('已暂停'));
  assert.equal(h.saves.length, 0); assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('旧版 schedule 200 缺少/低于 protocolVersion 2 禁止所有 action，重启后可重读', async t => {
  const { h, page, errors } = await setup(t, { legacyProtocol: true });
  for (const version of [undefined, 1]) {
    if (version !== undefined) {
      h.state.protocolVersion = version;
      await page.locator('#pubScheduleRetry').click();
      await page.waitForFunction(() => !document.querySelector('#pubScheduleRetry').disabled);
    }
    assert.match(await page.locator('#pubScheduleStatus').textContent(), /前后端版本不一致.*无制作或投稿运行时重启工作台/);
    assert.doesNotMatch(await page.locator('#pubScheduleStatus').textContent(), /已暂停/);
    for (const id of ['pubScheduleSave', 'pubScheduleEnable', 'pubSchedulePause']) {
      assert.equal(await page.locator('#' + id).isDisabled(), true);
      await page.locator('#' + id).evaluate(node => node.onclick());
    }
    assert.equal(h.saves.length, 0, '不可把 action:save 发给旧后端意外启用');
  }
  h.legacyProtocol = false; await page.locator('#pubScheduleRetry').click();
  await page.waitForFunction(() => !document.querySelector('#pubScheduleSave').disabled);
  await page.locator('#pubScheduleSave').click(); await waitNotice(page, '排程已保存');
  assert.equal(h.state.enabled, false); assert.equal(h.saves.length, 1); assert.deepEqual(errors, []);
});

test('未登录、空队列、无分区可保存禁用配置；启用另行校验', async t => {
  const { h, page, errors } = await setup(t, { loggedIn: false, empty: true });
  await page.locator('#pubScheduleSave').click(); await waitNotice(page, '排程已保存');
  assert.equal(h.saves[0].action, 'save'); assert.equal(h.saves[0].partition, null);
  assert.deepEqual(h.saves[0].ids, []); assert.equal(h.state.enabled, false);
  assert.equal(h.saves[0].confirmed, undefined); assert.equal(h.saves[0].enabled, undefined);
  await page.locator('#pubScheduleEnable').click(); await waitNotice(page, '请先登录');
  assert.equal(h.saves.length, 1); assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('保存和启用分离：多时点、顺序、启用确认、空队列及暂停，不立即投稿', async t => {
  const { h, page, errors } = await setup(t);
  assert.equal(await page.locator('#pubInterval').count(), 0);
  assert.equal(await page.locator('.pub-calendar-day').count(), 7);
  await page.locator('#pubPartition').selectOption('232');
  await page.locator('#pubProjects .pub-pick').nth(0).check();
  await page.locator('#pubProjects .pub-pick').nth(1).check();
  await page.getByRole('button', { name: '上移 ready', exact: true }).click();
  assert.deepEqual(await queueIds(page), ['ready', 'unfinished']);
  await page.locator('#pubScheduleAdd').click(); await page.locator('#pubScheduleTimes input').nth(1).fill('12:30');
  await page.locator('#pubScheduleSave').click(); await waitNotice(page, '排程已保存');
  assert.deepEqual(h.saves[0].times, ['20:00', '12:30']); assert.deepEqual(h.saves[0].ids, ['ready', 'unfinished']);
  assert.equal(h.saves[0].partition, null, '单条投稿分区不能进入排程');
  assert.equal(h.state.enabled, false); assert.equal(await page.locator('#pubSchedulePause').isDisabled(), true);
  await page.locator('#pubScheduleEnable').click(); await waitNotice(page, '选择有效分区');
  assert.equal(h.saves.length, 1);
  await page.locator('#pubSchedulePartition').selectOption('legacy-tid:231');
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#pubScheduleEnable').click(); assert.equal(h.saves.length, 1);
  page.once('dialog', dialog => { assert.match(dialog.message(), /只授权显式选定/); return dialog.accept(); });
  await page.locator('#pubScheduleEnable').click(); await waitNotice(page, '自动发布已启用');
  assert.equal(h.saves[1].action, 'enable'); assert.equal(h.saves[1].confirmed, true); assert.equal(h.saves[1].partition.tid, 231);
  assert.equal(await page.locator('#pubSchedulePause').isEnabled(), true);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#pubScheduleStatus').textContent.includes('已开启'));
  assert.equal(await page.locator('#pubSchedulePartition').inputValue(), 'legacy-tid:231');
  assert.deepEqual(await queueIds(page), ['ready', 'unfinished']);
  await page.locator('#pubSchedulePause').click(); await waitNotice(page, '已暂停');
  assert.deepEqual(Object.keys(h.saves[2]).sort(), ['action', 'revision']);
  await page.getByRole('button', { name: '移除 ready', exact: true }).click();
  await page.getByRole('button', { name: '移除 unfinished', exact: true }).click();
  page.once('dialog', dialog => { assert.match(dialog.message(), /空队列/); return dialog.accept(); });
  await page.locator('#pubScheduleEnable').click(); await waitNotice(page, '自动发布已启用');
  assert.deepEqual(h.saves[3].ids, []); assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('制作队列等待→ready 周期刷新，新成片/任务可见，dirty 投稿表单与排程不丢', async t => {
  const { h, page, errors } = await setup(t, { clock: true });
  await page.locator('#pubScheduleScope').selectOption('production-queue');
  await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubSchedulePartition').selectOption('legacy-tid:232');
  page.once('dialog', dialog => { assert.match(dialog.message(), /当前及今后制作队列/); return dialog.accept(); });
  await page.locator('#pubScheduleEnable').click(); await waitNotice(page, '自动发布已启用');
  assert.deepEqual(h.saves[0].scope, { kind: 'production-queue' });
  assert.equal(h.saves[0].partition.tid, 232);
  assert.match(await page.locator('#pubSchedulePending').textContent(), /就绪 1 · 等待 1/);
  assert.match(await page.locator('#pubScheduleNext').textContent(), /2026-11-11 20:00/);
  assert.match(await page.locator('#pubProjects').textContent(), /制作任务：running/);
  await page.locator('#pubTitle').fill('正在编辑的标题'); await page.locator('#pubTags').fill('保留 标签');
  await page.locator('#pubDesc').fill('保留简介');
  await page.locator('#pubScheduleTimes input').fill('22:00');
  await page.locator('#pubScheduleScope').selectOption('selected');
  await page.locator('#pubProjects .pub-pick').nth(0).check();
  const beforeReads = h.projectReads;
  h.projects[0] = { ...h.projects[0], hasVideo: true, video: { bytes: 456, duration: 80, file: 'new.mp4' },
    publication: publication(true), task: { status: 'completed', running: false, productionBusy: false } };
  h.projects.push({ id: 'new-production', title: '新制作作品', tags: [], publication: publication(false), task: { status: 'queued' } });
  await page.clock.fastForward(15001);
  await page.waitForFunction(() => document.querySelector('#pubSchedulePending').textContent.includes('就绪 2 · 等待 1'));
  await page.waitForFunction(() => document.querySelector('#pubProjects').textContent.includes('新制作作品'));
  assert.ok(h.projectReads > beforeReads);
  assert.match(await page.locator('#pubProjects .pub-row').first().textContent(), /可发布.*成片检查通过/s);
  assert.match(await page.locator('#pubProjects .pub-row').first().textContent(), /制作任务：completed/);
  assert.equal(await page.locator('#pubTitle').inputValue(), '正在编辑的标题');
  assert.equal(await page.locator('#pubTags').inputValue(), '保留 标签'); assert.equal(await page.locator('#pubDesc').inputValue(), '保留简介');
  assert.equal(await page.locator('#pubPartition').inputValue(), '231');
  assert.equal(await page.locator('#pubSchedulePartition').inputValue(), 'legacy-tid:232');
  assert.equal(await page.locator('#pubScheduleTimes input').inputValue(), '22:00');
  assert.equal(await page.locator('#pubScheduleScope').inputValue(), 'selected');
  assert.deepEqual(await queueIds(page), ['unfinished']); assert.equal(h.submits, 0); assert.equal(h.saves.length, 1); assert.deepEqual(errors, []);
});

test('保存/启用回包不覆盖期间新编辑；窄屏无溢出；冲突读取保留 dirty 后需重新确认', async t => {
  const { h, page, errors } = await setup(t, { width: 390 });
  await page.locator('#pubProjects .pub-pick').nth(0).check();
  h.delay = true;
  await page.locator('#pubScheduleSave').click();
  await page.waitForFunction(() => document.querySelector('#pubScheduleSave').disabled);
  await page.locator('#pubScheduleTimes input').fill('22:00');
  await page.locator('#pubProjects .pub-pick').nth(1).check();
  assert.ok(h.release); h.release();
  await waitNotice(page, '新增的修改尚未保存');
  assert.equal(await page.locator('#pubScheduleTimes input').inputValue(), '22:00');
  assert.deepEqual(await queueIds(page), ['unfinished', 'ready']);
  h.delay = false; h.state.revision++;
  await page.locator('#pubScheduleSave').click();
  await page.waitForFunction(() => document.querySelector('#pubScheduleError').textContent.includes('版本冲突'));
  await page.locator('#pubScheduleRetry').click();
  await page.waitForFunction(() => !document.querySelector('#pubScheduleRetry').disabled);
  assert.equal(await page.locator('#pubScheduleTimes input').inputValue(), '22:00');
  assert.deepEqual(await queueIds(page), ['unfinished', 'ready']);
  await page.locator('#pubSchedulePartition').selectOption('legacy-tid:231');
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#pubScheduleEnable').click();
  assert.equal(h.saves.length, 2, '冲突后重新读取不应绕过启用确认');
  h.delay = true;
  page.once('dialog', dialog => dialog.accept()); await page.locator('#pubScheduleEnable').click();
  await page.waitForFunction(() => document.querySelector('#pubScheduleEnable').disabled);
  await page.locator('#pubScheduleScope').selectOption('production-queue');
  await page.locator('#pubScheduleTimes input').fill('23:00');
  await page.locator('#pubSchedulePartition').selectOption('legacy-tid:232');
  h.release(); await waitNotice(page, '自动发布已启用');
  assert.equal(await page.locator('#pubScheduleScope').inputValue(), 'production-queue');
  assert.equal(await page.locator('#pubScheduleTimes input').inputValue(), '23:00');
  assert.equal(await page.locator('#pubSchedulePartition').inputValue(), 'legacy-tid:232');
  assert.equal(h.state.partition.tid, 231);
  assert.equal(h.state.scope.kind, 'selected', '启用只使用已确认的请求快照');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const id of ['pubScheduleSave', 'pubScheduleEnable', 'pubSchedulePause', 'pubScheduleRetry']) {
    const box = await page.locator('#' + id).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
  }
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
  if (process.env.VH_PUBLISH_CALENDAR_SCREENSHOT) await page.screenshot({ path: process.env.VH_PUBLISH_CALENDAR_SCREENSHOT, fullPage: true });
});

test('网络错误明确失败，不显示暂停或空队列，可重试恢复', async t => {
  const { h, page, errors } = await setup(t, { scheduleError: 'network' });
  assert.match(await page.locator('#pubScheduleStatus').textContent(), /读取排程失败/);
  assert.doesNotMatch(await page.locator('#pubScheduleStatus').textContent(), /已暂停/);
  assert.equal(await page.locator('#pubBatchCount').textContent(), '状态未知');
  h.scheduleError = 0; await page.locator('#pubScheduleRetry').click();
  await page.waitForFunction(() => document.querySelector('#pubScheduleSave').disabled === false);
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('scope 读取 503/400 不伪装空队列；lastAttempt waiting 展示等待而非失败', async t => {
  const { h, page, errors } = await setup(t);
  await page.locator('#pubSchedulePartition').selectOption('legacy-tid:231');
  await page.locator('#pubScheduleScope').selectOption('production-queue');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#pubScheduleEnable').click();
  await waitNotice(page, '自动发布已启用');
  h.state.lastAttempt = { state: 'waiting', message: '制作锁仍占用' };
  await page.locator('#pubScheduleRetry').click();
  await page.waitForFunction(() => document.querySelector('#pubScheduleStatus').textContent.includes('上次时点等待制作完成'));
  assert.match(await page.locator('#pubScheduleStatus').textContent(), /制作锁仍占用.*等下个排程时点/);
  assert.equal(h.state.enabled, true);
  for (const code of [503, 400]) {
    h.scheduleError = code; await page.locator('#pubScheduleRetry').click();
    await page.waitForFunction(() => document.querySelector('#pubScheduleStatus').textContent.includes('读取排程失败'));
    assert.match(await page.locator('#pubScheduleStatus').textContent(), /当前状态未确认/);
    assert.equal(await page.locator('#pubBatchCount').textContent(), '队列 2 支');
    assert.equal(await page.locator('#pubScheduleEnable').isDisabled(), true);
    await page.waitForFunction(() => !document.querySelector('#pubScheduleRetry').disabled);
  }
  h.scheduleError = 0; await page.locator('#pubScheduleRetry').click();
  await page.waitForFunction(() => document.querySelector('#pubScheduleEnable').disabled === false);
  // 显式清空分区可保存 null，不能悄悄沿用此前授权的分区。
  await page.locator('#pubSchedulePartition').selectOption('');
  await page.locator('#pubScheduleSave').click(); await waitNotice(page, '排程已保存');
  assert.equal(h.state.partition, null); assert.equal(h.state.enabled, false);
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('初始分区迟到：不阻塞排程/来源，校验仅使用当前项目与当前表单的已恢复分区', async t => {
  const { h, page, errors } = await setup(t, { holdPartitions: true, legacyProtocol: true });
  await page.waitForFunction(() => document.querySelector('#pubTitle').value === 'unfinished');
  await page.waitForFunction(() => document.querySelector('#pubRefsCount').textContent === '（无）');
  assert.match(await page.locator('#pubScheduleStatus').textContent(), /前后端版本不一致/);
  assert.deepEqual(h.referenceIds, ['unfinished']); assert.equal(h.plans.length, 0);
  await page.locator('.pub-item').filter({ hasText: 'ready' }).click();
  await page.waitForFunction(() => document.querySelector('#pubTitle').value === 'ready');
  await page.waitForFunction(() => document.querySelector('#pubRefsCount').textContent === '（无）');
  await page.locator('#pubTitle').fill('等待分区时修改的标题');
  await page.locator('#pubDesc').fill('等待分区时补写的简介');
  await page.evaluate(() => localStorage.setItem('vh.publish.partition', '231'));
  assert.equal(h.plans.length, 0); assert.deepEqual(h.referenceIds, ['unfinished', 'ready']);
  assert.ok(h.releasePartitions); h.releasePartitions();
  await page.waitForFunction(() => !document.querySelector('#pubSubmit').disabled);
  assert.equal(h.plans.length, 1, '切换项目及编辑前的等待校验应作废，不补发旧请求');
  assert.equal(h.plans[0].id, 'ready'); assert.equal(h.plans[0].tid, 231);
  assert.equal(h.plans[0].title, '等待分区时修改的标题');
  assert.equal(h.plans[0].desc, '等待分区时补写的简介'); assert.deepEqual(h.plans[0].problems, []);
  assert.equal(h.saves.length, 0); assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});

test('发布台：精简审阅灰框并在确认弹窗提醒；分区支持关键词筛选并显示说明', async t => {
  const { h, page, errors } = await setup(t);
  h.projects[1].warnings = [
    { code: 'review-pending', text: '发布审阅待核或未通过。这与投稿表单能否提交是两回事。' },
    { code: 'copy-warning', text: '历史文案尚未关联脚本版本；请人工核对后关联当前稿，不将文件存在当作最新版' },
  ];
  await page.locator('#pubProjects .pub-item').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#pubPartitionAdvice')?.textContent.includes('旧版分区'));
  await page.locator('#pubPartitionSearch').fill('AI');
  const options = await page.locator('#pubPartition option').allTextContents();
  assert.ok(options.some(text => text.includes('计算机技术')), '搜 AI 应命中计算机技术');
  assert.ok(!options.some(text => text.includes('科学科普')), '筛选后不应混入无关分区');
  await page.locator('#pubPartition').selectOption('231');
  await page.locator('#pubPartitionSearch').fill('科普');
  assert.equal(await page.locator('#pubPartition').inputValue(), '231', '筛选关键词不应清空已选分区');
  await page.locator('#pubPartitionSearch').fill('');
  assert.match(await page.locator('#pubPartitionAdvice').textContent(), /AI \/ Agent|原理|开发/);
  await page.locator('#pubPlanBtn').click(); await waitNotice(page, '尚未上传或投稿');
  assert.equal((await page.locator('#pubIssues').textContent()).trim(), '', '纯审阅软提示不占问题区');
  page.once('dialog', dialog => { assert.match(dialog.message(), /发布前请确认画面、听感与片中数字/); return dialog.dismiss(); });
  await page.locator('#pubSubmit').click();
  assert.equal(h.submits, 0); assert.deepEqual(errors, []);
});
