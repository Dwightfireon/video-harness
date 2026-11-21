import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeScriptMetadataText, normalizeScriptMetadata, scriptSubjectIssue } from '../lib/script-metadata.mjs';
import { skillDir } from '../lib/state.mjs';

const narration = '\n## S1 · 对比\n1. ChatGPT 负责对话，Codex 负责代码。\n2. 这一期讲清楚两者的区别。\n← 依赖：无\n';
function fixture(t, text) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-script-metadata-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  if (text !== undefined) fs.writeFileSync(path.join(project, '脚本.md'), text);
  return project;
}
const source = project => fs.readFileSync(path.join(project, '脚本.md'));
const history = project => fs.existsSync(path.join(project, 'out/.vh-edit-history'))
  ? fs.readdirSync(path.join(project, 'out/.vh-edit-history')) : [];

test('normalizes only explicit subject metadata and paired strong markup without choosing a main subject', () => {
  for (const [input, expected] of [
    ['> 主体：ChatGPT 与 Codex', '> **主体**：ChatGPT 与 Codex'],
    ['> 主体：**ChatGPT 与 Codex**', '> **主体**：ChatGPT 与 Codex'],
    ['主体: **ChatGPT** 与 **Codex**', '**主体**: ChatGPT 与 Codex'],
    ['__主体__ : __Claude Code__（对比 ChatGPT）', '**主体** : Claude Code（对比 ChatGPT）'],
    ['**主体：** ChatGPT', '**主体**： ChatGPT'],
    ['__主体:__ ChatGPT', '**主体**: ChatGPT'],
    ['**主体**：ChatGPT *beta* **', '**主体**：ChatGPT *beta* **'],
    ['主体：****ChatGPT****', '**主体**：****ChatGPT****'],
    ['主体：`**ChatGPT**`', '**主体**：`**ChatGPT**`'],
    ['主体：\\**ChatGPT**', '**主体**：\\**ChatGPT**'],
  ]) {
    const text = input + narration, normalized = normalizeScriptMetadataText(text);
    assert.equal(normalized, expected + narration);
    assert.equal(normalizeScriptMetadataText(normalized), normalized);
  }
});

test('preserves BOM, line endings, spacing, notes and every scene byte', () => {
  const text = '\ufeff# 片名\r\n> 主体 :  **ChatGPT** 与 **Codex**（比较对象）  \r\n> 承诺：原样\r\n'
    + '## S1 · 开场\r\n主体：**场内值**\r\n1. **ChatGPT** 与 Codex。\r\n';
  assert.equal(normalizeScriptMetadataText(text), text.replace('> 主体 :  **ChatGPT** 与 **Codex**', '> **主体** :  ChatGPT 与 Codex'));
});

test('ignores fenced examples (backticks, tildes, quoted fences) and stops at the first real scene', () => {
  const sample = '```md\n主体：**代码示例**\n## S99 · 假场次\n```\n'
    + '> ~~~~md\n> 主体：其他示例\n> ~~~\n> 主体：仍在围栏\n> ~~~~\n';
  const text = sample + '> 主体：**ChatGPT**\n' + narration + '\n主体：**后续字段**\n';
  assert.equal(normalizeScriptMetadataText(text), sample + '> **主体**：ChatGPT\n' + narration + '\n主体：**后续字段**\n');
  for (const boundary of ['## S1', '##S1', '  ## S1 · 开场']) {
    const body = boundary + '\n主体：ChatGPT\n';
    assert.equal(normalizeScriptMetadataText(body), body);
  }
});

test('does not invent subjects from prose, missing keys, placeholders, examples or ambiguous duplicate fields', () => {
  for (const text of [
    '# ChatGPT 与 Codex\n' + narration, '这次的主体：ChatGPT\n' + narration,
    '示例：主体：ChatGPT\n' + narration, '    主体：ChatGPT\n' + narration,
    '```md\n主体：ChatGPT\n```\n' + narration, '> 主体：\n' + narration,
    ...['<名字>', '【主体名称】', '[填名字]', '待补充', 'TODO', '示例：ChatGPT'].map(value => '> 主体：**' + value + '**\n' + narration),
    '主体：ChatGPT\n主体：Codex\n' + narration,
  ]) assert.equal(normalizeScriptMetadataText(text), text);
});

test('file normalization uses exact-byte backup and is an inode/mtime-preserving no-op on the second run', t => {
  const text = '\ufeff# 脚本\r\n> 主体：**ChatGPT 与 Codex**\r\n' + narration;
  const project = fixture(t, text), file = path.join(project, '脚本.md');
  fs.chmodSync(file, 0o640);
  const result = normalizeScriptMetadata(project);
  assert.equal(result.changed, true);
  assert.equal(source(project).toString(), normalizeScriptMetadataText(text));
  assert.deepEqual(fs.readFileSync(path.join(project, result.backup_path)), Buffer.from(text));
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  const before = fs.statSync(file);
  assert.equal(normalizeScriptMetadata(project).changed, false);
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(history(project).length, 1);
});

test('missing script/key/placeholder makes no author file or backup', t => {
  const project = fixture(t);
  assert.equal(normalizeScriptMetadata(project).missing, true);
  assert.equal(fs.existsSync(path.join(project, '脚本.md')), false);
  for (const text of [narration, '> 主体：<名字>\n' + narration]) {
    fs.writeFileSync(path.join(project, '脚本.md'), text);
    const before = fs.statSync(path.join(project, '脚本.md'));
    assert.equal(normalizeScriptMetadata(project).changed, false);
    assert.equal(fs.statSync(path.join(project, '脚本.md')).ino, before.ino);
    assert.deepEqual(history(project), []);
  }
});

test('invalid UTF-8, NUL and symlinks (including dangling links) fail closed before backups', t => {
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('主体：ChatGPT\0')]) {
    const project = fixture(t, bytes);
    assert.throws(() => normalizeScriptMetadata(project), error => error.code === 'NOT_TEXT');
    assert.deepEqual(source(project), bytes);
    assert.deepEqual(history(project), []);
  }
  const other = fixture(t, '主体：ChatGPT\n');
  for (const target of [path.join(other, '脚本.md'), path.join(other, 'absent.md')]) {
    const project = fixture(t);
    fs.symlinkSync(target, path.join(project, '脚本.md'));
    assert.throws(() => normalizeScriptMetadata(project), error => error.code === 'INVALID_PATH');
    assert.equal(fs.readlinkSync(path.join(project, '脚本.md')), target);
    assert.deepEqual(history(project), []);
  }
});

test('paged reads handle long documents and reject concurrent changes rather than overwrite them', t => {
  const text = '# 标题\n'.repeat(1002) + '主体：**ChatGPT**\n' + narration;
  const project = fixture(t, text);
  assert.equal(normalizeScriptMetadata(project).changed, true);
  assert.equal(source(project).toString(), normalizeScriptMetadataText(text));
  fs.writeFileSync(path.join(project, '脚本.md'), text);
  const target = fs.realpathSync(path.join(project, '脚本.md'));
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === target && ++reads === 2) fs.appendFileSync(file, '外部修订');
    return read(file, ...args);
  });
  assert.throws(() => normalizeScriptMetadata(project), error => error.code === 'STALE_BASE_HASH');
  assert.equal(source(project).toString(), text + '外部修订');
  assert.equal(history(project).length, 1);
});

test('CAS rejects a change between normalization read and exact patch without making a backup', t => {
  const text = '主体：**ChatGPT**\n' + narration, project = fixture(t, text);
  const target = fs.realpathSync(path.join(project, '脚本.md'));
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === target && ++reads === 2) fs.appendFileSync(file, '外部修订');
    return read(file, ...args);
  });
  assert.throws(() => normalizeScriptMetadata(project), error => error.code === 'STALE_BASE_HASH');
  assert.equal(source(project).toString(), text + '外部修订');
  assert.deepEqual(history(project), []);
});

test('build normalizes before dispatching the generator, logs backup, and rejects invalid source first', t => {
  const project = fixture(t, '> 主体：**ChatGPT 与 Codex**\n' + narration);
  fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  // This is a sentinel, not a real model, generator, TTS or render invocation.
  fs.writeFileSync(path.join(project, 'gen.mjs'), 'import fs from "node:fs";console.log("GEN_SCRIPT="+JSON.stringify(fs.readFileSync("脚本.md","utf8")));process.exit(23);');
  const run = () => spawnSync(process.execPath, [path.resolve('vh.mjs'), 'build', '--dir', project], { encoding: 'utf8', timeout: 10000 });
  const result = run();
  assert.equal(result.status, 23, result.stdout + result.stderr);
  assert.match(result.stdout, /仅规范化.*多主体顺序未改.*原稿备份/);
  assert.match(result.stdout, /GEN_SCRIPT=.*\*\*主体\*\*：ChatGPT 与 Codex/);
  assert.equal(history(project).length, 1);
  fs.writeFileSync(path.join(project, '脚本.md'), Buffer.from([0xff]));
  const rejected = run();
  assert.notEqual(rejected.status, 0);
  assert.doesNotMatch(rejected.stdout, /GEN_SCRIPT=/);
  assert.deepEqual(source(project), Buffer.from([0xff]));
});

const skill = skillDir('');
const checker = skill && path.join(skill, 'scripts/check-script.mjs');
test('提交前指出多主体开场不匹配，不删对象、不修改原稿或等到 build 才消耗修复额度', () => {
  const text = '> 主体：**ChatGPT 与 Codex**\n' + narration;
  assert.match(scriptSubjectIssue(text), /前两句没有完整点名.*保留全部比较对象/);
  assert.equal(scriptSubjectIssue(text.replace('ChatGPT 负责对话，Codex 负责代码。', 'ChatGPT 与 Codex 有什么区别？')), null);
  assert.equal(scriptSubjectIssue('> 主体：**ChatGPT**\n' + narration), null);
  assert.match(scriptSubjectIssue('```md\n主体：ChatGPT\n```\n' + narration), /须明确写/);
});
test('actual read-only strict checker: formatting fixed; multi-subject exact-match failure remains explicit', { skip: !checker || !fs.existsSync(checker) }, t => {
  const project = fixture(t, '> 主体：**ChatGPT**\n' + narration);
  const file = path.join(project, '脚本.md');
  const run = () => {
    const before = source(project);
    const result = spawnSync(process.execPath, [checker, file], { cwd: project, encoding: 'utf8', timeout: 10000 });
    assert.deepEqual(source(project), before); // checker must remain read-only
    return result;
  };
  const before = run();
  assert.equal(before.status, 1);
  assert.match(before.stdout, /没写 \*\*主体\*\*/);
  normalizeScriptMetadata(project);
  const fixed = run();
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.match(fixed.stdout, /前两句已点名主体「ChatGPT」/);
  fs.writeFileSync(file, '> 主体：**ChatGPT 与 Codex**\n' + narration);
  normalizeScriptMetadata(project);
  const multiple = run();
  assert.equal(multiple.status, 1);
  assert.match(multiple.stdout, /FAIL 前两句没点名主体「ChatGPT 与 Codex」/);
  assert.equal(source(project).toString(), '> **主体**：ChatGPT 与 Codex\n' + narration);
  // Correct content-side repair preserves both names: explicitly introduce both
  // together in the opening, rather than silently picking one in metadata.
  fs.writeFileSync(file, source(project).toString().replace('ChatGPT 负责对话，Codex 负责代码。', 'ChatGPT 与 Codex 有什么区别？'));
  const explicitOpening = run();
  assert.equal(explicitOpening.status, 0, explicitOpening.stdout + explicitOpening.stderr);
});
