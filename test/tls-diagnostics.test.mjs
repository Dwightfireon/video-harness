import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskError, finishTask, beginTask, taskStatus } from '../lib/task-status.mjs';
import { tlsDiagnostics, networkCodes, canRetryRequest } from '../lib/network-diagnostics.mjs';
import { stopLogLabel } from '../lib/server.mjs';
import { ProviderRequestError } from '../lib/provider-pool.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tls = (code = 'ERR_TLS_CERT_ALTNAME_INVALID') => {
  const error = new Error('fixture handshake failure');
  error.code = code;
  return error;
};

test('证书域名不匹配显示真实原因，不再只说“网络连接失败”', () => {
  const failures = [{ provider: 'opendesign', kind: 'network', reason: '网络连接失败', attempts: 1,
    diagnostics: { source: 'transport', phase: 'awaiting-headers', elapsedMs: 45, receivedBytes: 0,
      networkCodes: ['ERR_TLS_CERT_ALTNAME_INVALID'] } }];
  const display = taskError({ failures });
  assert.match(display.message, /证书域名不匹配/);
  assert.match(display.message, /ERR_TLS_CERT_ALTNAME_INVALID/);
  assert.match(display.message, /awaiting-headers/);
  assert.doesNotMatch(display.message, /证书来源已确定|上游模型故障/);
});

test('证据不足时不伪造证书来源，只说明校验失败', () => {
  const display = taskError({ failures: [{ provider: 'opendesign', kind: 'network', reason: '网络连接失败',
    diagnostics: { networkCodes: ['CERT_HAS_EXPIRED'] } }] });
  assert.match(display.message, /证书已过期/);
  assert.doesNotMatch(display.message, /代理|Clash|DNS 污染/);
});

test('证书错误不重试、不切渠道', () => {
  const error = new ProviderRequestError('network', { diagnostics: { networkCodes: ['ERR_TLS_CERT_ALTNAME_INVALID'] } });
  assert.equal(canRetryRequest('opendesign', error), false);
  const expired = new ProviderRequestError('network', { diagnostics: { networkCodes: ['CERT_HAS_EXPIRED'] } });
  assert.equal(canRetryRequest('opendesign', expired), false);
  // 临时断连仍允许同渠道重试一次，行为不变。
  assert.equal(canRetryRequest('opendesign', new ProviderRequestError('network', { diagnostics: { networkCodes: ['ECONNRESET'] } })), true);
});

test('TLS 诊断只保留请求主机与证书指纹，不泄露 SAN、异常正文或凭证', () => {
  const cert = { fingerprint256: 'AA:'.repeat(31) + 'BB', subjectaltname: 'DNS:evil.example.com' };
  const error = Object.assign(new Error('OpenDesign secret-key-abc 私人原文'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID', cert });
  const diag = tlsDiagnostics(error, 'https://amr-link.open-design.ai/v1', ['secret-key-abc']);
  assert.equal(diag.expectedHostname, 'amr-link.open-design.ai');
  assert.equal(diag.fingerprint256, 'AA:'.repeat(31) + 'BB');
  const text = JSON.stringify(diag);
  for (const bad of ['evil.example.com', 'secret-key-abc', '私人原文']) assert.equal(text.includes(bad), false, bad);
  assert.deepEqual(networkCodes(error), ['ERR_TLS_CERT_ALTNAME_INVALID']);
});

test('非证书错误与超长/非法值不产生 TLS 诊断', () => {
  assert.equal(tlsDiagnostics(Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'https://a.example'), null);
  const error = Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    cert: { fingerprint256: 'private-ish' } });
  assert.equal(tlsDiagnostics(error, 'https://a.example').fingerprint256, undefined);
  assert.equal(tlsDiagnostics(error, 'not a url').expectedHostname, undefined);
});

test('暂停任务再继续，不会把暂停原因当成失败错误', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const task = beginTask(dir, '原目标', 'article');
  finishTask(dir, task.id, { status: 'paused', paused: '连续 60 步没有推进任何产出', warns: [] }, task.attemptId);
  const status = taskStatus(dir);
  assert.equal(status.status, 'paused');
  assert.equal(status.error, null);
  assert.match(status.resumeNotice, /没有推进|步数/);
  assert.equal(status.canResume, true);
});

test('失败与暂停的理由不会互相覆盖', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-stop2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const task = beginTask(dir, '原目标', 'article');
  finishTask(dir, task.id, { status: 'failed', error: 'boom',
    providerFailures: [{ provider: 'opendesign', kind: 'network', reason: '网络连接失败',
      diagnostics: { networkCodes: ['ERR_TLS_CERT_ALTNAME_INVALID'] } }] }, task.attemptId);
  const status = taskStatus(dir);
  assert.equal(status.status, 'failed');
  assert.match(status.error.message, /证书域名不匹配/);
});

/* 真实事故：预算耗尽按设计退出 0，日志却写“══ 完成 ══”，
   与紧邻的“达到 400 步上限”直接矛盾。 */
test('暂停退出 0 不能写成“完成”，其他停止状态也不混淆', () => {
  assert.match(stopLogLabel('paused', 0), /已暂停/);
  assert.doesNotMatch(stopLogLabel('paused', 0), /^完成$/);
  assert.equal(stopLogLabel('completed', 0), '完成');
  assert.match(stopLogLabel('failed', 1), /任务失败（退出 1）/);
  assert.match(stopLogLabel('cancelled', 130), /已取消/);
  assert.match(stopLogLabel('interrupted', 1), /任务未完成（退出 1）/);
  assert.match(stopLogLabel('failed', null, 'SIGTERM'), /信号 SIGTERM/);
});
