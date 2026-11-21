import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPublishError, videoFingerprint, checkBeforePublish, recordAttempt, journalSummary,
  DEFAULT_COOLDOWN_MS } from '../lib/publish-guard.mjs';

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-guard-'));
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const rateError = () => ({ message: '申请上传线路 失败：HTTP 406 您上传视频过快，请您稍作休息后再继续', outcome: 'not-submitted', code: 406 });

test('406 风控归类为 rate，明确说没有稿件被创建', () => {
  const result = classifyPublishError(rateError());
  assert.equal(result.kind, 'rate');
  assert.equal(result.retryable, true);
  assert.ok(result.waitMs > 0);
  assert.match(result.advice, /没有稿件被创建/);
});

test('只有错误码没有文案时，406 仍然按风控处理，不当成普通失败', () => {
  assert.equal(classifyPublishError({ message: '申请上传线路 失败', code: 406 }).kind, 'rate');
});

test('-412 归为风控拦截，建议先查账号而不是重试', () => {
  const result = classifyPublishError({ message: '请求被拦截', code: -412 });
  assert.equal(result.kind, 'risk');
  assert.equal(result.retryable, false);
  assert.match(result.advice, /创作中心|账号/);
});

test('提交阶段结果未知时不建议重试', () => {
  const result = classifyPublishError({ message: '提交投稿结果无法确认', step: '提交投稿', outcome: 'unknown' });
  assert.equal(result.kind, 'unknown');
  assert.equal(result.retryable, false);
  assert.match(result.advice, /稿件管理/);
});

test('明确拒绝（rejected）可以改完再试', () => {
  const result = classifyPublishError({ message: '投稿被拒绝：标题不合规', outcome: 'rejected' });
  assert.equal(result.kind, 'rejected');
  assert.equal(result.retryable, true);
});

test('成片指纹使用全量 SHA-256，内容改变会换指纹', t => {
  const dir = tmp(t);
  const a = path.join(dir, 'a.mp4'), b = path.join(dir, 'b.mp4');
  fs.writeFileSync(a, Buffer.alloc(4096, 1));
  fs.writeFileSync(b, Buffer.alloc(4096, 2));
  const fa = videoFingerprint(a), fb = videoFingerprint(b);
  assert.equal(fa.length, 64);
  assert.notEqual(fa, fb);
  assert.equal(videoFingerprint(path.join(dir, 'missing.mp4')), null);
});

test('冷却期内拒绝再次提交，过时后放行', t => {
  const root = tmp(t);
  const now = Date.now();
  recordAttempt(root, { project: 'p', title: 't', outcome: 'rejected', kind: 'rate', message: '406' });
  const blocked = checkBeforePublish(root, { project: 'p', fingerprint: null, now });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'cooldown');
  assert.ok(blocked.waitMs > 0);
  const later = checkBeforePublish(root, { project: 'p', fingerprint: null, now: now + DEFAULT_COOLDOWN_MS + 1000 });
  assert.equal(later.ok, true);
});

test('同一支成片已经发过时阻断重复', t => {
  const root = tmp(t);
  recordAttempt(root, { project: 'p', bvid: 'BV1xx', title: 't', fingerprint: 'abc123', outcome: 'submitted' });
  const result = checkBeforePublish(root, { project: 'p', fingerprint: 'abc123' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate');
  assert.equal(result.bvid, 'BV1xx');
  // 换了一支片子不受影响
  assert.equal(checkBeforePublish(root, { project: 'p', fingerprint: 'other' }).ok, true);
});

test('上次结果未知时要求人工核对，30 分钟后仍然阻断', t => {
  const root = tmp(t);
  const now = Date.now();
  recordAttempt(root, { project: 'p', title: 't', outcome: 'unknown', kind: 'unknown' });
  const blocked = checkBeforePublish(root, { project: 'p', now });
  assert.equal(blocked.reason, 'unknown');
  assert.match(blocked.message, /稿件管理/);
  const later = checkBeforePublish(root, { project: 'p', now: now + 31 * 60 * 1000 });
  assert.equal(later.reason, 'unknown');
});

test('不同成片的成功不阻断另一个项目；摘要不含正文', t => {
  const root = tmp(t);
  recordAttempt(root, { project: 'a', title: '甲的标题', outcome: 'submitted', bvid: 'BV1' });
  assert.equal(checkBeforePublish(root, { project: 'b', now: Date.now() }).ok, true);
  const summary = journalSummary(root, 'a');
  assert.equal(summary.length, 1);
  assert.equal(summary[0].bvid, 'BV1');
  assert.ok(!('message' in summary));
});

test('日志文件权限是 0600，且不含成片二进制内容', t => {
  const root = tmp(t);
  recordAttempt(root, { project: 'p', title: '标题', fingerprint: 'ff', outcome: 'submitted' });
  const file = path.join(root, 'out/.vh-publish-journal.json');
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, '投稿记录只给本用户读');
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /标题/);
  assert.ok(raw.length < 2000, '只记元数据，不记内容');
});
