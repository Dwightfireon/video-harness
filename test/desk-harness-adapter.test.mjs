import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessAdapter } from '../desk/harness-adapter.mjs';
import { projectDraft } from '../desk/projects.mjs';

function project(t, file = 'video-voice.mp4') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'projects/demo');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, 'out', file), 'test fixture, not a playable video');
  return { root, dir };
}

test('adapter：一份完整草稿只核验一次，后续请求重新读取不过度缓存', async t => {
  const { root } = project(t);
  let checks = 0;
  const adapter = createHarnessAdapter({ loadHarness: async () => ({
    publish: { parsePublish: () => ({ main: '标题', tags: ['AI'] }), publishStatus: () => ({ ok: true }) },
    cover: { coverStatus: () => ({ ok: false }) },
    artifacts: { artifactStatus: () => {
      checks++;
      return { voice: { media: { duration: 42 } }, deliverable: { stale: checks > 1, reason: checks > 1 ? '源文件已改变' : null } };
    } },
  }) });
  const first = await projectDraft(root, 'demo', adapter);
  assert.equal(checks, 1);
  assert.equal(first.video.duration, 42);
  assert.equal(first.ready, true);
  const second = await projectDraft(root, 'demo', adapter);
  assert.equal(checks, 2);
  assert.equal(second.ready, false);
  assert.match(second.blockers[0].text, /源文件已改变/);
});

test('adapter：静音母版展示自身时长，但不是可提交配音成片', async t => {
  const { dir } = project(t, 'video.mp4');
  const adapter = createHarnessAdapter({ loadHarness: async () => ({ artifacts: { artifactStatus: () => ({
    voice: { media: { duration: 99 } }, render: { media: { duration: 15 } }, deliverable: { stale: false },
  }) } }) });
  const media = await adapter.readMedia(dir);
  assert.equal(media.video.duration, 15);
  assert.equal(media.video.kind, '静音母版');
  assert.equal(media.videoState.stale, true);
  assert.match(media.videoState.reason, /静音母版/);
});

test('adapter：发布复用工作台完整成片合同，不绕过配音身份/历史必审；本轮不重复媒体核验', async t => {
  const { dir } = project(t); let checks = 0;
  const artifact = { stale: false, reason: null };
  const adapter = createHarnessAdapter({ loadHarness: async () => ({
    artifacts: { artifactStatus: () => { checks++; return { voice: { media: { duration: 10 }, fingerprint: { sha256: 'fixture' } }, deliverable: artifact }; } },
    deliverable: { deliverableState: (project, options) => {
      assert.equal(project, dir); assert.equal(options.artifact, artifact);
      return { stale: true, reason: '配音缓存身份已失效：先重测' };
    } },
  }) });
  const media = await adapter.readMedia(dir);
  assert.equal(checks, 1); assert.equal(media.video.fingerprint, 'fixture');
  assert.equal(media.videoState.stale, true); assert.match(media.videoState.reason, /配音缓存身份/);
});

test('adapter：核验异常保留素材信息，但以不可用状态进入草稿', async t => {
  const { root, dir } = project(t);
  const adapter = createHarnessAdapter({ loadHarness: async () => { throw new Error('探测失败'); } });
  const media = await adapter.readMedia(dir);
  assert.equal(media.video.file, 'out/video-voice.mp4');
  assert.equal(media.videoState.stale, true);
  assert.match(media.videoState.reason, /无法核验.*探测失败/);
  const draft = await projectDraft(root, 'demo', {
    readCopy: async () => ({ title: 't' }), readCopyStatus: async () => ({ ok: true }),
    readVideo: async () => media.video,
    readVideoState: async () => { throw new Error('旧 adapter 核验失败'); },
    readCover: async () => ({ ok: false }),
  });
  assert.equal(draft.ready, false);
  assert.match(draft.blockers[0].text, /旧 adapter 核验失败/);
});

test('adapter：每次草稿读取当前审阅声明，不能将缺失或过期证据显示为通过', async t => {
  const { root } = project(t);
  let status = { ok: false, state: 'pending', statuses: { audio: 'pending' }, issues: [{ message: 'audio 审阅未执行' }] };
  const adapter = createHarnessAdapter({ loadHarness: async () => ({
    publish: { parsePublish: () => ({ main: '标题', tags: ['DNS'] }), publishStatus: () => ({ ok: true }) },
    cover: { coverStatus: () => ({ ok: false }) },
    artifacts: { artifactStatus: () => ({ voice: { media: { duration: 10 } }, deliverable: { stale: false } }) },
    review: { releaseReviewStatus: () => status },
  }) });
  const first = await projectDraft(root, 'demo', adapter);
  assert.ok(first.warnings.some(w => w.code === 'review-pending' && /audio/.test(w.text)));
  status = { ok: false, state: 'pending', statuses: { audio: 'pass' }, issues: [{ message: '审阅指纹已过期' }] };
  const second = await projectDraft(root, 'demo', adapter);
  assert.ok(second.warnings.some(w => w.code === 'review-pending' && /过期/.test(w.text)));
  assert.equal(second.warnings.some(w => w.code === 'review-recorded'), false);
});
