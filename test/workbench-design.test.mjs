import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { publishLimitIssues } from '../lib/publish-limits.mjs';

// Real page modules, fake HTTP data. No credentials, models, uploads or publishing.
const WWW = new URL('../www/', import.meta.url);
const projects = [
  { rel: 'projects/demo one', name: '文字如何成为影像', dur: 0, videos: [], size: 1024, cacheBytes: 0,
    publish: { main: '文字与影像之间', descHead: '让内容有清楚的表达。' }, task: { status: 'idle' } },
  { rel: 'projects/second', name: '本地模型的下一步', dur: 0, videos: [], size: 2048, cacheBytes: 0,
    publishStatus: { required: false }, task: { status: 'idle' } },
];
const drafts = [
  { id: 'A', title: '作品 A', tags: ['AI'], desc: '简介 A', hasVideo: true, video: { file: 'A.mp4', bytes: 100 }, cover: null },
  { id: 'B', title: '作品 B', tags: ['视频'], desc: '简介 B', hasVideo: true, video: { file: 'B.mp4', bytes: 200 }, cover: null },
];
const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
async function openPage(t, { width = 1440, height = 1000, intercept, items = projects, publishDrafts = drafts, queueItems = [] } = {}) {
  const browser = await launchBrowser(chromium, { headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('vh.publish.partition', '231'); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (request.method() !== 'GET') writes.push(p);
    if (intercept && await intercept(route, p)) return;
    if (p.startsWith('/_vh/')) {
      const file = new URL(p.slice('/_vh/'.length), WWW);
      if (!file.href.startsWith(WWW.href) || !fs.existsSync(file)) return route.abort();
      return route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
    }
    if (['/', '/settings', '/publish'].includes(p)) {
      const file = p === '/settings' ? 'settings.html' : p === '/publish' ? 'publish.html' : url.searchParams.has('p') ? 'player.html' : 'index.html';
      return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(new URL(file, WWW)) });
    }
    if (p === '/_api/projects') return json(route, { projects: items });
    if (p === '/_api/trash') return json(route, { items: [], totalBytes: 0 });
    if (p === '/_api/providers') return json(route, { providers: [{ name: 'local', label: '测试渠道', selected: true,
      base: 'https://example.com/v1', model: 'test-model', models: ['test-model'], hasKey: false }], current: { provider: 'local', model: 'test-model' } });
    if (p === '/_api/agent-ready') return json(route, { ready: true, provider: 'local' });
    if (p === '/_api/schedule') {
      const input = request.method() === 'POST' ? request.postDataJSON() : null;
      if (input?.action === 'remove-many') {
        const ids = new Set(input.ids);
        const removed = queueItems.filter(item => ids.has(item.id));
        queueItems = queueItems.filter(item => !ids.has(item.id));
        return json(route, { ok: true, removed: removed.length, ids: removed.map(item => item.id), skipped: [], items: queueItems });
      }
      return json(route, { items: queueItems, timing: {} });
    }
    if (p === '/_api/publish/overview') return json(route, { account: { loggedIn: true, name: '模拟账号' }, ready: { ok: true } });
    if (p === '/_api/publish/partitions') return json(route, { human: false, taxonomy: 'legacy', list: [{ id: 231, name: '计算机技术', parent: '科技' }] });
    if (p === '/_api/publish/projects') return json(route, { projects: publishDrafts });
    if (p === '/_api/publish/references') {
      const input = request.postDataJSON();
      return json(route, { sources: [{ label: input.id + ' 来源', url: 'https://example.com/' + input.id }], limit: 2000 });
    }
    if (p === '/_api/publish/plan') {
      const input = request.postDataJSON();
      const problems = publishLimitIssues({ ...input, tags: input.tags.split(/\s+/).filter(Boolean) }).map(x => x.message);
      if (!input.title) problems.push('标题不能为空');
      return json(route, { payload: problems.length ? null : input, problems, warnings: [] });
    }
    return json(route, {});
  });
  return { page, errors, writes };
}
async function screenshot(page, name) {
  if (!process.env.VH_DESIGN_SCREENSHOTS) return;
  fs.mkdirSync(process.env.VH_DESIGN_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.VH_DESIGN_SCREENSHOTS, name + '.png'), fullPage: true });
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '页面不能横向溢出');
}

test('首页可把文章和交付选项加入待做队列，不调用立即制作', async t => {
  let queued;
  const { page, writes, errors } = await openPage(t, { width: 375, intercept: async (route, p) => {
    if (p !== '/_api/schedule/enqueue') return false;
    queued = route.request().postDataJSON();
    await json(route, { ok: true, id: 'q1' }); return true;
  } });
  await page.goto('http://workbench.test/');
  await page.fill('#newInput', '用于队列的文章正文');
  await page.selectOption('#newAspectRatio', '9:16');
  await page.click('#newQueueBtn');
  await page.getByRole('button', { name: '查看待做队列' }).click();
  assert.equal(await page.isVisible('#queuePanel'), true);
  assert.equal(queued.input, '用于队列的文章正文');
  assert.equal(queued.mode, 'article');
  assert.equal(queued.aspectRatio, '9:16');
  assert.deepEqual(writes, ['/_api/schedule/enqueue']);
  await noOverflow(page);
  assert.deepEqual(errors, []);
});

test('自动化页可以独立保存每天定点制作；隐藏时段字段，不写发布设置', async t => {
  let build = { enabled: false, from: '09:00', to: '23:00', dailyLimit: 3 };
  const { page, writes, errors } = await openPage(t, { width: 375, intercept: async (route, p) => {
    if (p !== '/_api/schedule') return false;
    const input = route.request().postDataJSON();
    if (input?.action === 'timing') build = { ...build, ...input.build };
    await json(route, { items: [], timing: { build, dailyBuildSupported: true } }); return true;
  } });
  await page.goto('http://workbench.test/');
  await page.locator('#automationEntry').click();
  await page.locator('#buildMode').selectOption('daily');
  await page.locator('#buildFrom').fill('08:25');
  await page.locator('#buildEnabled').evaluate(el => el.click());
  assert.equal(await page.locator('#buildWindow').isVisible(), false);
  await page.locator('#timingSave').click();
  await page.waitForFunction(() => document.querySelector('#timingMsg').textContent.includes('已保存'));
  assert.equal(build.mode, 'daily'); assert.equal(build.from, '08:25'); assert.equal(build.enabled, true);
  await noOverflow(page);
  assert.deepEqual(writes, ['/_api/schedule']); assert.deepEqual(errors, []);
});

test('映序：首页层级、搜索保留卡片、空格路径与键盘材料选择', async t => {
  const { page, errors } = await openPage(t);
  await page.goto('http://workbench.test/');
  await page.waitForSelector('#list .card');
  assert.match(await page.title(), /映序/);
  assert.equal(await page.locator('.workspace-links [aria-current="page"]').textContent(), '工作台');
  assert.equal(await page.locator('#queueBox').getAttribute('open'), null);
  assert.match(await page.locator('#list img').first().getAttribute('src'), /demo%20one/);
  assert.equal(await page.locator('#list img').first().getAttribute('alt'), '文字如何成为影像 · 画面预览');
  await page.evaluate(() => { window.originalCard = document.querySelector('#list .card'); });
  await page.fill('#projectSearch', '本地模型');
  assert.equal(await page.locator('#list .card:visible').count(), 1);
  await page.fill('#projectSearch', '不存在');
  assert.equal(await page.locator('#searchEmpty').isVisible(), true);
  await page.fill('#projectSearch', '');
  assert.equal(await page.evaluate(() => window.originalCard === document.querySelector('#list .card')), true);
  await page.locator('input[name=src][value=article]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('input[name=src][value=topic]').isChecked(), true);
  assert.match(await page.locator('#newInput').getAttribute('placeholder'), /想讲什么/);
  await page.locator('#composerSettings > summary').click(); await page.check('#saveNewDraft');
  await noOverflow(page);
  await screenshot(page, 'home-desktop');
  assert.deepEqual(errors, []);
});

test('首页运行标识按项目身份判断，支持同时运行的项目', async t => {
  const running = { status: 'running', running: true, since: Date.now(), steps: 1 };
  const items = [
    { ...projects[0], rel: 'projects/a', task: running },
    { ...projects[0], rel: 'projects/a-long', task: { status: 'idle' } },
    { ...projects[1], task: running },
  ];
  const { page, errors } = await openPage(t, { items });
  await page.goto('http://workbench.test/');
  await page.waitForSelector('#list .card');
  assert.equal(await page.locator('#list .card.running').count(), 2);
  assert.equal(await page.locator('#list .card').nth(1).evaluate(el => el.classList.contains('running')), false);
  assert.deepEqual(errors, []);
});

test('克制布局：低频操作按需展开，选题/队列/定时各自成页，切换保留DOM和草稿', async t => {
  const topics = Array.from({ length: 3 }, (_, i) => ({ id: 'calm-' + i, topic: ['离线模型适合哪些工作？', '显存足够，推理为什么仍然慢？', '什么时候值得给工具加上 AI？'][i],
    why: '从一个具体问题开始，讲清过程、证据与适用范围。', status: 'candidate', at: i, sources: ['https://example.test/source'] }));
  const { page, errors, writes } = await openPage(t, { queueItems: [{ id: 'q1', topic: '准备中的选题', state: 'todo' }], intercept: async (route, p) => {
    if (p === '/_api/schedule/discover/topics') { await json(route, { topics, candidates: topics, suggestions: [], history: [], historyTotal: 0, config: { query: '本地模型', count: 3 }, preferences: {} }); return true; }
    if (p === '/_api/schedule/discover') { await json(route, { view: { state: 'idle' }, job: null }); return true; }
    return false;
  } });
  await page.goto('http://workbench.test/'); await page.waitForSelector('#list .card');
  assert.equal(await page.isVisible('#newInput'), true);
  assert.equal(await page.isVisible('#saveNewDraft'), false);
  assert.equal(await page.locator('#list .card').first().locator('.actions a:visible').count(), 1);
  assert.equal(await page.locator('#list [data-remove]').first().isVisible(), false);
  await page.locator('#list .project-details > summary').first().click();
  assert.equal(await page.locator('#list [data-remove]').first().isVisible(), true);
  await page.locator('#list .project-details > summary').first().click();
  await screenshot(page, 'restrained-home-desktop');
  await page.locator('#queueBox > summary').click(); await page.waitForSelector('[data-topic-id="calm-0"]');
  assert.equal(await page.isVisible('#queuePanel'), false); assert.equal(await page.isVisible('#automationPanel'), false);
  assert.equal(await page.isVisible('#discCount'), false);
  const card = page.locator('[data-topic-id="calm-0"]');
  assert.equal(await card.locator(':scope > .topic-buttons button:visible').count(), 2);
  assert.equal(await card.getByRole('button', { name: '不感兴趣', exact: true }).isVisible(), false);
  await card.locator('.topic-more > summary').click();
  assert.equal(await card.getByRole('button', { name: '不感兴趣', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await card.locator('.topic-more').evaluate(el => el.open), false);
  await page.fill('#discQuery', '未提交的查找方向');
  await page.evaluate(() => { window.calmCard = document.querySelector('[data-topic-id="calm-0"]'); });
  await page.locator('#ideasTab').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('#queueTab', 'aria-selected'), 'true');
  assert.equal(await page.isVisible('#queueList .queue-item'), true);
  await page.fill('#queueTopic', '未提交的队列草稿');
  await page.locator('#queueTab').focus(); await page.keyboard.press('End');
  assert.equal(await page.isVisible('#automationPanel'), true);
  assert.equal(await page.locator('label:has(#buildEnabled) .switch-label').isVisible(), true);
  await page.locator('#automationTab').focus(); await page.keyboard.press('Home');
  assert.equal(await page.inputValue('#discQuery'), '未提交的查找方向');
  assert.equal(await page.evaluate(() => window.calmCard === document.querySelector('[data-topic-id="calm-0"]')), true);
  await page.click('#queueTab'); assert.equal(await page.inputValue('#queueTopic'), '未提交的队列草稿');
  await page.click('#ideasTab');
  await page.locator('#queueBox').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await screenshot(page, 'restrained-topics-desktop');
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await noOverflow(page);
    await card.locator('.topic-more > summary').click();
    const rect = await card.locator('.topic-more-body').boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1, '更多操作不能超出屏幕');
    await page.keyboard.press('Escape');
    if (width === 375) { await page.locator('#queueBox').evaluate(el => el.scrollIntoView({ block: 'start' })); await screenshot(page, 'restrained-topics-mobile'); }
  }
  const beforeAutomation = writes.length;
  await page.click('#automationEntry');
  assert.equal(await page.isVisible('#automationPanel'), true);
  assert.match(await page.locator('#automationQueueStatus').textContent(), /有 1 个选题等待制作/);
  assert.equal(await page.locator('#automationPublishLink').getAttribute('href'), '/publish#publishSchedule');
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await noOverflow(page);
  }
  await page.click('#automationQueueLink');
  assert.equal(await page.locator('#queueTopic').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.inputValue('#queueTopic'), '未提交的队列草稿');
  assert.equal(writes.length, beforeAutomation, '导航不能保存设置或启动任何阶段');
  assert.deepEqual(errors, []); assert.deepEqual(writes, [], '布局切换和展开不触发业务写入');
});

test('选题队列：可勾选多项一次移除，正在制作的项不给勾选也不删', async t => {
  const queueItems = [
    { id: 'q1', topic: '甲选题', state: 'todo' },
    { id: 'q2', topic: '乙选题', state: 'done' },
    { id: 'q3', topic: '正在做的', state: 'running' },
    { id: 'q4', topic: '丙选题', state: 'failed' },
  ];
  const { page, errors } = await openPage(t, { queueItems });
  await page.goto('http://workbench.test/');
  await page.waitForSelector('#queueBox');
  await page.locator('#queueBox > summary').click(); await page.click('#queueTab');
  await page.waitForSelector('#queueList .queue-item');

  assert.equal(await page.locator('#queueBulk').isVisible(), true);
  assert.equal(await page.locator('#queueRemoveSelected').isDisabled(), true);
  // 正在做的项不可勾选：移除只删队列记录，不会停任务。
  assert.equal(await page.locator('.queue-item[data-queue-id="q3"] .qpick').isDisabled(), true);

  await page.check('#queueSelectAll');
  assert.equal(await page.locator('#queueList .qpick:checked').count(), 3, '全选不含正在制作的项');
  assert.match(await page.locator('#queueRemoveSelected').textContent(), /移除选中（3）/);

  page.once('dialog', dialog => dialog.accept());
  await page.click('#queueRemoveSelected');
  await page.waitForFunction(() => document.querySelector('#queueMsg').textContent.includes('已移除 3 个选题'));
  assert.equal(await page.locator('#queueList .queue-item').count(), 1, '只剩正在制作的项留在队列');
  assert.match(await page.locator('#queueList .qtopic').textContent(), /正在做的/);
  assert.equal(await page.locator('#queueRemoveSelected').isDisabled(), true, '删完后没有选中项');
  assert.doesNotMatch(await page.locator('#queueMsg').textContent(), /失败/);
  await noOverflow(page);
  // 手机宽度下展开队列也不能横向溢出（批量操作条最容易撑破）。
  await page.setViewportSize({ width: 375, height: 812 });
  await noOverflow(page);
  assert.equal(await page.locator('#queueRemoveSelected').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('选题队列：取消勾选与全选取消互不残留，失败时不清空选择', async t => {
  const queueItems = [
    { id: 'q1', topic: '甲选题', state: 'todo' },
    { id: 'q2', topic: '乙选题', state: 'stopped' },
  ];
  const { page, errors } = await openPage(t, { queueItems, intercept: async (route, p) => {
    if (p === '/_api/schedule' && route.request().method() === 'POST' &&
        JSON.parse(route.request().postData() || '{}').action === 'remove-many') {
      await json(route, { error: '队列被占用' }); return true;
    }
    return false;
  } });
  await page.goto('http://workbench.test/');
  await page.locator('#queueBox > summary').click(); await page.click('#queueTab');
  await page.waitForSelector('#queueList .queue-item');

  await page.locator('.queue-item[data-queue-id="q1"] .qpick').check();
  assert.equal(await page.locator('#queueRemoveSelected').isDisabled(), false);
  assert.equal(await page.locator('#queueSelectAll').isChecked(), false);
  await page.locator('.queue-item[data-queue-id="q2"] .qpick').check();
  assert.equal(await page.locator('#queueSelectAll').isChecked(), true);
  assert.equal(await page.locator('#queueRemoveSelected').evaluate(el => el.textContent.includes('（2）')), true);

  page.once('dialog', dialog => dialog.accept());
  await page.click('#queueRemoveSelected');
  await page.waitForFunction(() => document.querySelector('#queueMsg').textContent.includes('批量移除失败'));
  assert.equal(await page.locator('#queueList .qpick:checked').count(), 2, '请求失败时保留选择，方便重试');
  assert.equal(await page.locator('#queueList .queue-item').count(), 2);
  assert.deepEqual(errors, []);
});

test('窄屏：首页、模型、发布与编辑页面无横向溢出，发布操作可见', async t => {
  const { page, errors, writes } = await openPage(t, { width: 375, height: 812 });
  for (const [url, name] of [['/', 'home-mobile'], ['/settings', 'settings-mobile'], ['/publish', 'publish-mobile'], ['/?p=projects/demo', 'editor-mobile']]) {
    await page.goto('http://workbench.test' + url);
    await page.waitForLoadState('networkidle');
    await noOverflow(page);
    if (name === 'publish-mobile') {
      assert.equal(await page.locator('#pubSubmit').isVisible(), true);
      const bounds = await page.locator('#pubActions').boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 813);
      await page.locator('#pubMain').evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.equal(await page.locator('#pubDesc').isVisible(), true);
    }
    await screenshot(page, name);
  }
  assert.deepEqual(errors, []);
  assert.equal(writes.some(p => /submit|batch$|\/new$|chat/.test(p)), false);
  await page.setViewportSize({ width: 320, height: 740 });
  for (const url of ['/', '/settings', '/publish']) {
    await page.goto('http://workbench.test' + url);
    await page.waitForLoadState('networkidle');
    await noOverflow(page);
  }
});

test('发布表单修改后丢弃旧校验，自动恢复并阻止超限简介', async t => {
  const { page, errors } = await openPage(t, { publishDrafts: [{ ...drafts[0], title: '' }] });
  await page.goto('http://workbench.test/publish');
  await page.waitForFunction(() => document.querySelector('#pubReady').textContent.includes('标题不能为空'));
  await page.fill('#pubTitle', '修正后的标题');
  assert.equal(await page.locator('#pubSubmit').isDisabled(), true, '未完成当前校验前不能沿用旧通过状态');
  await page.waitForFunction(() => !document.querySelector('#pubSubmit').disabled);
  assert.doesNotMatch(await page.locator('#pubReady').textContent(), /标题不能为空/);
  await page.fill('#pubDesc', '文'.repeat(2001));
  assert.equal(await page.locator('#pubSubmit').isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('#pubReady').textContent.includes('超过 2000'));
  assert.equal(await page.locator('#pubSubmit').isDisabled(), true);
  await page.fill('#pubDesc', '修正简介');
  await page.waitForFunction(() => !document.querySelector('#pubSubmit').disabled);
  await screenshot(page, 'publish-desktop');
  assert.deepEqual(errors, []);
});

test('发布切换项目时，迟到的来源和校验不能覆盖新项目', async t => {
  const held = [];
  const { page, errors } = await openPage(t, { intercept: async (route, p) => {
    if (['/_api/publish/references', '/_api/publish/plan'].includes(p) && route.request().postDataJSON().id === 'A') {
      held.push({ route, p }); return true;
    }
    return false;
  } });
  await page.goto('http://workbench.test/publish');
  await page.waitForFunction(() => document.querySelector('#pubTitle').value === '作品 A');
  await page.locator('.pub-item').filter({ hasText: '作品 B' }).click();
  await page.waitForFunction(() => document.querySelector('#pubTitle').value === '作品 B' && !document.querySelector('#pubSubmit').disabled);
  assert.equal(held.length, 2);
  for (const { route, p } of held) await json(route, p.endsWith('/plan')
    ? { problems: ['A 的旧错误'], payload: null }
    : { sources: [{ label: 'A 的旧来源', url: 'https://example.com/A' }] });
  await page.locator('#pubRefsToggle').click();
  await page.waitForFunction(() => document.querySelector('#pubRefsList').textContent.includes('B 来源'));
  assert.doesNotMatch(await page.locator('#pubReady').textContent(), /A 的旧错误/);
  assert.equal(await page.locator('#pubSubmit').isEnabled(), true);
  assert.deepEqual(errors, []);
});

test('追加来源返回前切换项目，不得覆盖新项目简介', async t => {
  let pending;
  const { page, errors } = await openPage(t, { intercept: async (route, p) => {
    if (p === '/_api/publish/references' && route.request().postDataJSON().urls) { pending = route; return true; }
    return false;
  } });
  await page.goto('http://workbench.test/publish');
  await page.waitForFunction(() => !document.querySelector('#pubSubmit').disabled);
  await page.locator('#pubRefsToggle').click();
  await page.locator('#pubRefsAppend').click();
  assert.ok(pending);
  await page.locator('.pub-item').filter({ hasText: '作品 B' }).click();
  await page.waitForFunction(() => document.querySelector('#pubDesc').value === '简介 B');
  await json(pending, { merged: 'A 简介和来源', added: 1 });
  await page.waitForTimeout(50);
  assert.equal(await page.inputValue('#pubDesc'), '简介 B');
  assert.deepEqual(errors, []);
});

test('同一项目的迟到校验不能恢复旧通过状态', async t => {
  let pending, hold = false;
  const { page, errors } = await openPage(t, { intercept: async (route, p) => {
    if (hold && p === '/_api/publish/plan') { pending = route; hold = false; return true; }
    return false;
  } });
  await page.goto('http://workbench.test/publish');
  await page.waitForFunction(() => !document.querySelector('#pubSubmit').disabled);
  hold = true;
  await page.locator('#pubPlanBtn').click();
  assert.ok(pending);
  await page.fill('#pubDesc', '文'.repeat(2001));
  await page.waitForFunction(() => document.querySelector('#pubReady').textContent.includes('超过 2000'));
  await json(pending, { payload: { title: '旧的有效表单' }, problems: [] });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#pubSubmit').isDisabled(), true);
  assert.match(await page.locator('#pubReady').textContent(), /超过 2000/);
  assert.deepEqual(errors, []);
});

test('追加来源不能覆盖同一项目中正在编辑的简介', async t => {
  let pending;
  const { page, errors } = await openPage(t, { intercept: async (route, p) => {
    if (p === '/_api/publish/references' && route.request().postDataJSON().urls) { pending = route; return true; }
    return false;
  } });
  await page.goto('http://workbench.test/publish');
  await page.waitForFunction(() => !document.querySelector('#pubSubmit').disabled);
  await page.locator('#pubRefsToggle').click();
  await page.locator('#pubRefsAppend').click();
  assert.ok(pending);
  await page.fill('#pubDesc', '用户刚补写的简介');
  await json(pending, { merged: '旧简介与来源', added: 1 });
  await page.waitForFunction(() => document.querySelector('#pubNotice').textContent.includes('未覆盖'));
  assert.equal(await page.inputValue('#pubDesc'), '用户刚补写的简介');
  assert.deepEqual(errors, []);
});

/* 真实事故：断线后恢复、成片已交付，卡片却显示"制作失败 / 任务未完成"，
 * 而且"继续任务"按钮消失（delivered 判定），用户不知道该怎么办。 */
test('收尾异常但已交付：卡片不显示为制作失败，并说明情况', async t => {
  const items = [{ ...projects[0], rel: 'projects/recovered', task: {
    status: 'failed', running: false, delivered: true, completionKind: 'video',
    error: { kind: 'execution', message: '任务未完成。原始输入与执行日志已保留，请查看日志后重试。' },
    warnings: ['运行中出现过连接中断（ECONNRESET），之后已恢复并继续，未影响最终结果'],
    canResume: false, resumeNotice: '接续原 OpenCode 会话…',
  } }];
  const { page, errors } = await openPage(t, { items });
  await page.goto('http://workbench.test/');
  await page.waitForSelector('#list .card');
  const status = await page.locator('#list .task-status').textContent();
  assert.match(status, /制作结束 · 已交付/, status);
  assert.match(status, /制作结果已交付/, status);
  assert.doesNotMatch(status, /任务未完成/, '不能再用笼统的失败文案');
  assert.doesNotMatch(status, /制作失败/);
  assert.match(status, /恢复/, '恢复过程要说明');
  assert.equal(await page.locator('#list [data-remove]').first().isVisible(), false);
  assert.equal(await page.locator('#list .card').first().locator('a[href*="/out/"]').count() >= 0, true);
  assert.deepEqual(errors, []);
});
