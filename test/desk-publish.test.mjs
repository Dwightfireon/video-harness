import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeDraft } from '../desk/draft.mjs';
import { projectDraft, listProjects, resolveProject } from '../desk/projects.mjs';
import { validateInput, splitTags, runPublish, summarizeSteps } from '../desk/publish.mjs';
import { probeImage, coverIssues, coverWarnings, prepareCover, cleanupCover } from '../desk/cover-prep.mjs';

/* 假 adapter：完全不碰 harness 内部，只按约定返回数据。 */
function fakeAdapter(overrides = {}) {
  return {
    readCopy: async () => ({ title: '标题从这里来', alts: ['备选'], desc: '简介第一行\n第二行', comment: '置顶评论',
      tags: ['demo', '测试'], cover: '主：封面\n副：副标' }),
    readCopyStatus: async () => ({ ok: true, revision: 'current', errors: [], warnings: [] }),
    readVideo: async () => ({ file: 'out/video-voice.mp4', path: '/tmp/fake.mp4', kind: '带配音成片', bytes: 1024, duration: 63 }),
    readVideoState: async () => ({ stale: false, reason: null }),
    readCover: async () => ({ ok: true, file: 'cover-16x9.png', path: '/tmp/cover.png', bytes: 4096, thumb: '/tmp/thumb.png' }),
    ...overrides,
  };
}

function projectRoot(t, ids = ['demo']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-desk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of ids) {
    fs.mkdirSync(path.join(root, 'projects', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', id, 'PROJECT.json'), '{}');
  }
  return root;
}

test('composeDraft：把文案/成片/封面组装成草稿，缺项进警告', () => {
  const draft = composeDraft({ id: 'demo', dir: '/tmp/demo',
    copy: { title: '标题', desc: '简介', comment: '评论', tags: ['a', 'b'], cover: '主：主标\n副：副标' },
    copyStatus: { ok: true, revision: 'current', errors: [], warnings: [] },
    video: { file: 'out/video-voice.mp4', path: '/tmp/v.mp4', kind: '带配音成片', bytes: 10, duration: 5 },
    videoState: { stale: false }, cover: { ok: true, file: 'c.png', path: '/tmp/c.png', bytes: 3, thumb: null } });
  assert.equal(draft.fields.title, '标题');
  assert.equal(draft.fields.tags, 'a b');
  assert.equal(draft.copy.coverMain, '主标');
  assert.equal(draft.video.file, 'video-voice.mp4');
  assert.equal(draft.ready, true);
  assert.ok(draft.warnings.some(w => w.code === 'review-unavailable'));
});

test('composeDraft：没有文案/成片/封面时逐项说明，不假装可发布', () => {
  const draft = composeDraft({ id: 'demo', dir: '/tmp/demo', copy: null,
    copyStatus: { ok: false, errors: ['还没有发布文案.md'], warnings: [] },
    video: null, videoState: { stale: false }, cover: { ok: false, reason: '封面未绑定当前输入' } });
  const codes = draft.warnings.map(w => w.code);
  assert.ok(codes.includes('no-copy'));
  assert.ok(codes.includes('no-video'));
  assert.ok(codes.includes('no-cover'));
  assert.equal(draft.ready, false);
  assert.equal(draft.video, null);
});

test('composeDraft：过期成片与封面尺寸问题都进警告', () => {
  const draft = composeDraft({ id: 'demo', dir: '/tmp/demo',
    copy: { title: 't', tags: ['a'] }, copyStatus: { ok: true, errors: [], warnings: [] },
    video: { path: '/tmp/v.mp4', kind: '带配音成片', bytes: 1 }, videoState: { stale: true, reason: '静音成片已过期' },
    cover: { ok: true, path: '/tmp/c.png' }, coverIssues: ['封面比例 1.00:1 不是 16:9'] });
  const texts = draft.warnings.map(w => w.text).join(' | ');
  // 成片与时间轴不符是硬问题：措辞必须说“不能发布”，不能只说“可能过期”。
  assert.match(texts, /成片与当前时间轴不一致，不能按这版发布：静音成片已过期/);
  assert.match(texts, /不是 16:9/);
  assert.equal(draft.warnings.filter(w => w.code === 'video-stale').length, 1);
  assert.equal(draft.ready, false);
  assert.equal(draft.blockers[0].code, 'video-stale');
});

test('composeDraft：缺文案时不重复报告同一件事', () => {
  const draft = composeDraft({ id: 'demo', dir: '/tmp/demo', copy: null,
    copyStatus: { ok: false, errors: ['还没有发布文案.md'], warnings: [] },
    video: { path: '/tmp/v.mp4', kind: '带配音成片', bytes: 1 }, videoState: { stale: false },
    cover: { ok: true, path: '/tmp/c.png' } });
  // no-copy 已经说明缺文案，copy-error 不该再复述一遍。
  assert.equal(draft.warnings.filter(w => w.code === 'copy-error').length, 0);
  assert.equal(draft.warnings.filter(w => w.code === 'no-copy').length, 1);
});

test('projectDraft：通过 adapter 读取，不需要真实视频或 ffmpeg', async t => {
  const root = projectRoot(t);
  const adapter = fakeAdapter();
  const draft = await projectDraft(root, 'demo', adapter);
  assert.equal(draft.fields.title, '标题从这里来');
  // coverIssues 默认空，因为没传检查函数
  assert.equal(draft.cover.ok, true);
  const withIssues = await projectDraft(root, 'demo', adapter, { coverIssues: () => ['封面太小'] });
  assert.ok(withIssues.warnings.some(w => w.text === '封面太小'));
});

test('projectDraft：adapter 抛错时降级为警告，不炸掉整个界面', async t => {
  const root = projectRoot(t);
  const adapter = fakeAdapter({
    readCopy: async () => { throw new Error('文案读不了'); },
    readCover: async () => { throw new Error('封面坏了'); },
  });
  const draft = await projectDraft(root, 'demo', adapter);
  assert.equal(draft.fields.title, '');
  assert.ok(draft.warnings.some(w => w.code === 'no-copy'));
  assert.ok(draft.warnings.some(w => w.code === 'no-cover' && /封面坏了/.test(w.text)));
});

test('listProjects：按 adapter 产出标题与更新时间，并按时间倒序', async t => {
  const root = projectRoot(t, ['old', 'new']);
  const adapter = fakeAdapter({ readCopy: async dir => (dir.endsWith('new') ? { title: '新片子', tags: [] } : null) });
  fs.utimesSync(path.join(root, 'projects/old/PROJECT.json'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const list = await listProjects(root, adapter);
  assert.deepEqual(list.map(item => item.id), ['new', 'old']);
  assert.equal(list[0].title, '新片子');
  assert.equal(list[0].hasCopy, true);
  assert.equal(list[1].hasCopy, false);
});

test('resolveProject：拒绝越界与不存在的项目名', t => {
  const root = projectRoot(t);
  for (const bad of ['..', '.', '../demo', 'demo/../demo', '', 'nope']) {
    assert.throws(() => resolveProject(root, bad), /无效|越界|不是视频项目/);
  }
  assert.equal(resolveProject(root, 'demo'), fs.realpathSync(path.join(root, 'projects/demo')));
});

const DRAFT = { video: { path: '/tmp/v.mp4', file: 'v.mp4' }, cover: { ok: true, path: '/tmp/c.png' } };
const INPUT = { title: '标题', desc: '简介', tags: 'a b', tid: 171, copyright: 1, source: '', cover: true };

test('validateInput：标题/分区/标签/封面/成片的硬约束', () => {
  assert.deepEqual(validateInput(INPUT, DRAFT), []);
  assert.match(validateInput({ ...INPUT, title: '  ' }, DRAFT).join(), /标题不能为空/);
  assert.match(validateInput({ ...INPUT, title: 'x'.repeat(81) }, DRAFT).join(), /80 字上限/);
  assert.match(validateInput({ ...INPUT, tid: 0 }, DRAFT).join(), /没有选择分区/);
  assert.match(validateInput({ ...INPUT, tags: ' ' }, DRAFT).join(), /至少填一个标签/);
  assert.match(validateInput({ ...INPUT, tags: Array.from({ length: 11 }, (_, i) => 't' + i) }, DRAFT).join(), /超过 10 个/);
  assert.match(validateInput({ ...INPUT, copyright: 2 }, DRAFT).join(), /来源/);
  assert.match(validateInput(INPUT, { video: null, cover: { ok: true } }).join(), /没有可用成片/);
  assert.match(validateInput({ ...INPUT, cover: true }, { video: DRAFT.video, cover: { ok: false } }).join(), /没有可用封面/);
  assert.deepEqual(validateInput({ ...INPUT, cover: false }, { video: DRAFT.video, cover: { ok: false } }), []);
});

test('splitTags：中英文逗号、顿号与空格都算分隔', () => {
  assert.deepEqual(splitTags('a,b，c d、e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitTags([' x ', '', 'y']), ['x', 'y']);
  assert.deepEqual(splitTags(null), []);
});

test('草稿分别显示审阅和投稿表单状态，不把审阅待核当成已通过或投稿硬拦截', () => {
  const draft = composeDraft({ id: 'demo', dir: '/tmp/demo',
    copy: { title: 'DNS', tags: ['DNS、域名解析、网络'] }, copyStatus: { ok: true },
    video: { path: '/fake/video.mp4' }, videoState: { stale: false }, cover: { ok: true, path: '/fake/cover.png' },
    review: { ok: false, state: 'pending', statuses: { audio: 'pending' }, issues: [{ message: 'audio 审阅未执行' }] } });
  assert.ok(draft.warnings.some(w => w.code === 'review-pending' && /audio/.test(w.text)));
  assert.equal(draft.review.statuses.audio, 'pending');
  assert.equal(draft.ready, true, '素材状态不自动代替审阅或投稿状态');
  assert.deepEqual(validateInput({ title: draft.fields.title, tags: draft.fields.tags, tid: 231, cover: true }, draft), []);
});

function fakeApi({ failAt = null, upload = { filename: 'abc', chunks: 2 }, submit = { aid: 1, bvid: 'BV1' } } = {}) {
  const calls = [];
  return {
    calls,
    uploadVideo: async file => { calls.push(['video', file]); if (failAt === 'video') throw new Error('上传失败'); return upload; },
    uploadCover: async file => { calls.push(['cover', file]); if (failAt === 'cover') throw new Error('封面失败'); return 'https://c/1.jpg'; },
    buildPayload: input => { calls.push(['payload', input]); return { title: input.title, tag: input.tags.join(','), videos: [{ filename: input.video.filename }], cover: input.cover }; },
    submit: async payload => { calls.push(['submit', payload]); if (failAt === 'submit') throw new Error('投稿被拒'); return submit; },
  };
}
const prepared = file => ({ ok: true, file, temp: false, issues: [], warnings: [] });

test('runPublish：正常顺序是 视频 → 封面 → 提交，并传入标签数组', async () => {
  const api = fakeApi();
  const steps = [];
  const result = await runPublish({ draft: DRAFT, input: INPUT, api, prepareCover: prepared, onStep: s => steps.push(s.name) });
  assert.deepEqual(api.calls.map(c => c[0]), ['video', 'cover', 'payload', 'submit']);
  const payloadInput = api.calls.find(c => c[0] === 'payload')[1];
  assert.deepEqual(payloadInput.tags, ['a', 'b']);
  assert.equal(payloadInput.cover, 'https://c/1.jpg');
  assert.equal(result.ok, true);
  assert.equal(result.result.bvid, 'BV1');
  assert.deepEqual(steps, ['上传视频', '视频已上传', '上传封面', '封面已上传', '提交投稿', '已提交']);
  assert.ok(result.steps.every(s => s.state === 'done'));
});

test('runPublish：不勾封面时跳过封面上传', async () => {
  const api = fakeApi();
  await runPublish({ draft: DRAFT, input: { ...INPUT, cover: false }, api, prepareCover: prepared });
  assert.deepEqual(api.calls.map(c => c[0]), ['video', 'payload', 'submit']);
});

test('runPublish：任一步失败就停下，保留已完成步骤，不重提投稿', async () => {
  for (const [failAt, expected] of [['video', 1], ['cover', 2], ['submit', 2]]) {
    const api = fakeApi({ failAt });
    await assert.rejects(() => runPublish({ draft: DRAFT, input: INPUT, api, prepareCover: prepared }), error => {
      assert.equal(error.message, failAt === 'submit' ? '投稿被拒' : error.message);
      assert.ok(error.steps.some(s => s.state === 'failed'));
      assert.ok(error.steps.length <= 6);
      return true;
    });
    assert.equal(api.calls.filter(c => c[0] === 'submit').length, failAt === 'submit' ? 1 : 0);
    assert.ok(expected >= 1);
  }
});

test('runPublish：参数不合法时一个请求都不发', async () => {
  const api = fakeApi();
  await assert.rejects(() => runPublish({ draft: DRAFT, input: { ...INPUT, tid: 0 }, api, prepareCover: prepared }), /没有选择分区/);
  assert.equal(api.calls.length, 0);
});

test('runPublish：封面不可用时不提交，并清理临时文件', async () => {
  const api = fakeApi();
  let cleaned = 0;
  await assert.rejects(() => runPublish({ draft: DRAFT, input: INPUT, api,
    prepareCover: () => ({ ok: false, issues: ['封面 320×180 太小'], warnings: [] }),
    cleanupCover: () => { cleaned++; } }), /封面不可用：封面 320×180 太小/);
  assert.equal(api.calls.filter(c => c[0] === 'submit').length, 0);
  assert.equal(api.calls.length, 0, '封面预检必须发生在视频上传前');
  assert.equal(cleaned, 1);
});

test('runPublish：成功时也会清理转码产生的临时文件', async () => {
  const api = fakeApi();
  let cleaned = 0;
  await runPublish({ draft: DRAFT, input: INPUT, api,
    prepareCover: file => ({ ok: true, file, temp: true, tempDir: '/tmp/x', issues: [], warnings: [] }),
    cleanupCover: () => { cleaned++; } });
  assert.equal(cleaned, 1);
});

test('summarizeSteps：每步一行，失败带 ✗', () => {
  const text = summarizeSteps([{ name: '上传视频', state: 'done', detail: 'v.mp4' }, { name: '提交投稿', state: 'failed', detail: '拒绝' }]);
  assert.deepEqual(text, ['✓ 上传视频：v.mp4', '✗ 提交投稿：拒绝']);
});

function makeImage(t, { width = 1920, height = 1080, format = 'png' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cover.' + format);
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=navy:s=${width}x${height}`, '-frames:v', '1', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

test('probeImage / coverIssues：尺寸与体积门槛', async t => {
  const small = makeImage(t, { width: 320, height: 180 });
  const info = probeImage(small);
  assert.equal(info.width, 320);
  const issues = coverIssues(info);
  assert.match(issues.join(), /低于 B 站要求/);

  assert.match(coverIssues(null).join(), /无法读取/);
  const big = { width: 1920, height: 1080, bytes: 6 * 1024 * 1024 };
  assert.match(coverIssues(big).join(), /超过 5MB/);
  assert.deepEqual(coverIssues({ width: 1920, height: 1080, bytes: 1000 }), []);
});

test('coverWarnings：非 16:9 与体积偏大只提醒，不阻断', async t => {
  const square = makeImage(t, { width: 1200, height: 1200 });
  const info = probeImage(square);
  assert.match(coverWarnings(info).join(), /不是 16:9/);
  assert.deepEqual(coverWarnings({ width: 1920, height: 1080, bytes: 1000 }), []);
});

test('prepareCover：合规图原样返回，不产生临时文件', async t => {
  const file = makeImage(t);
  const prepared = prepareCover(file);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.temp, false);
  assert.equal(prepared.file, file);
  assert.equal(prepared.info.width, 1920);
  cleanupCover(prepared);
});

test('prepareCover：尺寸过小直接拒绝，不靠放大糊弄', async t => {
  const file = makeImage(t, { width: 320, height: 180 });
  const prepared = prepareCover(file);
  assert.equal(prepared.ok, false);
  assert.match(prepared.issues.join(), /低于 B 站要求/);
});

test('prepareCover：文件缺失时不谎报可用', () => {
  const prepared = prepareCover('/tmp/definitely-not-here-xxxx.png');
  assert.equal(prepared.ok, false);
  assert.match(prepared.issues.join(), /没有封面文件/);
});
