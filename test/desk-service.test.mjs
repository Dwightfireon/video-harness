import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublishService } from '../desk/service.mjs';
import { buildPayload, validateInput } from '../desk/publish-contract.mjs';
import { runPublish } from '../desk/publish.mjs';
import { PARTITION_TAXONOMY } from '../desk/partitions.mjs';

const INPUT = { id: 'demo', title: 'Agent 入门', tags: 'AI,Agent', desc: '简介', tid: 231,
  copyright: 1, cover: true, noReprint: true, dynamic: '动态', confirmed: true };
const DRAFT = { video: { path: '/fake/video.mp4', file: 'video.mp4' },
  cover: { ok: true, path: '/fake/cover.png', file: 'cover.png' }, warnings: [], blockers: [] };
const CATALOG = { live: true, taxonomy: PARTITION_TAXONOMY, list: [{ id: 231, name: '计算机技术', parent: '科技' }] };
const prepared = file => ({ ok: true, file, issues: [], warnings: [] });

function setup(options = {}) {
  const calls = [];
  const api = {
    partitions: async () => { calls.push('partitions'); return CATALOG; },
    uploadVideo: async () => { calls.push('video'); return { filename: 'video-id', chunks: 1 }; },
    uploadCover: async () => { calls.push('cover'); return 'https://example.com/cover.jpg'; },
    buildPayload,
    submit: async payload => { calls.push('submit'); return { aid: 1, bvid: 'BVtest', payload }; },
    ...options.api,
  };
  const service = createPublishService({ getDraft: async () => DRAFT,
    // Contract-only fixture; durable protection is exercised by publish-transaction tests.
    transaction: { execute: (_context, publish) => publish() },
    getCredentials: () => ({ cookies: { SESSDATA: 'test', bili_jct: 'test' } }),
    createClient: () => api, prepareCover: prepared, cleanupCover: () => {}, ...options.deps });
  return { service, api, calls };
}

test('服务：预览无网络，正式提交重取分区，预览与提交 payload 合同一致', async () => {
  const { service, calls } = setup();
  const offline = await service.plan(INPUT);
  assert.equal(offline.ready, false);
  assert.deepEqual(calls, []);
  await service.loadPartitions();
  const preview = await service.plan(INPUT);
  assert.equal(preview.ready, true);
  assert.deepEqual(calls, ['partitions']);
  const submitted = await service.submit(INPUT);
  assert.equal(submitted.outcome, 'submitted');
  assert.deepEqual(calls, ['partitions', 'partitions', 'video', 'cover', 'submit']);
  const normalize = p => ({ ...p, cover: '(cover)', videos: p.videos.map(v => ({ ...v, filename: '(file)' })) });
  assert.deepEqual(normalize(preview.payload), normalize(submitted.payload));
});

test('预览和模拟提交对顿号分隔的发布文案使用同一标签合同', async () => {
  const { service } = setup();
  const input = { ...INPUT, tags: 'DNS、域名解析、计算机网络' };
  await service.loadPartitions();
  const preview = await service.plan(input);
  const submitted = await service.submit(input);
  assert.equal(preview.payload.tag, 'DNS,域名解析,计算机网络');
  assert.equal(submitted.payload.tag, preview.payload.tag);
});

test('服务：分区不存在/已切换/离线/查询失败均不上传', async () => {
  for (const catalog of [{ ...CATALOG, list: [] }, { ...CATALOG, live: false }, { ...CATALOG, taxonomy: 'tid_v2' }, null]) {
    const { service, calls } = setup({ api: { partitions: async () => {
      calls.push('partitions'); if (!catalog) throw new Error('网络错误'); return catalog;
    } } });
    const result = await service.submit(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'not-submitted');
    assert.deepEqual(calls, ['partitions']);
  }
});

test('服务：非法版权、简介超限、过期视频在任何请求前阻断', async () => {
  for (const input of [{ ...INPUT, copyright: 3 }, { ...INPUT, desc: 'a'.repeat(2001) }]) {
    const { service, calls } = setup();
    assert.equal((await service.submit(input)).ok, false);
    assert.deepEqual(calls, []);
    assert.throws(() => buildPayload({ ...input, video: { filename: 'test' } }));
  }
  const draft = { ...DRAFT, blockers: [{ code: 'video-stale', text: '无法核验成片' }] };
  const { service, calls } = setup({ deps: { getDraft: async () => draft } });
  assert.match((await service.submit(INPUT)).message, /无法核验/);
  assert.deepEqual(calls, []);
  assert.match(validateInput(INPUT, draft).join(), /无法核验/);
});

test('服务：明确确认是必要条件，执行中不能重复提交', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { service, calls } = setup({ api: { uploadVideo: async () => {
    calls.push('video'); await blocked; return { filename: 'file', chunks: 1 };
  } } });
  await assert.rejects(() => service.submit({ ...INPUT, confirmed: false }), /确认/);
  assert.deepEqual(calls, []);
  const first = service.submit(INPUT);
  const second = await service.submit(INPUT);
  assert.equal(second.ok, false);
  assert.match(second.message, /正在执行/);
  release();
  assert.equal((await first).ok, true);
  assert.equal(calls.filter(c => c === 'submit').length, 1);
});

test('执行：封面预检零上传，清理/通知异常不抹掉已提交结果或原始失败', async () => {
  const { api, calls } = setup();
  let cleaned = 0;
  await assert.rejects(() => runPublish({ draft: DRAFT, input: INPUT, api,
    prepareCover: () => ({ ok: false, issues: ['太小'] }), cleanupCover: () => { cleaned++; } }), /太小/);
  assert.equal(cleaned, 1);
  assert.deepEqual(calls, []);
  const result = await runPublish({ draft: DRAFT, input: INPUT, api, prepareCover: prepared,
    onStep: () => { throw new Error('窗口关闭'); }, cleanupCover: () => { throw new Error('清理失败'); } });
  assert.equal(result.outcome, 'submitted');
  assert.ok(result.warnings.some(w => /清理/.test(w)));
  assert.ok(result.warnings.some(w => /通知/.test(w)));
  const { service } = setup({ api: { submit: async () => { throw Object.assign(new Error('拒绝原因'), { outcome: 'rejected' }); } },
    deps: { cleanupCover: () => { throw new Error('不能覆盖拒绝原因'); } } });
  const failed = await service.submit(INPUT);
  assert.equal(failed.message, '拒绝原因');
  assert.equal(failed.outcome, 'rejected');
  assert.ok(failed.warnings.some(w => /清理/.test(w)));
});

test('服务：提交响应未知与明确拒绝区分，失败不自动重提', async () => {
  for (const outcome of ['unknown', 'rejected']) {
    let count = 0;
    const { service } = setup({ api: { submit: async () => {
      count++; throw Object.assign(new Error('失败'), outcome === 'rejected' ? { outcome } : {});
    } } });
    const result = await service.submit(INPUT);
    assert.equal(result.outcome, outcome);
    assert.equal(result.stage, 'submit');
    assert.equal(count, 1);
  }
});
