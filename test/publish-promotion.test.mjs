import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { buildPayload, validateForm, normalizeForm } from '../desk/publish-contract.mjs';
import { normalizePromotion } from '../desk/promotion.mjs';
import { createBiliClient } from '../desk/bili.mjs';
import { createPublishService } from '../desk/service.mjs';
import { createPublishApi } from '../lib/publish-api.mjs';
import { readPromotion, savePromotion, PROMOTION_FILE } from '../lib/publish-promotion-store.mjs';

const INPUT = { title: '网站使用介绍', desc: '介绍网站的功能', tags: ['网站'], tid: 231, video: { filename: 'fake-upload' } };
const CATALOG = { live: true, taxonomy: 'legacy-tid', list: [{ id: 231, name: '计算机技术' }] };
const response = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-promotion-'));
  const dir = path.join(root, 'projects/demo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir };
}

test('只勾选即可组装商业声明；空补充项不传，不虚构行业或花火订单', () => {
  assert.equal(buildPayload(INPUT).porder, undefined);
  const input = { ...INPUT, promotion: { enabled: true, brandName: '  ', industryId: '', showTypes: [] } };
  assert.deepEqual(validateForm(input), []);
  assert.deepEqual(buildPayload(input).porder, { flow_id: 1, official: 0 });
  assert.deepEqual(buildPayload(input).creation_statement, { id: 3 });
  assert.deepEqual(buildPayload({ ...normalizeForm(input), video: INPUT.video }).porder, { flow_id: 1, official: 0 });
});

test('填写网站名或补充项则准确映射；取消声明不泄漏此前资料', () => {
  const promotion = { enabled: true, brandName: ' 示例网站 ', industryId: 9, showTypes: [11, 13, 11] };
  assert.deepEqual(buildPayload({ ...INPUT, promotion }).porder,
    { flow_id: 1, official: 0, brand_name: '示例网站', industry_id: 9, show_type: '11,13' });
  assert.deepEqual(buildPayload({ ...normalizeForm({ ...INPUT, promotion }), video: INPUT.video }).porder,
    buildPayload({ ...INPUT, promotion }).porder, 'runPublish 的规范化不能丢声明');
  assert.equal(buildPayload({ ...INPUT, promotion: { ...promotion, enabled: false } }).porder, undefined);
  for (const promotion of [{ enabled: 'false' }, { enabled: true, brandName: '字'.repeat(81) },
    { enabled: true, industryId: -1 }, { enabled: true, showTypes: ['not-an-id'] }, { enabled: true, showTypes: '11,13' }]) {
    assert.throws(() => buildPayload({ ...INPUT, promotion }), /商业|推广/);
  }
});

test('商业选项来自 B 站 pre，只读且不硬编码行业；HTTP 提交真实 JSON 保留 porder', async () => {
  const calls = [];
  const api = createBiliClient({ cookies: { SESSDATA: 'fake', bili_jct: 'fake' }, fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes('/archive/pre')) return response({ code: 0, data: {
      industry_list: [{ id: 9, name: '软件应用' }, { id: -1, name: '非法' }], showtype_list: [{ id: 11, name: '口播' }] } });
    return response({ code: 0, data: { aid: 1, bvid: 'BV1234567890' } });
  } });
  assert.deepEqual(await api.promotionOptions(), { industries: [{ id: 9, name: '软件应用' }], showTypes: [{ id: 11, name: '口播' }] });
  const payload = api.buildPayload({ ...INPUT, promotion: { enabled: true } }); await api.submit(payload);
  assert.deepEqual(JSON.parse(calls[1].body).porder, { flow_id: 1, official: 0 });
  assert.equal(calls.length, 2); assert.equal(calls[0].method, 'GET');
});

test('预览、正式提交和旧入口都沿用已保存声明；显式不勾选可覆盖', async () => {
  const submitted = [];
  const draft = { video: { path: '/fake/video', file: 'video.mp4' }, warnings: [], promotion: { enabled: true } };
  const service = createPublishService({ getDraft: async () => draft,
    getCredentials: () => ({ cookies: { SESSDATA: 'fake', bili_jct: 'fake' } }),
    transaction: { execute: (_context, publish) => publish() }, prepareCover: () => {},
    createClient: () => ({ partitions: async () => CATALOG, uploadVideo: async () => ({ filename: 'fake-upload' }), buildPayload,
      submit: async payload => { submitted.push(payload); return { aid: 1, bvid: 'BV1234567890' }; } }) });
  await service.loadPartitions();
  const preview = await service.plan({ ...INPUT, id: 'demo', cover: false });
  assert.equal(preview.promotionSupported, true); assert.deepEqual(preview.payload.porder, { flow_id: 1, official: 0 });
  assert.equal(preview.promotionProtocolVersion, 2); assert.deepEqual(preview.payload.creation_statement, { id: 3 });
  const result = await service.submit({ ...INPUT, id: 'demo', cover: false, confirmed: true });
  assert.deepEqual(result.payload.porder, preview.payload.porder);
  assert.deepEqual(result.payload.creation_statement, preview.payload.creation_statement);
  assert.equal(result.declarationVerification.state, 'unverified', '模拟客户端没有回读，不能报已确认');
  await service.submit({ ...INPUT, id: 'demo', cover: false, confirmed: true, promotion: { enabled: false } });
  assert.equal(submitted[1].porder, undefined);
});

test('平台拒绝缺资料时只提交一次，保留原错误，不去掉声明重发', async () => {
  let count = 0;
  const service = createPublishService({ getDraft: async () => ({ video: { path: '/fake/video' }, warnings: [] }),
    getCredentials: () => ({ cookies: { SESSDATA: 'fake', bili_jct: 'fake' } }),
    transaction: { execute: (_context, publish) => publish() }, prepareCover: () => {},
    createClient: () => ({ partitions: async () => CATALOG, uploadVideo: async () => ({ filename: 'fake-upload' }), buildPayload,
      submit: async payload => { count++; assert.equal(payload.porder.flow_id, 1); throw Object.assign(new Error('平台要求补充推广资料'), { outcome: 'rejected' }); } }) });
  const result = await service.submit({ ...INPUT, id: 'demo', cover: false, confirmed: true, promotion: { enabled: true } });
  assert.equal(result.outcome, 'rejected'); assert.equal(result.message, '平台要求补充推广资料'); assert.equal(count, 1);
});

test('项目声明独立持久化，旧项目不写回，损坏配置不能静默当成未声明', t => {
  const { root, dir } = fixture(t);
  assert.deepEqual(readPromotion(dir), normalizePromotion());
  assert.equal(fs.existsSync(path.join(dir, PROMOTION_FILE)), false);
  savePromotion(dir, { enabled: true });
  assert.equal(readPromotion(dir).enabled, true);
  const second = path.join(root, 'projects/second'); fs.mkdirSync(second);
  assert.equal(readPromotion(second).enabled, false);
  fs.writeFileSync(path.join(dir, PROMOTION_FILE), '{broken');
  assert.throws(() => readPromotion(dir), /损坏/);
  savePromotion(dir, { enabled: false }); assert.equal(readPromotion(dir).enabled, false);
});

test('保存 API 无需登录，不发布；排程与批量使用已保存声明，未保存手动值不污染它', async t => {
  const { root, dir } = fixture(t), home = path.join(root, 'home');
  const credentialDir = path.join(home, '.config/video-harness'); fs.mkdirSync(credentialDir, { recursive: true });
  const video = path.join(dir, 'video.mp4'); fs.writeFileSync(video, 'fake video bytes');
  const payloads = []; let scheduleDeps;
  const api = createPublishApi({ root, home, getDraft: async () => ({ dir, fields: { title: INPUT.title, desc: INPUT.desc, tags: INPUT.tags },
    video: { path: video, file: 'video.mp4' }, warnings: [], copy: {} }),
    schedulerFactory: deps => { scheduleDeps = deps; return {}; },
    createClient: () => ({ partitions: async () => CATALOG, uploadVideo: async () => ({ filename: 'fake-upload' }), buildPayload,
      submit: async payload => { payloads.push(payload); throw Object.assign(new Error('模拟平台拒绝'), { outcome: 'rejected' }); } }),
    fetchImpl: async () => { throw new Error('禁止真实网络'); } });
  assert.equal(api.savePromotion({ id: 'demo', promotion: { enabled: true } }).promotion.enabled, true);
  assert.equal(payloads.length, 0);
  assert.equal((await api.projects())[0].promotion.enabled, true);
  assert.throws(() => api.savePromotion({ id: '../demo', promotion: { enabled: true } }), /无效|越界/);
  await assert.rejects(() => api.promotionCatalog(), /登录/);
  fs.writeFileSync(path.join(credentialDir, 'bilibili.json'), JSON.stringify({ mid: 1, cookies: { SESSDATA: 'fake', bili_jct: 'fake' } }));
  await api.submit({ ...INPUT, id: 'demo', cover: false, confirmed: true, promotion: { enabled: false } });
  assert.equal(payloads[0].porder, undefined); assert.equal(readPromotion(dir).enabled, true);
  await scheduleDeps.submitOne({ id: 'demo', draft: { fields: { title: INPUT.title, tags: INPUT.tags } }, publication: { state: 'ready' } }, { tid: 231 });
  assert.equal(payloads[1].porder.flow_id, 1);
  assert.deepEqual(payloads[1].creation_statement, { id: 3 });
  await api.batchSubmit({ ids: ['demo'], tid: 231, confirmed: true });
  assert.equal(payloads[2].porder.flow_id, 1);
  assert.deepEqual(payloads[2].creation_statement, { id: 3 });
});

test('新 HTTP 接口可在没有默认项目时调用，跨站保存仍被拒绝', async t => {
  const { root } = fixture(t);
  const { startServer } = await import('../lib/server.mjs');
  const saved = [];
  const server = startServer(null, 0, { root, home: root, publish: {
    promotionCatalog: async () => ({ industries: [], showTypes: [] }),
    savePromotion: input => { saved.push(input); return { promotion: input.promotion }; },
  } });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/_api/publish/promotion-catalog')).status, 200);
  for (const [origin, status] of [[base, 200], ['https://evil.example', 403]]) {
    const result = await fetch(base + '/_api/publish/promotion', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'demo', promotion: { enabled: true } }) });
    assert.equal(result.status, status);
  }
  assert.equal(saved.length, 1);
});
