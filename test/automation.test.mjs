import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { automationPolicy, configureAutomation, automationWriteRefusal, productionFailure, productionRepairWork, productionRepairSignature, webAutomationPolicy } from '../lib/automation.mjs';

test('自动制作须显式启用，设置备份且模型不能提高预算或破坏配置', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-automation-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'PROJECT.json'); fs.writeFileSync(file, '{"title":"preserve"}');
  assert.equal(automationPolicy(dir).enabled, false);
  assert.deepEqual(configureAutomation(dir, { enabled: true, maxRepairs: 2 }), { enabled: true, maxRepairs: 2 });
  assert.equal(JSON.parse(fs.readFileSync(file)).title, 'preserve');
  assert.equal(fs.readdirSync(path.join(dir, 'out/.vh-automation-backups')).length, 1);
  assert.match(automationWriteRefusal(dir, 'PROJECT.json', '{}'), /不能修改/);
  assert.match(automationWriteRefusal(dir, 'PROJECT.json', 'broken'), /合法 JSON/);
  assert.equal(automationWriteRefusal(dir, '脚本.md', 'text'), null);
  const before = productionRepairSignature(dir);
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  assert.notEqual(productionRepairSignature(dir), before, '证据表修复也是真实输入推进，不能永远卡在修复阶段');
  for (const maxRepairs of [-1, 6, 1.2]) assert.throws(() => automationPolicy(dir, { enabled: true, maxRepairs }));
});
test('自动修复预算跨恢复保留，改文件不能清零；相同输入同错误不原样重跑', () => {
  const failed = sourceSignature => ({ stage: 'render', reason: '版式溢出，S1 正文压住字幕', sourceSignature, maxRepairs: 2 });
  const first = productionFailure({}, failed('a')); assert.equal(first.history.length, 1);
  const work = productionRepairWork(first); assert.equal(work.stage, 'author_edit'); assert.match(work.note, /不要为视觉错误删减旁白/);
  assert.match(productionFailure(first, failed('a')).stop, /输入未变/);
  const recovered = JSON.parse(JSON.stringify({ ...first, pending: null }));
  const second = productionFailure(recovered, failed('b')); assert.equal(second.history.length, 2);
  assert.match(productionFailure({ ...second, pending: null }, failed('c')).stop, /2 轮上限/);
});
test('环境/未知失败不让模型改内容，无修复预算时直接停止', () => {
  for (const reason of ['没有 playwright，无法测量版式', '检查执行失败：超时', 'ENOSPC', 'exit=23']) {
    const result = productionFailure({}, { stage: 'render', reason, sourceSignature: 'a' });
    assert.ok(result.stop); assert.equal(result.history.length, 0); assert.equal(productionRepairWork(result), null);
  }
  assert.match(productionFailure({}, { stage: 'render', reason: '字幕丢字', maxRepairs: 0 }).stop, /0 轮上限/);
});
test('网页默认直接自动制作；保留明确关闭/预算，只读和单项修改不扩成全片任务', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-web-auto-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'PROJECT.json'); fs.writeFileSync(file, '{}');
  for (const mode of ['article', 'topic', 'edit']) assert.equal(webAutomationPolicy(dir, mode, '完成视频').enabled, true);
  for (const mode of ['edit-copy', 'edit-visual', 'edit-script']) assert.equal(webAutomationPolicy(dir, mode, '执行').enabled, false);
  assert.equal(webAutomationPolicy(dir, 'edit', '检查画面有没有问题').enabled, false);
  assert.equal(webAutomationPolicy(dir, 'edit', '先讨论，不要修改文件').enabled, false);
  assert.equal(webAutomationPolicy(dir, 'article', '原文有“先分析”这句话').enabled, true);
  fs.writeFileSync(file, '{"automation":{"enabled":true,"maxRepairs":4}}');
  assert.equal(webAutomationPolicy(dir, 'article').maxRepairs, 4);
  fs.writeFileSync(file, '{"automation":{"enabled":false,"maxRepairs":1}}');
  assert.equal(webAutomationPolicy(dir, 'topic').enabled, false);
  assert.equal(automationPolicy(dir).enabled, false);
});
