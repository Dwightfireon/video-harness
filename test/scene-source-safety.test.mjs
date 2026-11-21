import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSceneSource, readEditFile, patchText } from '../lib/author-edits.mjs';
import { writeSceneDraft, assembleSceneDrafts, sceneAssemblyMatches } from '../lib/scene-drafts.mjs';

const scene = n => `root => { const n = ${n}; return {render(t){void [n,t];}}; }`;
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-scene-source-safety-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 第一场\n1. 第一场旁白。\n\n## S2 · 第二场\n1. 第二场旁白。\n');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), scene(0));
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), '<!-- original engine -->');
  return dir;
}
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const manifest = 'out/.vh-scene-drafts/manifest.json';

test('direct render validation accepts parenthesized callables and every existing builder shape without execution', () => {
  const values = [
    'root=>{return {render:((t)=>{})};}',
    'root=>({render:(((t)=>({t})))})',
    '(root)=>({render: (function named(t){ return t; })})',
    'function(root){return {render: (async function(t){void t;})};}',
    'root=>{return ({render(t){void t;}});}',
    'root=>{return {async render(t){void t;}};}',
    'root=>{return {render:async=>{void async;}};}',
    'root=>{return {"render":((t)=>{}), nested:{["render"]:42, ...root}};}',
    '// @layout 保留合法注释\nroot=>{const s=`${`${{x:"}"}.x}`} /}/`; return {other: s, render(t){globalThis.__vhSafetyRan=true;}};}',
    'root=>{root.return(); return {render(){}};}',
    'root=>{// 合法 Unicode 换行注释\u2028return {render(){}};}',
  ];
  for (const content of values) assert.equal(validateSceneSource(content), content.trim(), content);
  assert.equal(globalThis.__vhSafetyRan, undefined);
});

test('regex immediately after control parentheses remains a literal, not structural braces', () => {
  const statements = [
    "if(root) /}/.test('x');",
    "if((root)) /[{]/.test('x'); else /}/.test('x');",
    "while(root) /}/.test('x');",
    "for(let n=0;n<1;n++) /}/.test('x');",
    "for(const n of [1]) /[{}]/.test('x');",
    "if(root) {} /}/.test('x');",
    "while(root) {} /}/.test('x');",
    "for(let n=0;n<1;n++) {} /}/.test('x');",
    "do /}/.test('x'); while(root);",
    "const n = 1 + /}/.test('x'); void n;",
    "const n = 1 / /}/.test('x'); void n;",
    // A property named like a control keyword is an ordinary call, so the
    // following slashes are division rather than a regexp literal.
    'const n = root.if(root) / 2 / 3; void n;',
    'const n = (root + 1) / 2; void n;',
    'const n = `nested ${(()=>{if(root) /}/.test("x"); return "}";})()}`; void n;',
  ];
  for (const statement of statements) {
    const content = `root=>{${statement}return {render(){}};}`;
    assert.equal(validateSceneSource(content), content, statement);
  }
});

test('duplicate render, nested-only render, unknown overwrite and non-callable final values are rejected', () => {
  const objects = [
    '{render(){},render:42}',
    '{render:42,render(){}}',
    '{render(){},render(){}}',
    '{render(){},"render":(t)=>{}}',
    String.raw`{render(){},"\u0072ender":42}`,
    "{render(){},['render']:42}",
    '{render(){},[root]:42}',
    '{render(){},...root}',
    '{...root,render(){}}',
    '{nested:{render(){}}}',
    '{render:({nested(t){}})}',
    '{render:((t)=>{})()}',
    '{render:((t)=>{}) || 42}',
    '{render:((t)=>{},42)}',
    '{get render(){return ()=>{}}}',
    '{render}',
  ];
  for (const object of objects) {
    for (const content of [`root=>{return ${object};}`, `root=>(${object})`, `function(root){return ${object};}`]) {
      assert.throws(() => validateSceneSource(content), e => e.code === 'INVALID_SCENE', content);
    }
  }
  for (const content of [
    'root=>{return {render(){}}.render;}',
    'root=>{return {render(){}}\n.render;}',
    'root=>{return ({render(){}}).render;}',
    'root=>{return {render(){}}\n== 42;}',
    'root=>{return {render(){}}\ninstanceof Object;}',
    'root=>{const fn=()=>{return {render(){}};};}',
    'root=>{return {render(){}};return {nested:{render(){}}};}',
  ]) assert.throws(() => validateSceneSource(content), e => e.code === 'INVALID_SCENE', content);
});

test('draft generation and exact patches apply the same direct-property validation without side effects', t => {
  const dir = fixture(t), original = read(dir, 'scenes.src.js');
  assert.throws(() => writeSceneDraft(dir, 1, 'root=>{return {render(){},render:42};}'), /Duplicate render/);
  assert.equal(read(dir, 'scenes.src.js'), original);
  assert.equal(fs.existsSync(path.join(dir, manifest)), false);
  assert.throws(() => patchText(dir, 'scenes.src.js', { base_hash: readEditFile(dir, 'scenes.src.js').base_hash,
    find: 'render(t){void [n,t];}', replace: 'render(t){void [n,t];},render:42' }), /Duplicate render/);
  assert.equal(read(dir, 'scenes.src.js'), original);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-edit-history')), false);
  writeSceneDraft(dir, 1, 'root=>{if(root) /}/.test("x");return {render:((t)=>{})};}');
  writeSceneDraft(dir, 2, '(root)=>({render(){}})');
  assert.match(assembleSceneDrafts(dir), /已组装 2 场/);
  assert.equal(sceneAssemblyMatches(dir), true);
});

for (const phase of ['draft-read', 'source-temp', 'manifest-temp']) {
  for (const target of ['scenes.src.js', '脚本.md', 'engine.tpl.html']) {
    test(`assembly rechecks ${target} after ${phase}; preserves external bytes and does not advance manifest`, t => {
      const dir = fixture(t);
      writeSceneDraft(dir, 1, scene(1)); writeSceneDraft(dir, 2, scene(2));
      const before = Object.fromEntries(['scenes.src.js', '脚本.md', 'engine.tpl.html', manifest].map(name => [name, read(dir, name)]));
      const drafts = ['S1.js', 'S2.js'].map(name => read(dir, 'out/.vh-scene-drafts/' + name));
      const originalOpen = fs.openSync, originalRead = fs.readFileSync, originalSync = fs.fsyncSync, originalWrite = fs.writeFileSync;
      const paths = new Map();
      let fired = false, secondDraftReads = 0;
      const inject = () => {
        if (fired) return;
        fired = true;
        originalWrite(path.join(dir, target), before[target] + '\n// external edit\n');
      };
      t.mock.method(fs, 'openSync', (file, ...args) => {
        const fd = originalOpen(file, ...args); paths.set(fd, String(file)); return fd;
      });
      t.mock.method(fs, 'readFileSync', (file, ...args) => {
        const result = originalRead(file, ...args), name = typeof file === 'number' ? paths.get(file) : String(file);
        // The transaction owner first snapshots drafts. Inject on the assembly's
        // second S2 read, after its input baseline and actual draft bytes exist.
        if (phase === 'draft-read' && name === path.join(dir, 'out/.vh-scene-drafts/S2.js') && ++secondDraftReads === 2) inject();
        return result;
      });
      t.mock.method(fs, 'fsyncSync', fd => {
        const result = originalSync(fd), name = paths.get(fd) || '';
        const prefix = path.join(dir, phase === 'manifest-temp' ? manifest : 'scenes.src.js') + '.';
        if (phase !== 'draft-read' && name.startsWith(prefix) && name.endsWith('.tmp')) inject();
        return result;
      });
      assert.throws(() => assembleSceneDrafts(dir), e => e.code === 'STALE_DRAFT_ASSEMBLY');
      assert.equal(fired, true);
      assert.equal(read(dir, manifest), before[manifest]);
      for (const name of ['脚本.md', 'engine.tpl.html']) assert.equal(read(dir, name), before[name] + (name === target ? '\n// external edit\n' : ''));
      const assembled = scene(1) + '\n\n//---\n\n' + scene(2) + '\n';
      // Once source has committed it is not blindly rolled back if a later
      // manifest check fails. The external writer's bytes always win.
      assert.equal(read(dir, 'scenes.src.js'), target === 'scenes.src.js' ? before[target] + '\n// external edit\n' : phase === 'manifest-temp' ? assembled : before['scenes.src.js']);
      assert.deepEqual(['S1.js', 'S2.js'].map(name => read(dir, 'out/.vh-scene-drafts/' + name)), drafts);
      assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
      assert.equal(fs.readdirSync(path.join(dir, 'out/.vh-scene-drafts')).some(name => name.endsWith('.tmp')), false);
    });
  }
}
