import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectProgress, reviewRequired } from '../www/project-progress.mjs';

const delivered = () => ({ script: [{}], stale: {}, sceneM: 1, timing: { state: 'valid' },
  delivery: { video: { state: 'checked' }, publish: { required: true, ok: true, revision: { state: 'current' } },
    review: { state: 'pending' } } });

test('content-first progress delivers without a human record and offers watch/export, not mandatory continue', () => {
  const state = delivered(), view = projectProgress(state, { status: 'completed', canResume: false });
  assert.equal(reviewRequired(state), false);
  assert.equal(view.headline, '视频已交付');
  assert.equal(view.steps.find(step => step.id === 'review').state, 'optional');
  assert.match(view.steps.find(step => step.id === 'review').note, /未验证.*不阻塞/);
  assert.equal(view.next.tab, 'video'); assert.match(view.next.label, /观看.*下载/);
  assert.match(view.next.detail, /pack.*导出/);
  assert.doesNotMatch(view.next.label, /继续|审阅/);
});

test('audited or explicitly required review remains a mandatory next action', () => {
  for (const explicit of [false, true]) {
    const state = delivered();
    state.workflow = { profile: explicit ? 'content-first' : 'audited' };
    if (explicit) state.delivery.review.required = true;
    const view = projectProgress(state);
    assert.equal(view.steps.find(step => step.id === 'review').state, 'pending');
    assert.match(view.headline, /等待必需/); assert.equal(view.next.label, '去审阅成片');
    assert.equal(reviewRequired(state), true);
  }
});

test('optional review never conceals stale media, pending copy or a running/failed production task', () => {
  const state = delivered(); state.delivery.video.state = 'stale';
  assert.equal(projectProgress(state).next.label, '去继续制作');
  state.delivery.video.state = 'checked'; state.delivery.publish.ok = false;
  assert.equal(projectProgress(state).next.tab, 'publish');
  state.delivery.publish.ok = true;
  assert.match(projectProgress(state, { running: true, stage: 'voice' }).headline, /正在制作/);
  const paused = projectProgress(state, { status: 'failed', canResume: true, error: { message: '技术核验失败' } });
  assert.equal(paused.next.label, '查看原因并继续'); assert.equal(paused.next.detail, '技术核验失败');
});
