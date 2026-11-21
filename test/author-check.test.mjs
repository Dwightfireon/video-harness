import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runAuthorCheck } from '../lib/author-check.mjs';
import { skillDir } from '../lib/state.mjs';
import { describeEvent, toolOutcome, recoveredAfterError } from '../lib/runners/opencode.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sha = v => createHash('sha256').update(v).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-author-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'research'));
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '方案.md'), '# 方案\n');
  // Deliberate structural failure and semantic pending: must survive reuse.
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 解释\n1. 因为可靠性下降，所以任务的稳定性下降。\n← 依赖：S9\n');
  return dir;
}
function cli(dir, args = [], env = process.env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'vh.mjs'), 'author-check', '--dir', dir, ...args], { env, encoding: 'utf8' });
}
function fakeSkill(dir, code) {
  const skill = path.join(dir, 'skill');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# fixture');
  fs.writeFileSync(path.join(skill, 'scripts/check-script.mjs'), code);
  return skill;
}

test('同一输入只执行一次；完整失败和待核可反复查看，不变成语义通过', t => {
  const dir = fixture(t); let executed = 0;
  const first = runAuthorCheck(dir, { onExecute: () => executed++ });
  const second = runAuthorCheck(dir, { onExecute: () => executed++ });
  const shown = runAuthorCheck(dir, { show: true, onExecute: () => executed++ });
  assert.equal(executed, 1);
  assert.equal(first.cached, false); assert.equal(second.cached, true);
  assert.equal(shown.exitCode, 1);
  assert.ok(shown.fail.length && shown.pending.length);
  assert.equal(shown.semanticStatus, 'not-verified');
  for (const k of ['stdout', 'stderr', 'exitCode', 'fail', 'pending']) assert.deepEqual(shown[k], first[k]);
});

test('稿件、方案、配置、研究文件内容及新增/删除均失效；过期 --show 不偷偷重跑', t => {
  const dir = fixture(t);
  runAuthorCheck(dir);
  for (const file of ['脚本.md', '方案.md', 'PROJECT.json', 'vh.config.json', 'research/a.md']) {
    fs.appendFileSync(path.join(dir, file), '\nchanged');
    assert.throws(() => runAuthorCheck(dir, { show: true }), /当前输入版本/);
    assert.equal(runAuthorCheck(dir).cached, false, file);
    assert.equal(runAuthorCheck(dir).cached, true, file);
  }
  fs.unlinkSync(path.join(dir, 'research/a.md'));
  assert.equal(runAuthorCheck(dir).cached, false);
  assert.equal(runAuthorCheck(dir, { terms: '可靠率' }).cached, false);
});

test('锚引用的非 Markdown 原文和冻结锚变化也使缓存失效', t => {
  const dir = fixture(t), text = 'Original evidence: probability r^H only if steps are independent.';
  fs.writeFileSync(path.join(dir, 'research/paper.txt'), text);
  const a = { id: 'formula', source: { path: 'research/paper.txt', sha256: sha(text), quote: text }, supports: 'r^H', conditions: ['independent'], scenes: [1] };
  fs.writeFileSync(path.join(dir, '方案.md'), '```evidence-anchors\n' + JSON.stringify([a]) + '\n```');
  runAuthorCheck(dir);
  fs.appendFileSync(path.join(dir, 'research/paper.txt'), ' changed');
  const changed = runAuthorCheck(dir);
  assert.equal(changed.cached, false); assert.match(changed.stdout, /SHA-256/);
  fs.writeFileSync(path.join(dir, 'out/.vh-runner.json'), JSON.stringify({ authorEvidence: { version: 1, anchors: [a] } }));
  assert.equal(runAuthorCheck(dir).cached, false);
  assert.equal(runAuthorCheck(dir).cached, true);
});

test('损坏或篡改的缓存不复用；缺失 result 不崩溃、不当成功', t => {
  const dir = fixture(t); runAuthorCheck(dir);
  const file = path.join(dir, 'out/.vh-author-check.json');
  const valid = JSON.parse(fs.readFileSync(file));
  for (const bad of ['{bad', JSON.stringify({ ...valid, result: undefined }),
    JSON.stringify({ ...valid, result: { ...valid.result, exitCode: 0 } })]) {
    fs.writeFileSync(file, bad);
    assert.throws(() => runAuthorCheck(dir, { show: true }), /当前输入版本/);
    assert.equal(runAuthorCheck(dir).cached, false);
  }
});

test('执行期间输入改变不落可复用回执；旧结果不能 --show', t => {
  const dir = fixture(t); runAuthorCheck(dir);
  fs.appendFileSync(path.join(dir, '方案.md'), 'before');
  const result = runAuthorCheck(dir, { onExecute: () => fs.appendFileSync(path.join(dir, '脚本.md'), '\nchanged during check') });
  assert.equal(result.cacheable, false);
  assert.throws(() => runAuthorCheck(dir, { show: true }), /当前输入版本/);
  assert.equal(runAuthorCheck(dir).cached, false);
});

test('越界研究软链接、损坏会话回执和未声明 preload 依赖关闭复用', t => {
  const dir = fixture(t), outside = fixture(t);
  const target = path.join(outside, 'paper.md'); fs.writeFileSync(target, 'first');
  fs.symlinkSync(target, path.join(dir, 'research/paper.md'));
  assert.equal(runAuthorCheck(dir).cacheable, false);
  fs.writeFileSync(target, 'second');
  assert.equal(runAuthorCheck(dir).cached, false);
  fs.unlinkSync(path.join(dir, 'research/paper.md'));
  fs.writeFileSync(path.join(dir, 'out/.vh-runner.json'), '{broken');
  assert.equal(runAuthorCheck(dir).cacheable, false);
  fs.unlinkSync(path.join(dir, 'out/.vh-runner.json'));
  const old = process.env.NODE_OPTIONS;
  t.after(() => { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; });
  process.env.NODE_OPTIONS = '--no-warnings';
  assert.equal(runAuthorCheck(dir).cacheable, false);
});

test('未知脚本检查器直接执行 argv、不缓存，非零退出不能被外层吞掉；更换检查器生效', t => {
  const dir = fixture(t);
  const skill = fakeSkill(dir, 'console.log("FULL REPORT: pending");console.error("internal failure");process.exit(7);');
  const first = runAuthorCheck(dir, { kind: 'script', skill });
  assert.equal(first.exitCode, 1); assert.equal(first.cacheable, false);
  assert.match(first.stdout, /FULL REPORT/); assert.match(first.stderr, /internal failure/);
  assert.equal(runAuthorCheck(dir, { kind: 'script', skill }).cached, false);
  const proc = cli(dir, ['--kind', 'script', '--skill', skill]);
  assert.equal(proc.status, 1); assert.match(proc.stderr, /internal failure/);
  fs.writeFileSync(path.join(skill, 'scripts/check-script.mjs'), 'console.log("new checker: still pending");');
  const next = runAuthorCheck(dir, { kind: 'script', skill });
  assert.equal(next.exitCode, 0); assert.notEqual(first.key, next.key);
  assert.equal(next.semanticStatus, 'not-verified');
});

test('缺失 skill 给出明确未执行错误，而不是 path.join(null) 类型错误', t => {
  const dir = fixture(t);
  const proc = cli(dir, ['--kind', 'script'], { ...process.env, HOME: dir, ARTICLE_VIDEO_SKILL_DIR: '' });
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr + proc.stdout, /找不到 article-video skill/);
});

test('真实 CLI 跨进程重放完整失败报告，--show 保留非零状态', t => {
  const dir = fixture(t), skill = fakeSkill(dir, '// not executed for clarity');
  const args = ['--kind', 'clarity', '--skill', skill, '--json'];
  const first = cli(dir, args), second = cli(dir, [...args, '--show']);
  assert.equal(first.status, 1, first.stderr); assert.equal(second.status, 1, second.stderr);
  const a = JSON.parse(first.stdout), b = JSON.parse(second.stdout);
  assert.equal(a.cached, false); assert.equal(b.cached, true);
  assert.equal(a.stdout, b.stdout); assert.deepEqual(a.pending, b.pending);
  fs.appendFileSync(path.join(dir, '脚本.md'), '\nchanged');
  const stale = cli(dir, [...args, '--show']);
  assert.equal(stale.status, 1); assert.match(stale.stderr + stale.stdout, /当前输入版本/);
});

test('已知共享检查器真实本地运行可复用；原文、选项变化失效', t => {
  const skill = skillDir(), checker = skill && path.join(skill, 'scripts/check-script.mjs');
  if (!checker || !fs.existsSync(checker) || sha(fs.readFileSync(checker)) !== 'dc6b7f7eca343d7844cd1a5466603009b3a9488cf888174d66c6de84d86b2cbc') {
    t.skip('optional local shared checker version not available'); return;
  }
  const dir = fixture(t); let executions = 0;
  const opts = { kind: 'script', skill, onExecute: () => executions++ };
  const first = runAuthorCheck(dir, opts), repeat = runAuthorCheck(dir, opts);
  assert.equal(executions, 1); assert.equal(repeat.cached, true);
  assert.equal(first.exitCode, repeat.exitCode); assert.equal(first.stdout, repeat.stdout);
  fs.writeFileSync(path.join(dir, 'research/notes.md'), '# 可直接引用\n- independent steps\n');
  assert.equal(runAuthorCheck(dir, opts).cached, false);
  assert.equal(runAuthorCheck(dir, { ...opts, terms: '概率' }).cached, false);
});

test('本地检查代码/语义锚依赖变更使缓存失效（隔离副本，不改生产源码）', t => {
  const dir = fixture(t), copy = path.join(dir, 'lib');
  fs.cpSync(path.join(ROOT, 'lib'), copy, { recursive: true });
  const url = pathToFileURL(path.join(copy, 'author-check.mjs')).href;
  const execute = () => {
    const code = `import { runAuthorCheck } from ${JSON.stringify(url)}; console.log(JSON.stringify(runAuthorCheck(${JSON.stringify(dir)})));`;
    const proc = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr); return JSON.parse(proc.stdout);
  };
  assert.equal(execute().cached, false); assert.equal(execute().cached, true);
  for (const name of ['clarity.mjs', 'author-evidence.mjs', 'author-check.mjs', 'state.mjs']) {
    fs.appendFileSync(path.join(copy, name), '\n// dependency fingerprint regression\n');
    assert.equal(execute().cached, false, name);
    assert.equal(execute().cached, true, name);
  }
});

test('明确失败退出不标完成；exit 0 的 traceback 只标不确定，不作为错误恢复证据', () => {
  const shell = (output, exit) => ({ type: 'tool_use', part: { tool: 'shell', state: { status: 'completed', output, metadata: { metadata: { exit } } } } });
  const failed = shell('failed', 2), uncertain = shell('Traceback (most recent call last):\nAssertionError\nchecker passed', 0);
  assert.equal(toolOutcome(failed), 'failed'); assert.match(describeEvent(failed), /失败退出/);
  assert.equal(toolOutcome(uncertain), 'uncertain'); assert.match(describeEvent(uncertain), /不能凭外层退出码/);
  // Could be a quotation: do not promote a text heuristic to definite failure.
  assert.equal(toolOutcome(shell('Quoted example:\nTraceback (most recent call last):\n...', 0)), 'uncertain');
  assert.equal(recoveredAfterError([{ type: 'error' }, uncertain, { type: 'text', part: { text: 'answer' } }]), false);
  assert.equal(recoveredAfterError([{ type: 'error' }, failed, { type: 'text', part: { text: 'answer' } }]), false);
});

test('历史 B2 第241行 Python 断言失败+shell exit 0 不能算改稿成功', t => {
  const log = path.join(ROOT, 'diagnostics/writing-exp-round2-20261112/runs/B2/out/.vh-exp-events.ndjson');
  if (!fs.existsSync(log)) { t.skip('local historical artifacts unavailable'); return; }
  const event = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[240]);
  assert.match(event.part.state.output, /AssertionError/);
  assert.equal(toolOutcome(event), 'uncertain');
  assert.ok(!describeEvent(event).includes('shell 完成'));
});
