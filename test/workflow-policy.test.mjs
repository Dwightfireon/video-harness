import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workflowPolicy, workflowPrompt, configureWorkflow } from '../lib/workflow-policy.mjs';
import { knownRendererReviewGate } from '../lib/renderer-upgrade.mjs';
import { performanceRendererSource } from '../lib/renderer-performance-upgrade.mjs';
import { secureRendererSource } from '../lib/renderer-security-upgrade.mjs';
import { skillDir } from '../lib/state.mjs';
import { scriptSubjectIssue } from '../lib/script-metadata.mjs';

function fixture(t, metadata = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-workflow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify(metadata));
  return dir;
}

test('默认内容优先是只读策略，不因自动推进而启用审核', t => {
  const dir = fixture(t, { automation: true }), before = fs.readFileSync(path.join(dir, 'PROJECT.json'));
  assert.deepEqual(workflowPolicy(dir), { version: 1, profile: 'content-first', editorialDiagnostics: false,
    visualAudit: false, qualityProfile: 'technical', releaseReviewRequired: false, claimsRequired: false });
  assert.match(workflowPrompt(dir), /不要求审核签字/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'PROJECT.json')), before);
  assert.deepEqual(fs.readdirSync(dir), ['PROJECT.json']);
});

test('主动审校不等于付费模型授权；已有必审合同独立保留', t => {
  const dir = fixture(t, { custom: '保留', contentReview: { required: true, version: 3 } });
  assert.equal(workflowPolicy(dir).claimsRequired, true);
  assert.equal(workflowPolicy(dir).releaseReviewRequired, false);
  configureWorkflow(dir, 'audited');
  assert.equal(workflowPolicy(dir).qualityProfile, 'strict');
  assert.equal(workflowPolicy(dir).releaseReviewRequired, true);
  configureWorkflow(dir, 'content-first');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'PROJECT.json')));
  assert.equal(saved.custom, '保留');
  assert.deepEqual(saved.contentReview, { required: true, version: 3 });
  assert.equal(workflowPolicy(dir).claimsRequired, true);
  const backups = fs.readdirSync(path.join(dir, 'out/.vh-workflow-backups'));
  assert.equal(backups.length, 2);
  const optional = fixture(t, { contentReview: { required: false } });
  configureWorkflow(optional, 'audited');
  assert.equal(JSON.parse(fs.readFileSync(path.join(optional, 'PROJECT.json'))).contentReview.required, false);
});

test('错误策略不能默默降级为无审核或写坏配置', t => {
  const dir = fixture(t, { workflow: { profile: 'typo' } });
  assert.throws(() => workflowPolicy(dir), /workflow.profile/);
  const before = fs.readFileSync(path.join(dir, 'PROJECT.json'));
  assert.throws(() => configureWorkflow(dir, 'anything'), /工作流/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'PROJECT.json')), before);
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{broken');
  assert.throws(() => workflowPolicy(dir), SyntaxError);
});

test('默认不把开场逐字重复主体名称当作提交门槛，元数据和正文不被改写', () => {
  const text = '主体：甲与乙\n\n## S1 · 开场\n1. 甲和乙各有不同的用途。\n';
  assert.match(scriptSubjectIssue(text), /前两句/);
  assert.equal(scriptSubjectIssue(text, { opening: false }), null);
  assert.match(scriptSubjectIssue('## S1 · 开场\n1. 正文。\n', { opening: false }), /脚本头部/);
});

test('CLI 可显式切换模式，读策略与帮助不启动制作', t => {
  const dir = fixture(t), cli = path.resolve('vh.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, 'workflow', '--dir', dir, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(JSON.parse(run('--json').stdout).profile, 'content-first');
  const selected = run('--profile', 'audited', '--json');
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(JSON.parse(selected.stdout).qualityProfile, 'strict');
  const help = run('--help');
  assert.equal(help.status, 0); assert.match(help.stdout, /content-first\|audited/);
  const rejected = run('--profile', 'bad');
  assert.equal(rejected.status, 1);
  assert.equal(workflowPolicy(dir).profile, 'audited');
});

test('renderer 重复审核仅对完整哈希匹配的已知模板略过，标记不能冒充身份', t => {
  const template = path.join(skillDir() || '', 'assets/render.mjs');
  if (!fs.existsSync(template)) return t.skip('本机没有共享模板');
  const original = fs.readFileSync(template, 'utf8'), optimized = performanceRendererSource(original);
  assert.ok(optimized);
  const current = secureRendererSource(optimized) || optimized;
  assert.equal(knownRendererReviewGate(current, original), true);
  assert.equal(knownRendererReviewGate(current + '\n// custom', original), false);
  assert.equal(knownRendererReviewGate('/* vh:renderer-performance-v1 */\nthrow new Error("custom")', original), false);
  assert.equal(knownRendererReviewGate(current, original + '\n// custom'), false);
});
