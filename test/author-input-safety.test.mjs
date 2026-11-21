import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareAuthorEdit, readEditFile, patchText, replaceScene, appendText } from '../lib/author-edits.mjs';
import { makeTools } from '../lib/agent.mjs';
import { stageContract, STAGE_TOOLS } from '../lib/pipeline-contract.mjs';
import { writeSceneDraft, sceneDraftStatus } from '../lib/scene-drafts.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const scene = n => `// @layout 合法布局 ${n}\n/* 本场说明 */\nroot => {\n  const box = ${n * 100}, label = box + 20, wire = label + 8;\n  globalThis.__vhSafetyExecuted = true;\n  return { render(t) { void [box, label, wire, t]; } };\n}`;
const source = () => '// 文件注释\n' + scene(1) + '\n\n//---\n\n' + scene(2) + '\n// 末尾注释\n';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-input-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 第一场\n1. 原旁白。\n\n## S2 · 第二场\n1. 原旁白。\n');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), source());
  return dir;
}
const read = (dir, name = 'scenes.src.js') => fs.readFileSync(path.join(dir, name), 'utf8');
const base = (dir, name = 'scenes.src.js') => readEditFile(dir, name).base_hash;
const history = dir => fs.existsSync(path.join(dir, 'out/.vh-edit-history')) ? fs.readdirSync(path.join(dir, 'out/.vh-edit-history')) : [];
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test('initial drafts and later edits agree on block, expression and function builders without evaluating JS', t => {
  for (const content of [
    'root => { const label="before"; return { render(t){ void label; } }; }',
    'root => ({label:"before",render(t){void t;}})',
    '(root) => ({label:"before",render(t){void t;}})',
    'function(root) { const label="before"; return {render(t){void label;}}; }',
  ]) {
    const dir=fixture(t);
    fs.writeFileSync(path.join(dir,'scenes.src.js'),content+'\n//---\n'+scene(2));
    writeSceneDraft(dir,1,content);
    assert.deepEqual(sceneDraftStatus(dir).present,[1]);
    const result=patchText(dir,'scenes.src.js',{base_hash:base(dir),find:'"before"',replace:'"after"'});
    assert.deepEqual(result.affectedScenes,[1]);assert.ok(read(dir).includes('"after"'));
  }
});

test('initial generation cannot save a renderless scene that editing would reject', t => {
  const dir=fixture(t),before=read(dir);
  assert.throws(()=>writeSceneDraft(dir,1,'root=>({title:"no render"})'),/render/);
  assert.equal(read(dir),before);assert.equal(sceneDraftStatus(dir),null);
});
function contract(dir, n = 1, target = 'scenes.src.js') {
  const schemas = [...new Set(Object.values(STAGE_TOOLS).flat())].map(name => ({ function: { name } }));
  return stageContract({ stage: 'author_edit', path: target, allowed: STAGE_TOOLS.author_edit }, { schemas, project: dir, scene: { scene: n } });
}

test('pure candidate allows linked scene changes and comments/layout tags, with source-only impact', () => {
  const before = source();
  const candidate = prepareAuthorEdit('scenes.src.js', before, { operation: 'patch_text',
    find: 'const box = 100, label = box + 20, wire = label + 8;',
    replace: '/* 联动调整 */ const box = 130, label = box + 30, wire = label + 12;' }, { scene: 1 });
  assert.equal(candidate.text, before.replace('const box = 100, label = box + 20, wire = label + 8;',
    '/* 联动调整 */ const box = 130, label = box + 30, wire = label + 12;'));
  assert.deepEqual(candidate.affectedScenes, [1]);
  assert.equal(candidate.sharedImpact, false);
  assert.equal(globalThis.__vhSafetyExecuted, undefined);
});

test('patch and replace both reject whole-candidate syntax/render damage before any side effects', async t => {
  const dir = fixture(t), before = read(dir), tools = makeTools(dir, () => {}, { mode: 'article' });
  for (const [find, replace] of [
    ['const box = 100', 'const box = ('],
    ['render(t)', 'notRender(t)'],
    ['return { render(t)', 'return\n { render(t)'],
  ]) {
    const result = await tools.patch_text.run({ path: 'scenes.src.js', base_hash: base(dir), find, replace, expected_count: find.includes('100') ? 1 : 2 });
    assert.match(result, /写入失败/);
    assert.equal(read(dir), before);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  }
  // An apparently valid edit to S1 must also notice existing damage in S2.
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), before.replace('const box = 200', 'const box = ('));
  const broken = read(dir), current = base(dir);
  for (const apply of [
    () => patchText(dir, 'scenes.src.js', { base_hash: current, find: 'box = 100', replace: 'box = 110' }),
    () => replaceScene(dir, 1, { base_hash: current, content: scene(3) }),
  ]) assert.throws(apply, /S2:/);
  assert.equal(read(dir), broken);
  assert.deepEqual(history(dir), []);
  assert.equal(globalThis.__vhSafetyExecuted, undefined);
});

test('failed count, stale CAS and policy rejection do not create author draft receipts or backups', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '半截草稿。\n');
  const tools = makeTools(dir, () => {}, { mode: 'article' }), current = base(dir, '脚本.md');
  assert.match(await tools.patch_text.run({ path: '脚本.md', base_hash: current, find: '不存在', replace: '新稿' }), /写入失败/);
  assert.match(await tools.patch_text.run({ path: '脚本.md', base_hash: 'a'.repeat(64), find: '半截', replace: '完整' }), /stale base_hash/);
  assert.throws(() => patchText(dir, '脚本.md', { base_hash: current, find: '半截', replace: '完整' }, {
    validate() { throw new Error('candidate policy refused'); }, beforeCommit() { throw new Error('must not run'); },
  }), /candidate policy refused/);
  assert.equal(read(dir, '脚本.md'), '半截草稿。\n');
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('one-scene contract fences replace, multi-match patch, separators and execution-time scope', async t => {
  const dir = fixture(t), fence = contract(dir), before = read(dir), current = base(dir);
  const tools = makeTools(dir, () => {}, { mode: 'edit-visual', activeContract: fence });
  const other = { scene: 2, base_hash: current, content: scene(3) };
  assert.match(fence.validate(call('replace_scene', other)), /当前任务是 S1/);
  assert.match(await tools.replace_scene.run(other), /越出本场范围/);
  const across = { path: 'scenes.src.js', base_hash: current, find: 'label + 8', replace: 'label + 18', expected_count: 2 };
  assert.match(fence.validate(call('patch_text', across)), /越出本场范围/);
  assert.match(await tools.patch_text.run(across), /越出本场范围/);
  const separator = { path: 'scenes.src.js', base_hash: current, find: '//---', replace: '//---   ' };
  assert.match(fence.validate(call('patch_text', separator)), /越出本场范围/);
  assert.equal(read(dir), before);
  assert.deepEqual(history(dir), []);

  const linked = { path: 'scenes.src.js', base_hash: current,
    find: 'box = 100, label = box + 20, wire = label + 8', replace: 'box = 130, label = box + 32, wire = label + 16' };
  assert.equal(fence.validate(call('patch_text', linked)), null);
  const saved = JSON.parse(await tools.patch_text.run(linked));
  assert.deepEqual(saved.affectedScenes, [1]); assert.equal(saved.sharedImpact, false);
  assert.equal(read(dir).slice(read(dir).indexOf('//---')), before.slice(before.indexOf('//---')));
  const metadata = JSON.parse(fs.readFileSync(path.join(dir, path.dirname(saved.backup_path), 'metadata.json')));
  assert.deepEqual(metadata.affectedScenes, [1]); assert.equal(metadata.sharedImpact, false);
});

test('a scene task from the pipeline carries the same scope even without draft-scene direction', t => {
  const dir=fixture(t),schemas=STAGE_TOOLS.author_edit.map(name=>({function:{name}}));
  const fence=stageContract({stage:'author_edit',path:'scenes.src.js',scene:1,allowed:STAGE_TOOLS.author_edit},{schemas,project:dir});
  assert.equal(fence.editScope,1);
  assert.match(fence.validate(call('replace_scene',{scene:2,base_hash:base(dir),content:scene(3)})),/当前任务是 S1/);
  assert.match(fence.validate(call('patch_text',{path:'scenes.src.js',base_hash:base(dir),find:'label + 8',replace:'label + 18',expected_count:2})),/越出本场范围/);
});

test('scoped script patches may link within a scene but cannot change another heading or global subject', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：窗口\n\n' + read(dir, '脚本.md'));
  const fence = contract(dir, 1, '脚本.md'), current = base(dir, '脚本.md');
  assert.match(fence.validate(call('patch_text', { path: '脚本.md', base_hash: current, find: '原旁白', replace: '新旁白', expected_count: 2 })), /越出本场范围/);
  assert.match(fence.validate(call('patch_text', { path: '脚本.md', base_hash: current, find: '窗口', replace: '全片新主题' })), /越出本场范围/);
  assert.equal(fence.validate(call('patch_text', { path: '脚本.md', base_hash: current, find: '第一场\n1. 原旁白', replace: '第一场新版\n1. 新旁白' })), null);
});

test('request-time script/scene/engine baselines remain enforced even with a freshly read target hash', async t => {
  const dir = fixture(t), fence = contract(dir), before = read(dir);
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n外部编辑\n');
  const args = { path: 'scenes.src.js', base_hash: base(dir), find: 'box = 100', replace: 'box = 110' };
  assert.match(fence.validate(call('patch_text', args)), /基线已改变/);
  const tools = makeTools(dir, () => {}, { mode: 'edit-visual', activeContract: fence });
  assert.match(await tools.patch_text.run(args), /基线已改变/);
  assert.equal(read(dir), before); assert.deepEqual(history(dir), []);
});

test('scene patch retains the existing second CAS check after backup preparation', t => {
  const dir = fixture(t), file = path.join(dir, 'scenes.src.js'), current = base(dir), before = read(dir);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (String(to).endsWith('metadata.json')) fs.appendFileSync(file, '// external\n');
  });
  assert.throws(() => patchText(dir, 'scenes.src.js', { base_hash: current, find: 'box = 100', replace: 'box = 110' }), e => e.code === 'STALE_BASE_HASH');
  assert.equal(read(dir), before + '// external\n');
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
});

test('related request baseline is rechecked after backup even when target scene bytes did not change', async t => {
  const dir = fixture(t), fence = contract(dir), before = read(dir);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (String(to).endsWith('metadata.json')) fs.appendFileSync(path.join(dir, '脚本.md'), '\n外部改稿\n');
  });
  const tools = makeTools(dir, () => {}, { mode: 'edit-visual', activeContract: fence });
  assert.match(await tools.patch_text.run({ path: 'scenes.src.js', base_hash: base(dir), find: 'box = 100', replace: 'box = 110' }), /基线已改变/);
  assert.equal(read(dir), before);
});

test('unscoped global and multi-scene receipts report actual source impact, not semantic success', t => {
  const dir = fixture(t);
  const patched = patchText(dir, 'scenes.src.js', { base_hash: base(dir), find: 'label + 8', replace: 'label + 12', expected_count: 2 });
  assert.deepEqual(patched.affectedScenes, [1, 2]); assert.equal(patched.sharedImpact, false);
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), '<style>body{color:white}</style>');
  const engine = patchText(dir, 'engine.tpl.html', { base_hash: base(dir, 'engine.tpl.html'), find: 'white', replace: 'black' });
  assert.deepEqual(engine.affectedScenes, []); assert.equal(engine.sharedImpact, true);
  const noop = replaceScene(dir, 1, { base_hash: base(dir), content: scene(1).replace('label + 8', 'label + 12') });
  assert.deepEqual(noop.affectedScenes, []); assert.equal(noop.sharedImpact, false); assert.equal(noop.changed, false);
});

test('append cannot bypass full candidate validation for existing scenes', t => {
  const dir = fixture(t), before = read(dir), current = base(dir);
  assert.throws(() => appendText(dir, 'scenes.src.js', { base_hash: current, content: '\n//---\nroot => {' }), /S3:/);
  assert.equal(read(dir), before); assert.deepEqual(history(dir), []);
  const saved = appendText(dir, 'scenes.src.js', { base_hash: current, content: '\n//---\n' + scene(3) });
  assert.equal(saved.sharedImpact, true); assert.deepEqual(saved.affectedScenes, [2, 3]);
});

test('write_file protects existing author inputs; exact installed scaffold and empty initialization keep CAS/backups', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'article' });
  for (const name of ['脚本.md', '方案.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', '发布文案.md', '审查.md']) {
    if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), '已有作者稿');
    const before = read(dir, name);
    assert.match(await tools.write_file.run({ path: name, content: name === 'scenes.src.js' ? scene(3) : '新内容' }), /拒绝.*不能整份覆盖/, name);
    assert.equal(read(dir, name), before);
  }
  assert.deepEqual(history(dir), []);
  const starter = 'root => ({render(){}})';
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), starter);
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ installedFiles: { 'scenes.src.js': hash(starter) } }));
  const initialized = await tools.write_file.run({ path: 'scenes.src.js', content: scene(3) });
  assert.match(initialized, /^已写入/); assert.match(initialized, /affectedScenes/);
  const saved = JSON.parse(initialized.split('\n').slice(1).join('\n'));
  assert.equal(fs.readFileSync(path.join(dir, saved.backup_path), 'utf8'), starter);
  assert.equal(read(dir), scene(3));
  const restoredTools = makeTools(dir, () => {}, { mode: 'article' });
  assert.match(await restoredTools.write_file.run({ path: 'scenes.src.js', content: scene(3) }), /内容已相同/);
  assert.match(await restoredTools.write_file.run({ path: 'scenes.src.js', content: scene(4) }), /不能整份覆盖/);
  fs.writeFileSync(path.join(dir, '方案.md'), '');
  assert.match(await restoredTools.write_file.run({ path: '方案.md', content: '第一批方案' }), /^已写入/);
  fs.unlinkSync(path.join(dir, '发布文案.md'));
  assert.match(await restoredTools.write_file.run({ path: '发布文案.md', content: '新建文案' }), /^已写入/);
});

test('installed scaffold is not overwritten by an invalid candidate or a late external edit', async t => {
  const dir = fixture(t), starter = read(dir);
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ installedFiles: { 'scenes.src.js': hash(starter) } }));
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  assert.match(await tools.write_file.run({ path: 'scenes.src.js', content: 'root => {' }), /拒绝/);
  assert.equal(read(dir), starter); assert.deepEqual(history(dir), []);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (String(to).endsWith('metadata.json')) fs.appendFileSync(path.join(dir, 'scenes.src.js'), '// external\n');
  });
  assert.match(await tools.write_file.run({ path: 'scenes.src.js', content: scene(3) }), /stale base_hash/);
  assert.equal(read(dir), starter + '// external\n');
});

test('rejected non-author patch targets retain policy reasons without gaining edit permission', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'topic' });
  for (const [config, find, replace, reason] of [
    [{ durationLimit: { maxSeconds: 480, targetSeconds: 420 } }, '480', '900', /拒绝.*时长限制/],
    [{ automation: { maxRepairs: 2 } }, '2', '9', /不能修改自动制作策略/],
    [{ deliveryTarget: 'publish-package' }, 'publish-package', 'video', /拒绝.*交付目标/],
    [{ videoFormat: { aspectRatio: '16:9' } }, '16:9', '9:16', /拒绝.*画幅/],
    [{ name: '原项目名' }, '原项目名', '新项目名', /Only exact project-relative author/],
  ]) {
    const before = JSON.stringify(config);
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), before);
    assert.match(await tools.patch_text.run({ path: 'PROJECT.json', base_hash: hash(before), find, replace }), reason);
    assert.equal(read(dir, 'PROJECT.json'), before);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  }
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ videoFormat: { aspectRatio: '16:9' } }));
  const html = "const ORIENT = 'landscape';";
  fs.writeFileSync(path.join(dir, 'scene.html'), html);
  assert.match(await tools.patch_text.run({ path: 'scene.html', base_hash: hash(html), find: 'landscape', replace: 'portrait' }), /拒绝.*画幅/);
  assert.equal(read(dir, 'scene.html'), html);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});
