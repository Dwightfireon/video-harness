import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createBiliClient } from '../desk/bili.mjs';
import { createPublishService } from '../desk/service.mjs';
import { buildPayload, validateForm } from '../desk/publish-contract.mjs';
import { flattenHumanPartitions, searchPartitions, validateSelection, PARTITION_TAXONOMY,
  HUMAN_PARTITION_TAXONOMY, HUMAN_COMPAT_TID } from '../desk/partitions.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/desk-partitions-human-type2.json', import.meta.url)));
const list = flattenHumanPartitions(fixture);
const catalog = { live: true, taxonomy: HUMAN_PARTITION_TAXONOMY, list };
const INPUT = { id: 'demo', title: 'Agent 原理', desc: '说明', tags: ['Agent', 'AI'], cover: false,
  partitionTaxonomy: HUMAN_PARTITION_TAXONOMY, humanType2: 1011, confirmed: true };
const video = { filename: 'uploaded-video' };
const cookies = { SESSDATA: 'fake', bili_jct: 'fake' };
const json = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });

test('新版分区：真实单层列表与 AI/Agent 检索，不伪造子分类', () => {
  assert.equal(list.length, 30);
  assert.equal(list.find(p => p.id === 1011).name, '人工智能');
  assert.ok(list.every(p => p.parent === ''));
  assert.equal(list.some(p => p.id === 2096), false, '首页资料列出的子类不是当前投稿接口选项');
  for (const keyword of ['AI', 'Agent', '人工智能']) assert.equal(searchPartitions(list, keyword)[0].id, 1011);
  assert.equal(searchPartitions(list, '计算机科学')[0].id, 1010, '一般计算机课程的检索提示不应误指向 AI');
  assert.deepEqual(flattenHumanPartitions({ type_list: [{ id: 231, name: '旧编号' }, { id: 1011, name: '人工智能' },
    { id: 1011, name: '重复' }, { id: 1010, name: '隐藏', show: false }, null] }).map(p => p.id), [1011]);
});

test('客户端：type_mode=2 即使带旧 typelist 也必须取新版列表，支持注入 origin', async () => {
  const calls = [];
  const api = createBiliClient({ cookies, origin: 'https://member.example.test', fetch: async url => {
    const u = new URL(url); calls.push(u.origin + u.pathname);
    if (u.pathname.endsWith('/archive/pre')) return json({ code: 0, data: { type_mode: 2, is_typeid_revision: 0,
      typelist: [{ id: 188, name: '科技', children: [{ id: 231, name: '计算机技术' }] }] } });
    if (u.pathname.endsWith('/human/type2/list')) return json({ code: 0, data: fixture });
    throw new Error('不该访问 ' + u.pathname);
  } });
  const result = await api.partitions();
  assert.equal(result.taxonomy, HUMAN_PARTITION_TAXONOMY);
  assert.equal(result.typeMode, 2);
  assert.equal(result.live, true);
  assert.equal(result.list.length, 30);
  assert.deepEqual(calls, ['https://member.example.test/x/vupre/web/archive/pre',
    'https://member.example.test/x/vupre/web/archive/human/type2/list']);
});

test('客户端：新版读取失败、空响应不能退回旧分区继续提交', async () => {
  for (const response of [() => json({ code: -101, message: '未登录' }), () => json({ code: 0, data: { type_list: [] } }),
    () => { throw new Error('网络断开'); }]) {
    const api = createBiliClient({ cookies, fetch: async url => url.endsWith('/archive/pre')
      ? json({ code: 0, data: { type_mode: 2, typelist: [{ id: 231, name: '计算机技术' }] } }) : response() });
    const result = await api.partitions();
    assert.equal(result.live, false);
    assert.equal(result.taxonomy, HUMAN_PARTITION_TAXONOMY);
    assert.equal(result.list.some(p => p.id === 231), false);
    assert.ok(validateSelection(INPUT, result).length);
  }
});

test('新版 payload：human_type2=1011，旧 tid 仅用官方兼容值，不把新编号塞旧字段', async () => {
  const calls = [];
  const api = createBiliClient({ cookies, fetch: async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return json({ code: 0, data: { aid: 1, bvid: 'BVtest' } });
  } });
  const payload = api.buildPayload({ ...INPUT, video });
  assert.equal(payload.human_type2, 1011);
  assert.equal(payload.tid, HUMAN_COMPAT_TID);
  assert.notEqual(payload.tid, 1011);
  assert.equal(Object.hasOwn(payload, 'tid_v2'), false);
  await api.submit(payload);
  assert.match(calls[0].url, /\/x\/vu\/web\/add\/v3\?/);
  assert.deepEqual(calls[0].payload, payload);
  const legacy = buildPayload({ title: 't', tags: ['a'], tid: 231, video });
  assert.equal(legacy.tid, 231);
  assert.equal(Object.hasOwn(legacy, 'human_type2'), false);
});

test('新版合同：未选、模式不符、编号混用或列表中没有的选项均阻断', () => {
  assert.deepEqual(validateForm(INPUT), []);
  assert.deepEqual(validateSelection(INPUT, catalog), []);
  assert.ok(validateForm({ ...INPUT, humanType2: 0 }).length);
  assert.ok(validateForm({ ...INPUT, humanType2: 231 }).length);
  assert.ok(validateForm({ ...INPUT, partitionTaxonomy: PARTITION_TAXONOMY, tid: 231 }).length);
  assert.ok(validateForm({ title: 't', tags: ['a'], tid: 1011 }).length);
  assert.ok(validateSelection({ ...INPUT, humanType2: 2096 }, catalog).length);
  assert.match(validateSelection({ title: 't', tags: ['a'], tid: 231 }, catalog).join(), /模式已变化/);
});

test('新版服务：预览/实际提交共用字段，临提交模式切换或新列表失效零上传', async () => {
  const draft = { video: { path: '/fake.mp4', file: 'video.mp4' }, warnings: [], blockers: [] };
  let currentCatalog = catalog, uploads = 0, submissions = 0;
  const service = createPublishService({ getDraft: async () => draft, getCredentials: () => ({ cookies }),
    transaction: { execute: (_context, publish) => publish() },
    prepareCover: () => { throw new Error('本测试不上传封面'); }, cleanupCover: () => {},
    createClient: () => ({ partitions: async () => currentCatalog, buildPayload,
      uploadVideo: async () => { uploads++; return { filename: 'video-id', chunks: 1 }; },
      submit: async () => { submissions++; return { aid: 1, bvid: 'BVtest' }; } }) });
  await service.loadPartitions();
  const preview = await service.plan(INPUT);
  assert.equal(preview.ready, true);
  assert.equal(preview.payload.human_type2, 1011);
  const submitted = await service.submit(INPUT);
  assert.equal(submitted.ok, true);
  assert.equal(submitted.payload.human_type2, 1011);
  assert.equal(submitted.payload.tid, HUMAN_COMPAT_TID);
  assert.equal(uploads, 1);
  assert.equal(submissions, 1);
  currentCatalog = { ...catalog, taxonomy: PARTITION_TAXONOMY, list: [{ id: 231, name: '计算机技术' }] };
  assert.equal((await service.submit(INPUT)).ok, false);
  currentCatalog = { ...catalog, list: catalog.list.filter(p => p.id !== 1011) };
  assert.equal((await service.submit(INPUT)).ok, false);
  assert.equal(uploads, 1);
  assert.equal(submissions, 1);
});
