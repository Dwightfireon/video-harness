import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { readPublishForm, savePublishForm, applyPublishForm, PUBLISH_FORM_FILE } from '../lib/publish-form-store.mjs';
import { readPromotion, savePromotion } from '../lib/publish-promotion-store.mjs';
import { createPublishApi } from '../lib/publish-api.mjs';
import { buildPayload } from '../desk/publish-contract.mjs';
import { publicationState } from '../desk/publication-state.mjs';

const FORM = { title: '手动标题', tags: '网站 测试', desc: '手动简介', cover: false, tid: 231, promotion: { enabled: true } };
const CATALOG = { live: true, taxonomy: 'legacy-tid', list: [{ id: 231, name: '计算机技术' }] };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publish-form-')), dir = path.join(root, 'projects/demo'), home = path.join(root, 'home');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '发布文案.md'), '原始作者文案，不能覆盖');
  const video = path.join(dir, 'fake.mp4'); fs.writeFileSync(video, 'only simulated media');
  const draft = { id: 'demo', dir, fields: { title: '原题', tags: '原标签', desc: '原简介' }, copy: { tags: ['原标签'], comment: '保留原置顶文案' },
    publish: { ok: false }, video: { path: video, file: 'fake.mp4' }, cover: { ok: false }, warnings: [], blockers: [] };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const login = () => { const p = path.join(home, '.config/video-harness'); fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'bilibili.json'), JSON.stringify({ mid: 1, cookies: { SESSDATA: 'mock', bili_jct: 'mock' } })); };
  return { root, dir, home, video, draft, login };
}

test('统一保存是独立、带版本的本机资料；不覆盖作者文案，空标题/标签也能先存草稿', t => {
  const { dir, draft } = fixture(t);
  assert.equal(readPublishForm(dir), null); assert.equal(fs.existsSync(path.join(dir, PUBLISH_FORM_FILE)), false);
  const first = savePublishForm(dir, FORM, 0);
  assert.equal(first.revision, 1); assert.deepEqual(first.fields.tags, ['网站', '测试']);
  assert.deepEqual(first.partition, { partitionTaxonomy: 'legacy-tid', tid: 231, humanType2: 0 });
  assert.equal(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8'), '原始作者文案，不能覆盖');
  const applied = applyPublishForm(draft);
  assert.equal(applied.fields.title, FORM.title); assert.equal(applied.copy.comment, '保留原置顶文案');
  assert.equal(applied.coverWanted, false); assert.equal(publicationState({ draft: applied }).eligible, true);
  assert.match(publicationState({ draft: applied }).label, /资料就绪/);
  savePublishForm(dir, { title: '', tags: '', cover: false }, 1);
  assert.equal(publicationState({ draft: applyPublishForm(draft) }).eligible, false);
});

test('乐观版本冲突不覆盖；字段越界/泄漏或损坏配置不静默放行', t => {
  const { dir } = fixture(t); savePublishForm(dir, FORM, 0);
  assert.throws(() => savePublishForm(dir, { ...FORM, title: '另一个标签页' }, 0), error => error.statusCode === 409);
  assert.equal(readPublishForm(dir).fields.title, FORM.title);
  for (const input of [{ ...FORM, title: '字'.repeat(81) }, { ...FORM, promotion: { enabled: 'false' } }, { ...FORM, desc: 'x'.repeat(2001) }]) {
    assert.throws(() => savePublishForm(dir, input, 1));
  }
  fs.writeFileSync(path.join(dir, PUBLISH_FORM_FILE), '{broken');
  assert.throws(() => readPublishForm(dir), /损坏/); assert.throws(() => readPromotion(dir), /损坏/);
  assert.throws(() => savePublishForm(dir, FORM, 1), /损坏/);
});

test('兼容已保存商业声明：统一保存后只读同一份，旧接口更新不会让两个来源打架', t => {
  const { dir } = fixture(t); savePromotion(dir, { enabled: true, brandName: '旧网站' });
  assert.equal(readPromotion(dir).brandName, '旧网站');
  savePublishForm(dir, { ...FORM, promotion: { enabled: false } }, 0);
  assert.equal(readPromotion(dir).enabled, false);
  savePromotion(dir, { enabled: true, brandName: '新网站' });
  const saved = readPublishForm(dir);
  assert.equal(saved.revision, 2); assert.equal(saved.fields.promotion.brandName, '新网站');
  assert.equal(saved.fields.title, FORM.title);
});

test('无需登录保存，排程使用已存标题/封面选择/声明和排程分区，不启用也不投稿', async t => {
  const f = fixture(t); let deps; const payloads = [];
  const api = createPublishApi({ ...f, getDraft: async () => f.draft,
    schedulerFactory: options => { deps = options; return {}; },
    fetchImpl: async () => { throw new Error('禁止真实网络'); },
    createClient: () => ({ partitions: async () => CATALOG, uploadVideo: async () => ({ filename: 'fake-upload' }), buildPayload,
      uploadCover: async () => { throw new Error('不应该上传封面'); }, submit: async payload => {
        payloads.push(payload); throw Object.assign(new Error('模拟拒绝'), { outcome: 'rejected' });
      } }) });
  api.saveForm({ id: 'demo', revision: 0, form: FORM });
  assert.equal(payloads.length, 0); assert.throws(() => api.saveForm({ id: '../demo', revision: 0, form: FORM }), /无效|越界/);
  const item = (await api.projects())[0];
  assert.equal(item.title, FORM.title); assert.equal(item.coverWanted, false); assert.equal(item.savedForm.revision, 1);
  f.login(); const candidate = await deps.getCandidate('demo'); assert.ok(candidate);
  await deps.submitOne(candidate, { tid: 231 });
  assert.equal(payloads[0].title, FORM.title); assert.equal(payloads[0].cover, ''); assert.equal(payloads[0].porder.flow_id, 1);
});

test('真实进度来自当前操作的上传回调，其他请求不能覆盖；失败分类完整返回', async t => {
  const f = fixture(t); f.login();
  let release, began;
  const started = new Promise(resolve => { began = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const api = createPublishApi({ ...f, getDraft: async () => f.draft, fetchImpl: async () => { throw new Error('禁止真实请求'); },
    createClient: ({ onProgress }) => ({ partitions: async () => CATALOG, buildPayload,
      uploadVideo: async () => { onProgress({ phase: 'upload', bytes: 5, total: 10 }); began(); await hold;
        throw Object.assign(new Error('上传过于频繁'), { httpStatus: 406, code: 21070, outcome: 'not-submitted' }); } }) });
  const request = { ...FORM, id: 'demo', confirmed: true, progressId: 'test-progress-123' };
  const pending = api.submit(request); await started;
  try {
    assert.equal(api.progress({ id: 'demo', progressId: 'wrong-id' }).available, false);
    const progress = api.progress(request); assert.equal(progress.available, true); assert.equal(progress.running, true);
    assert.equal(progress.bytes, 5); assert.equal(progress.total, 10); assert.equal(progress.stage, '上传视频');
    assert.equal((await api.submit({ ...request, progressId: 'second-operation' })).outcome, 'not-submitted');
    assert.equal(api.progress(request).running, true);
  } finally { release(); }
  const result = await pending;
  assert.equal(result.kind, 'rate'); assert.ok(result.waitMs > 0); assert.equal(result.httpStatus, 406);
  assert.equal(api.progress(request).running, false);
});

test('HTTP 保存与进度接口不依赖默认项目，写入仍需同源，冲突保留 409', async t => {
  const { root } = fixture(t), { startServer } = await import('../lib/server.mjs'); let writes = 0;
  const server = startServer(null, 0, { root, home: root, publish: {
    saveForm: input => { writes++; if (input.revision === 99) throw Object.assign(new Error('版本冲突'), { statusCode: 409 }); return { savedForm: input.form }; },
    progress: input => ({ available: false, progressId: input.progressId }),
  } });
  await once(server, 'listening'); t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [origin, revision, expected] of [[base, 0, 200], [base, 99, 409], ['https://evil.example', 0, 403]]) {
    const result = await fetch(base + '/_api/publish/form', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'demo', revision, form: FORM }) });
    assert.equal(result.status, expected);
  }
  assert.equal(writes, 2);
  assert.equal((await (await fetch(base + '/_api/publish/progress?id=demo&progressId=test')).json()).available, false);
});
