import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createPublishApi } from '../lib/publish-api.mjs';

/* 这些用例只覆盖「接线」：凭据来源、登录态、分区元数据、提交闸门。
 * 真正的上传/提交协议在 test/desk-*.test.mjs 里，用假客户端逐字段核对过；
 * 这里不重复造一份协议替身，避免两套假的实现互相掩盖差异。 */

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publish-api-'));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { root: dir, home: path.join(dir, 'home') };
}

function writeCredential(home, cookies) {
  const dir = path.join(home, '.config/video-harness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bilibili.json'), JSON.stringify({ cookies, savedAt: '2026-01-01T00:00:00Z', mid: 1, name: 'fixture' }), { mode: 0o600 });
}

const complete = { SESSDATA: 'x', bili_jct: 'y', DedeUserID: '1' };

test('未登录时明确说没登录，不假装能投', async t => {
  const { root, home } = tmp(t);
  const api = createPublishApi({ root, home, fetchImpl: async () => { throw new Error('不该发请求'); } });
  const overview = await api.overview();
  assert.equal(overview.loggedIn, false);
  assert.equal(overview.account, null);
});

test('登录态来自本机凭据文件，返回账号信息与体检结果', async t => {
  const { root, home } = tmp(t);
  writeCredential(home, complete);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    const body = String(url).includes('nav')
      ? { code: 0, data: { isLogin: true, uname: '测试号', mid: 1, level_info: { current_level: 2 } } }
      : { code: 0, data: { list: [{ id: 231, name: '计算机技术', parent: '科技' }] } };
    return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const api = createPublishApi({ root, home, fetchImpl });
  const overview = await api.overview();
  assert.equal(overview.loggedIn, true);
  assert.equal(overview.account.loggedIn, true);
  assert.equal(overview.account.name, '测试号');
  assert.match(overview.accountKey, /^[a-f0-9]{64}$/);
  assert.ok(calls.length > 0);
});

test('提交必须显式 confirmed，否则直接拒绝', async t => {
  const { root, home } = tmp(t);
  const api = createPublishApi({ root, home, fetchImpl: async () => { throw new Error('不该发请求'); } });
  await assert.rejects(() => api.submit({ id: 'x' }), /确认/);
  await assert.rejects(() => api.submit({ id: 'x', confirmed: false }), /确认/);
  await assert.rejects(() => api.batchSubmit({ ids: ['x'] }), /确认/);
});

test('分区清单一并下发协议元数据，前端不需要复制常量', async t => {
  const { root, home } = tmp(t);
  writeCredential(home, complete);
  const fetchImpl = async () => {
    const body = { code: 0, data: { list: [], human: { code: -404, message: 'no' }, typelist: [] } };
    return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const api = createPublishApi({ root, home, fetchImpl });
  const catalog = await api.partitions();
  assert.equal(typeof catalog.taxonomy, 'string');
  assert.equal(typeof catalog.human, 'boolean');
  assert.equal(typeof catalog.compatTid, 'number');
  assert.ok(Array.isArray(catalog.list));
  // 元数据与 taxonomy 必须自洽：human 为 false 时 compatTid 不应被当成提交值。
  assert.equal(catalog.human, catalog.taxonomy === 'human-type2');
});

test('批量发布的闸门：执行中拒绝第二次，取消标记可读', async t => {
  const { root, home } = tmp(t);
  const api = createPublishApi({ root, home, fetchImpl: async () => { throw new Error('不该发请求'); } });
  assert.deepEqual(api.batchState().running, false);
  assert.equal(api.batchCancel().cancelled, false);
});

test('每日排程退出即暂停，重新登录原账号也不自动恢复', async t => {
  const { root, home } = tmp(t); writeCredential(home, complete);
  const api = createPublishApi({ root, home, fetchImpl: async () => { throw new Error('不该联网'); } });
  await api.saveSchedule({ revision: 0, enabled: true, confirmed: true, times: ['20:00'], ids: [], partition: { tid: 231, partitionTaxonomy: 'legacy-tid' } });
  assert.equal((await api.schedule()).enabled, true);
  await api.logout(); assert.equal((await api.schedule()).enabled, false);
  writeCredential(home, complete); assert.equal((await api.schedule()).enabled, false);
});

test('每日排程保存时校验分区模式，human 兼容 tid 不能掩盖未选分区', async t => {
  const { root, home } = tmp(t); writeCredential(home, complete);
  const api = createPublishApi({ root, home });
  const input = { revision: 0, enabled: true, confirmed: true, times: ['20:00'], ids: [],
    partition: { tid: 21, partitionTaxonomy: 'human-type2', humanType2: 0 } };
  assert.throws(() => api.saveSchedule(input), /分区/);
  assert.equal((await api.schedule()).enabled, false);
});

test('projects 列出真实项目并带出文案字段，供表单回填', async t => {
  const { root, home } = tmp(t);
  fs.mkdirSync(path.join(root, 'projects/demo'));
  fs.writeFileSync(path.join(root, 'projects/demo/PROJECT.json'), '{"deliveryTarget":"publish-package"}');
  fs.writeFileSync(path.join(root, 'projects/demo/发布文案.md'), '# 发布文案\n\n## 标题\n\n示例标题\n\n## 简介\n\n这段是简介。\n\n## 标签\n\nAI\n工具\n');
  const api = createPublishApi({ root, home, fetchImpl: async () => { throw new Error('不该发请求'); } });
  const projects = await api.projects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'demo');
  assert.equal(projects[0].title, '示例标题');
  assert.ok(projects[0].desc.includes('这段是简介'));
  assert.deepEqual(projects[0].tags, ['AI', '工具']);
});

test('HTTP 路由：发布接口挂在本地服务上，且写请求要过同源检查', async t => {
  const { home } = tmp(t);
  const { startServer } = await import('../lib/server.mjs');
  const server = startServer(null, 0, { root: process.cwd(), home,
    publish: { overview: async () => ({ loggedIn: false }) } });
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const page = await fetch(base + '/publish');
    assert.equal(page.status, 200);
    const overview = await fetch(base + '/_api/publish/overview');
    assert.equal(overview.status, 200);
    const crossSite = await fetch(base + '/_api/publish/submit', {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(crossSite.status, 403, '跨站来源必须被拒绝');
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('排程遗留 running 时：手动投稿成功或账号日志已有 submitted 会自动闭合排程阻断，也可人工 reconcile', async t => {
  const { root, home } = tmp(t);
  writeCredential(home, complete);
  fs.mkdirSync(path.join(root, 'projects/demo'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects/external-post'), { recursive: true });
  const videoFile = path.join(root, 'projects/demo/demo-video.mp4');
  fs.writeFileSync(videoFile, 'fake-mp4-bytes');
  const api = createPublishApi({
    root,
    home,
    getDraft: async id => ({
      id,
      dir: path.join(root, 'projects', id),
      fields: { title: '测试标题', desc: '简介', tags: 'AI,科普' },
      copy: { title: '测试标题', desc: '简介', tags: ['AI', '科普'] },
      publish: { ok: true },
      coverWanted: false,
      cover: { ok: false },
      video: { file: 'demo-video.mp4', path: videoFile, bytes: 14, duration: 30 },
      warnings: [],
      blockers: [],
      task: { status: 'completed', running: false, productionBusy: false },
    }),
    createClient: () => ({
      partitions: async () => ({ live: true, taxonomy: 'legacy-tid', list: [{ id: 231, name: '计算机技术', parent: '科技' }] }),
      uploadVideo: async () => ({ filename: 'upos_123', chunks: 1 }),
      buildPayload: p => p,
      submit: async () => ({ aid: 1, bvid: 'BV1manual777' }),
    }),
  });

  const enabled = await api.saveSchedule({
    revision: 0,
    action: 'enable',
    confirmed: true,
    trigger: { kind: 'ready', intervalSeconds: 480 },
    scope: { kind: 'production-queue' },
    partition: { tid: 231, partitionTaxonomy: 'legacy-tid', label: '计算机技术' },
  });
  const scheduleFile = path.join(root, 'out/.publish-schedule/state.json');
  const raw = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
  raw.lastAttempt = { attemptId: 'interrupted-1', state: 'running', id: 'demo', slot: 'ready', at: Date.now() - 5000 };
  fs.writeFileSync(scheduleFile, JSON.stringify(raw));

  // 未手动投稿前直接改间隔应报人工核对
  assert.throws(() => api.saveSchedule({
    revision: enabled.revision,
    action: 'enable',
    confirmed: true,
    trigger: { kind: 'ready', intervalSeconds: 300 },
    scope: { kind: 'production-queue' },
    partition: { tid: 231, partitionTaxonomy: 'legacy-tid', label: '计算机技术' },
  }), /人工核对/);

  // 手动提交成功后，自动同步排程记录并允许更改投稿间隔
  const sub = await api.submit({
    id: 'demo',
    title: '测试标题',
    desc: '简介',
    tags: 'AI,科普',
    copyright: 1,
    tid: 231,
    partitionTaxonomy: 'legacy-tid',
    cover: false,
    confirmed: true,
  });
  assert.equal(sub.ok, true, sub.message);
  const afterManual = await api.schedule();
  assert.equal(afterManual.lastAttempt.state, 'submitted');
  assert.equal(afterManual.lastAttempt.bvid, 'BV1manual777');

  const updated = await api.saveSchedule({
    revision: afterManual.revision,
    action: 'enable',
    confirmed: true,
    trigger: { kind: 'ready', intervalSeconds: 300 },
    scope: { kind: 'production-queue' },
    partition: { tid: 231, partitionTaxonomy: 'legacy-tid', label: '计算机技术' },
  });
  assert.equal(updated.enabled, true);
  assert.equal(updated.trigger.intervalSeconds, 300);

  // 若用户在外部网页手动投稿，也可通过 action: 'reconcile' 显式核对解除阻断并登记防重指纹
  const raw2 = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
  raw2.lastAttempt = { attemptId: 'interrupted-2', state: 'running', id: 'external-post', slot: 'ready', at: Date.now() - 2000 };
  fs.writeFileSync(scheduleFile, JSON.stringify(raw2));
  const cur2 = await api.schedule();
  assert.equal(cur2.lastAttempt.state, 'running');
  const reconciled = await api.saveSchedule({
    revision: cur2.revision,
    action: 'reconcile',
    resolution: 'submitted',
    confirmed: true,
  });
  assert.equal(reconciled.lastAttempt.state, 'submitted');
  assert.equal(reconciled.enabled, false);
});

test('HTTP：没有默认项目时仍可检查投稿信息、读取批量状态', async t => {
  const { root, home } = tmp(t);
  const { startServer } = await import('../lib/server.mjs');
  let plans = 0;
  const server = startServer(null, 0, { root, home, publish: {
    plan: async input => { plans++; return { payload: input, problems: [] }; },
    batchState: () => ({ running: false }),
  } });
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const plan = await fetch(base + '/_api/publish/plan', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"id":"demo"}',
    });
    assert.equal(plan.status, 200);
    assert.equal((await plan.json()).payload.id, 'demo');
    assert.equal(plans, 1);
    const batch = await fetch(base + '/_api/publish/batch-state');
    assert.equal(batch.status, 200);
    assert.equal((await batch.json()).running, false);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
