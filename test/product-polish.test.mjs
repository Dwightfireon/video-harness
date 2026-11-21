import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { publishInputs, publishRevision, publishStatus, confirmPublishRevision, checkPublish } from '../lib/publish.mjs';
import { runAgent, makeTools } from '../lib/agent.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { beginTask, updateTask, taskStatus, resumeTask } from '../lib/task-status.mjs';
import { writeCheckpoint } from '../lib/checkpoint.mjs';
import { saveState } from '../lib/state.mjs';
import { startServer } from '../lib/server.mjs';
import { projectProgress } from '../www/project-progress.mjs';
import { attachDraft } from '../www/draft-input.mjs';
import { requestJSON } from '../www/http.mjs';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';

const copy = '## 标题\n保留我的标题\n## 简介\n介绍窗口。\n## 置顶评论\n欢迎讨论。\n## 标签\n测试窗口\n## 封面文案\n主：测试窗口\n## 发布前检查清单\n- [ ] 人工审阅\n';
const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const reply = () => ({ choices: [{ message: { role: 'assistant', content: '已完成文案版本关联，仍须人工审阅。' }, finish_reason: 'stop' }] });
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-product-')), dir = path.join(root, 'projects/demo');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  for (const [name, text] of Object.entries({ 'PROJECT.json': '{}', '脚本.md': '## S1 · 窗口\n1. 介绍窗口。\n',
    '发布文案.md': copy, 'scenes.src.js': 'root => ({render(){}})',
    'scene.html': '<!doctype html><html><body><script>window.DURATION=2;const DURATION=2;const scenes=[];window.renderAt=()=>{};</script></body></html>',
  })) fs.writeFileSync(path.join(dir, name), text);
  return { root, dir };
}
const confirm = dir => confirmPublishRevision(dir, publishRevision(dir));
const post = (url, data) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
async function serve(t, root, dir, options = {}) {
  const server = startServer(dir, 0, { root, providerInfo: () => [], ...options }); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('历史文案只读显示未关联，不悄悄制造版本凭证；确认不改正文', t => {
  const { dir } = fixture(t), original = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  const status = publishStatus(dir); assert.equal(status.ok, true); assert.equal(status.revision.state, 'untracked');
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-publish-revision.json')), false);
  confirm(dir); assert.equal(publishRevision(dir).state, 'current');
  assert.equal(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8'), original);
});

test('脚本内容变更使文案过期，即使长度和时间戳相同；纯视觉与交付配置不使文案过期', t => {
  const { dir } = fixture(t); confirm(dir);
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), 'new visual'); fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{"deliveryTarget":"video"}');
  assert.equal(publishRevision(dir).state, 'current');
  const file = path.join(dir, '脚本.md'), stamp = fs.statSync(file).mtime;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('窗口', '文件')); fs.utimesSync(file, stamp, stamp);
  assert.equal(publishStatus(dir).ok, false); assert.equal(publishRevision(dir).state, 'stale');
});

test('明确要求变更使文案过期，但仅更新时间字段不影响版本', t => {
  const { dir } = fixture(t), file = path.join(dir, 'out/.vh-brief.json');
  fs.writeFileSync(file, JSON.stringify({ must: ['只给链接'], at: '旧时间' })); confirm(dir);
  fs.writeFileSync(file, JSON.stringify({ must: ['只给链接'], at: '新时间' })); assert.equal(publishRevision(dir).state, 'current');
  fs.writeFileSync(file, JSON.stringify({ must: ['写优惠码'], at: '新时间' })); assert.equal(publishRevision(dir).state, 'stale');
});

test('手动改文案保留并显示待关联；过期页面不能确认新内容，损坏回执不冒充有效', t => {
  const { dir } = fixture(t); confirm(dir); const prior = publishRevision(dir);
  fs.appendFileSync(path.join(dir, '发布文案.md'), '\n用户补充说明。');
  assert.equal(publishRevision(dir).state, 'edited'); assert.throws(() => confirmPublishRevision(dir, prior), /核对期间已改变/);
  assert.match(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8'), /用户补充/);
  fs.writeFileSync(path.join(dir, 'out/.vh-publish-revision.json'), '{broken'); assert.equal(publishRevision(dir).state, 'untracked');
});

test('生成期间脚本被外部修改，旧模型响应不能写入或签发当前稿凭证', async t => {
  const { dir } = fixture(t); fs.unlinkSync(path.join(dir, '发布文案.md'));
  let n = 0;
  const result = await runAgent(dir, '补齐发布文案', { mode: 'edit-copy', providers, stepBudget: 1, request: async () => {
    n++; fs.appendFileSync(path.join(dir, '脚本.md'), '2. 新要求。\n');
    return call('write_file', { path: '发布文案.md', content: copy });
  } });
  assert.equal(n, 1); assert.equal(result.status, 'paused');
  assert.equal(fs.existsSync(path.join(dir, '发布文案.md')), false); assert.equal(fs.existsSync(path.join(dir, 'out/.vh-publish-revision.json')), false);
});

test('旧文案核对后可只关联版本，不强迫修改用户标题或重做视频', async t => {
  const { dir } = fixture(t); confirm(dir); fs.appendFileSync(path.join(dir, '脚本.md'), '2. 更多说明。\n');
  assert.equal((await nextPipelineWork(dir, 'edit-copy')).stage, 'publish');
  let n = 0; const before = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  const result = await runAgent(dir, '核对文案版本', { mode: 'edit-copy', providers, request: async () => {
    if (++n === 1) { const r = publishRevision(dir); return call('confirm_publish', { source_signature: r.sourceSignature, publish_hash: r.publishHash }); }
    return reply();
  } });
  assert.equal(result.status, 'completed', result.paused); assert.equal(publishRevision(dir).state, 'current');
  assert.equal(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8'), before);
});

test('Agent 不能自行降低交付目标；文案无效时不能只签回执，普通 TODO 教程不是占位符', async t => {
  const { dir } = fixture(t), tools = makeTools(dir, () => {}, { mode: 'article' });
  assert.match(await tools.write_file.run({ path: 'PROJECT.json', content: '{"deliveryTarget":"video"}' }), /拒绝/);
  fs.writeFileSync(path.join(dir, '发布文案.md'), copy.replace('欢迎讨论。', '<带码链接>'));
  assert.throws(() => confirm(dir), /尚不完整/);
  assert.equal(checkPublish(copy.replace('保留我的标题', 'TODO 清单怎么管理')).ok, true);
});

test('API 版本关联需明确确认且拒绝并发版本变动，不会修改文案', async t => {
  const { root, dir } = fixture(t), url = await serve(t, root, dir), revision = publishRevision(dir);
  assert.equal((await post(url + '/_api/publish/confirm', revision)).status, 400);
  const success = await post(url + '/_api/publish/confirm', { ...revision, confirmed: true }); assert.equal(success.status, 200);
  fs.appendFileSync(path.join(dir, '脚本.md'), '2. 新增。\n');
  assert.equal((await post(url + '/_api/publish/confirm', { ...revision, confirmed: true })).status, 400);
  assert.equal(publishRevision(dir).state, 'stale');
});

test('新建入口先保存仅视频目标，非法目标不创建半成品项目', async t => {
  const { root, dir } = fixture(t), url = await serve(t, root, dir);
  const bad = await post(url + '/_api/new', { name: 'bad', deliveryTarget: 'wrong' });
  assert.equal(bad.status, 400); assert.equal(fs.existsSync(path.join(root, 'projects/bad')), false);
  const created = await post(url + '/_api/new', { name: 'video-only', input: '测试选题', mode: 'topic', deliveryTarget: 'video' });
  assert.equal(created.status, 200); const json = await created.json();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, json.rel, 'PROJECT.json'))).deliveryTarget, 'video');
  assert.equal(json.started, false, '使用本地空渠道，不调用真实模型');
  const cli = spawnSync(process.execPath, [path.resolve('vh.mjs'), 'new', path.join(root, 'invalid-cli'), '--delivery', 'wrong'], { encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.equal(fs.existsSync(path.join(root, 'invalid-cli')), false);
});

test('新建时暂不填材料：只建项目，不写一条缺凭证的假失败任务', async t => {
  const { root, dir } = fixture(t), url = await serve(t, root, dir);
  const created = await post(url + '/_api/new', { name: 'empty-input', aspectRatio: '16:9', deliveryTarget: 'video' });
  assert.equal(created.status, 200);
  const json = await created.json();
  assert.equal(json.started, false); assert.equal(json.needsInput, true); assert.equal(json.task, null);
  assert.equal(fs.existsSync(path.join(root, json.rel, 'out/.vh-task.json')), false);
  const missing = await post(url + '/_api/new', { name: 'no-credential', input: '测试选题', mode: 'topic', deliveryTarget: 'video' });
  assert.equal(missing.status, 200);
  const failed = await missing.json();
  assert.equal(failed.started, false);
  assert.equal(failed.task.status, 'failed');
  assert.equal(failed.task.error.kind, 'credentials');
});

test('阶段展示隔离任务 ID 与 attempt，不从旧执行借用进度；概览不虚构百分比', t => {
  const { dir } = fixture(t), task = beginTask(dir, '测试制作', 'article'); updateTask(dir, task.id, { status: 'paused' });
  saveState(dir, { pipeline: { stage: 'render', taskId: 'old-task', since: Date.now() } }); assert.equal(taskStatus(dir).stage, null);
  saveState(dir, { pipeline: { stage: 'publish', taskId: task.id, attemptId: task.attemptId, since: Date.now() } }); assert.equal(taskStatus(dir).stage, 'publish');
  const view = projectProgress({ script: [], stale: {}, delivery: { publish: { required: false } } }, { running: true, stage: 'measure' });
  assert.match(view.headline, /实测配音/); assert.equal(view.next.tab, 'chat'); assert.equal(view.steps.find(s => s.id === 'publish').state, 'optional');
  assert.doesNotMatch(JSON.stringify(view), /\d+%/);
});

test('制作中的项目拒绝清缓存和删除，运行中数据不被破坏', async t => {
  const { root, dir } = fixture(t), url = await serve(t, root, dir);
  fs.mkdirSync(path.join(dir, 'out/frames')); fs.writeFileSync(path.join(dir, 'out/frames/proof.txt'), '保留运行中缓存');
  const task = beginTask(dir, '正在制作', 'article'); updateTask(dir, task.id, { status: 'running', pid: process.pid });
  for (const endpoint of ['clean', 'remove']) {
    const response = await post(url + `/_api/${endpoint}?p=projects/demo`, {});
    assert.equal(response.status, 409); assert.match((await response.json()).error, /仍在制作/);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'out/frames/proof.txt'), 'utf8'), '保留运行中缓存');
  assert.equal(fs.existsSync(path.join(dir, 'PROJECT.json')), true);
});

test('继续同一阶段时也登记新 attempt 的进度，而不是一直显示未知阶段', async t => {
  const { dir } = fixture(t); fs.writeFileSync(path.join(dir, '发布文案.md'), copy.replace('欢迎讨论。', '<带码链接>'));
  const original = beginTask(dir, '补齐发布文案', 'edit-copy'), work = await nextPipelineWork(dir, 'edit-copy');
  writeCheckpoint(dir, { schemaVersion: 1, taskId: original.id, attemptId: original.attemptId, mode: 'edit-copy', status: 'paused',
    messages: [{ role: 'user', content: original.message }], pending: [], pipelineState: { key: work.key, stage: work.stage } });
  updateTask(dir, original.id, { status: 'paused' });
  saveState(dir, { pipeline: { stage: 'publish', taskId: original.id, attemptId: original.attemptId, since: Date.now() } });
  const resumed = resumeTask(dir); updateTask(dir, resumed.id, { status: 'running', pid: process.pid }, resumed.attemptId);
  await runAgent(dir, resumed.message, { taskId: resumed.id, attemptId: resumed.attemptId, mode: 'edit-copy', providers, resume: true, stepBudget: 1,
    request: async () => { assert.equal(taskStatus(dir).stage, 'publish'); return call('read_file', { path: '脚本.md' }); } });
});

test('草稿保存须用户选择，恢复逐字保留长文本，退出保存清除副本而非页面输入', () => {
  const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const box = () => Object.assign(new EventTarget(), { checked: false });
  let value = '  中文长稿\n'.repeat(900); const original = value, checkbox = box(), status = { textContent: '' };
  const first = attachDraft({ key: 'test', input: { getValue: () => value, setValue: v => value = v }, checkbox, status, storage });
  first.flush(); assert.equal(data.size, 0);
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); assert.equal(data.size, 1);
  value = ''; const secondBox = box();
  const second = attachDraft({ key: 'test', input: { getValue: () => value, setValue: v => value = v }, checkbox: secondBox, status, storage });
  assert.equal(value, original); assert.equal(secondBox.checked, true);
  secondBox.checked = false; secondBox.dispatchEvent(new Event('change')); assert.equal(data.size, 0); assert.equal(value, original);
  first.dispose(); second.dispose();
});

test('存储失败不清输入；HTTP 错误、坏 JSON 和超时均有明确信息且不自动重复请求', async () => {
  let value = '不能丢失的稿件'; const checkbox = Object.assign(new EventTarget(), { checked: true }), status = { textContent: '' };
  const draft = attachDraft({ key: 'test', input: { getValue: () => value, setValue: v => value = v }, checkbox, status,
    storage: { getItem: () => null, setItem: () => { throw Error('quota'); } } });
  draft.flush(); assert.equal(value, '不能丢失的稿件'); assert.match(status.textContent, /未能保存/); draft.dispose();
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response('{"error":"服务暂不可用"}', { status: 503 }); };
    await assert.rejects(requestJSON('http://fixture.invalid'), /服务暂不可用/); assert.equal(calls, 1);
    globalThis.fetch = async () => new Response('<html>error</html>'); await assert.rejects(requestJSON('http://fixture.invalid'), /无效数据/);
    globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted'))));
    await assert.rejects(requestJSON('http://fixture.invalid', { timeoutMs: 15 }), /未自动重试/);
  } finally { globalThis.fetch = original; }
});

test('UI：新建草稿和目标刷新可恢复，失败不清稿，状态断连有提示', { timeout: 30000 }, async t => {
  const { root, dir } = fixture(t), url = await serve(t, root, dir), browser = await launchBrowser(chromium); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); page.setDefaultTimeout(7000);
  await page.goto(url); await page.locator('#composerSettings > summary').click(); await page.check('#saveNewDraft'); await page.fill('#newInput', '这是尚未发送的长稿件。');
  await page.selectOption('#newDeliveryTarget', 'video');
  await page.waitForFunction(() => document.querySelector('#newDraftStatus').textContent.includes('已保存在'));
  await page.reload(); assert.equal(await page.inputValue('#newInput'), '这是尚未发送的长稿件。'); assert.equal(await page.inputValue('#newDeliveryTarget'), 'video');
  await page.route('**/_api/new', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"测试创建失败"}' }));
  await page.click('#newBtn'); await page.waitForFunction(() => document.querySelector('#newMsg').textContent.includes('输入已保留'));
  assert.equal(await page.inputValue('#newInput'), '这是尚未发送的长稿件。');
  await page.route('**/_api/projects', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"测试断连"}' }));
  await page.waitForFunction(() => document.querySelector('#connectionStatus').textContent.includes('并非实时状态'));
  assert.equal(await page.locator('.card').count(), 1, '保留上次项目卡片');
});

test('UI：项目概览、文案版本确认、项目草稿与断连恢复（桌面和手机）', { timeout: 30000 }, async t => {
  const { root, dir } = fixture(t), url = await serve(t, root, dir), browser = await launchBrowser(chromium); t.after(() => browser.close());
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.setDefaultTimeout(7000);
    await page.goto(url + '/?p=projects/demo&tab=publish'); await page.waitForSelector('#projectSteps li');
    assert.equal(await page.locator('#projectSteps li').count(), 6);
    if (await page.locator('#confirmPublishVersion').count()) {
      page.on('dialog', dialog => dialog.accept()); await page.click('#confirmPublishVersion');
      await page.waitForFunction(() => document.querySelector('#publishNotice').textContent.includes('已关联当前稿'));
    }
    assert.equal(publishRevision(dir).state, 'current');
    await page.click('#tabs button[data-tab="chat"]'); await page.check('#saveChatDraft'); await page.fill('#chatInput', '还没有发送的修改要求');
    await page.waitForFunction(() => document.querySelector('#chatDraftStatus').textContent.includes('已保存在'));
    await page.reload(); assert.equal(await page.inputValue('#chatInput'), '还没有发送的修改要求');
    await page.route('**/_api/state?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"测试中断"}' }));
    await page.waitForFunction(() => document.querySelector('#stateConnection').textContent.includes('并非实时状态'));
    await page.unroute('**/_api/state?*'); await page.waitForFunction(() => document.querySelector('#stateConnection').textContent === '');
    await page.click('#tabs button[data-tab="publish"]');
    await page.screenshot({ path: path.resolve(`diagnostics/product-ui-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '页面无横向溢出');
    await page.close();
  }
});
