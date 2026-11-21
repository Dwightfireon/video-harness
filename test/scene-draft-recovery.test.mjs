import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sceneDraftRecovery, rebaseSceneDrafts, recoverSceneDraftTransaction, writeSceneDraft, assembleSceneDrafts,
  sceneDraftStatus, sceneAssemblyMatches, sceneDraftMatches } from '../lib/scene-drafts.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const body = n => `// @layout 第${n}场\nroot => ({ render() { return ${n}; } })`;
const script = '# 试片\n<!-- 项目备注 -->\n\n## S1 · 开场\n1. 第一句旁白。\n\n## S2 · 对照\n1. 第二句旁白。\n';
function fixture(t, count = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-draft-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '脚本.md'), script);
  fs.writeFileSync(path.join(root, 'scenes.src.js'), '// 原始作者文件\nroot => ({render(){}})\n');
  fs.writeFileSync(path.join(root, 'engine.tpl.html'), '<html>engine v1</html>');
  for (let n = 1; n <= count; n++) writeSceneDraft(root, n, body(n));
  return root;
}
const file = (root, name) => path.join(root, name);
const manifestPath = root => file(root, 'out/.vh-scene-drafts/manifest.json');
const manifest = root => JSON.parse(fs.readFileSync(manifestPath(root), 'utf8'));
const active = (root, n) => {
  const m = manifest(root);
  return file(root, `out/.vh-scene-drafts/${m.generation ? `generations/${m.generation}/` : ''}S${n}.js`);
};
const comment = root => fs.appendFileSync(file(root, '脚本.md'), '\n<!-- 只修改注释 -->\n');
const rebase = (root, options = {}) => rebaseSceneDrafts(root, { ...sceneDraftRecovery(root), ...options });
const tree = root => {
  const result = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name), stat = fs.lstatSync(target);
      result.push([path.relative(root, target), stat.mode, stat.mtimeMs,
        entry.isFile() ? hash(fs.readFileSync(target)) : null]);
      if (entry.isDirectory()) walk(target);
    }
  };
  walk(root); return result;
};
function crashRebase(root, phase = 'before') {
  const preview = sceneDraftRecovery(root);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { rebaseSceneDrafts } from ${JSON.stringify(new URL('../lib/scene-drafts.mjs', import.meta.url).href)};
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).endsWith('/.vh-scene-drafts/manifest.json')) {
        if (${JSON.stringify(phase)} === 'before') process.kill(process.pid, 'SIGKILL');
        const result = rename(from, to); process.kill(process.pid, 'SIGKILL'); return result;
      }
      return rename(from, to);
    };
    rebaseSceneDrafts(${JSON.stringify(root)}, ${JSON.stringify({ ...preview, reuse_scenes: [1, 2] })});
  `], { encoding: 'utf8', cwd: path.dirname(fileURLToPath(import.meta.url)) });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
}

test('恢复检查只读；注释变化可按逐场旁白/标题/引擎证据显式复用', t => {
  const root = fixture(t), original = fs.readFileSync(file(root, 'scenes.src.js'));
  comment(root);
  const before = tree(root), preview = sceneDraftRecovery(root);
  assert.deepEqual(tree(root), before);
  assert.equal(preview.stale, true); assert.equal(preview.can_rebase, true);
  assert.deepEqual(preview.reusable, [1, 2]);
  assert.equal(preview.script_hash, preview.scriptHash);
  assert.equal(preview.source_hash, hash(original));
  assert.throws(() => writeSceneDraft(root, 1, body(1)), /已在分场草稿期间改变/);
  const oldManifest = fs.readFileSync(manifestPath(root));
  const result = rebaseSceneDrafts(root, { ...preview, reuse_scenes: [1, 2] });
  assert.deepEqual(result.reused, [1, 2]); assert.deepEqual(result.missing, []);
  assert.deepEqual(fs.readFileSync(file(root, result.archive_path + '/manifest.json')), oldManifest);
  assert.equal(fs.readFileSync(file(root, result.archive_path + '/S1.js'), 'utf8'), body(1) + '\n');
  assert.deepEqual(fs.readFileSync(file(root, 'scenes.src.js')), original);
  assert.equal(sceneDraftStatus(root).stale, false);
  assert.equal(sceneDraftMatches(root, 1, body(1)), true);
  assert.match(assembleSceneDrafts(root), /已组装 2 场/);
  assert.equal(sceneAssemblyMatches(root), true);
});

test('重开默认不复用；多次历史不丢且后续草稿只写新一轮', t => {
  const root = fixture(t), oldDraft = fs.readFileSync(active(root, 1), 'utf8');
  comment(root);
  const first = rebase(root);
  assert.deepEqual(first.reused, []); assert.deepEqual(sceneDraftStatus(root).missing, [1, 2]);
  assert.equal(fs.readFileSync(file(root, 'out/.vh-scene-drafts/S1.js'), 'utf8'), oldDraft);
  writeSceneDraft(root, 1, body(3));
  const previousGeneration = active(root, 1);
  comment(root);
  const second = rebase(root, { reuse_scenes: [1] });
  assert.notEqual(second.archive_path, first.archive_path);
  assert.equal(fs.readFileSync(previousGeneration, 'utf8'), body(3) + '\n');
  assert.equal(fs.readFileSync(file(root, second.archive_path + '/S1.js'), 'utf8'), body(3) + '\n');
  writeSceneDraft(root, 2, body(4)); assembleSceneDrafts(root);
  assert.equal(sceneAssemblyMatches(root), true);
});

test('旁白、编号、标题、场内视觉说明改变只能复用其余相同场次', t => {
  for (const [from, to] of [
    ['第一句旁白', '用户改写旁白'], ['1. 第一句', '2. 第一句'],
    ['S1 · 开场', 'S1 · 新标题'], ['1. 第一句旁白。', '1. 第一句旁白。\n视觉：新增时间轴'],
  ]) {
    const root = fixture(t);
    fs.writeFileSync(file(root, '脚本.md'), script.replace(from, to));
    assert.deepEqual(sceneDraftRecovery(root).reusable, [2]);
    assert.throws(() => rebase(root, { reuse_scenes: [1] }), { code: 'UNSAFE_DRAFT_REUSE' });
    assert.deepEqual(rebase(root, { reuse_scenes: [2] }).missing, [1]);
  }
});

test('引擎或全局指令变更不能复用，仍可无复用重开', t => {
  for (const target of ['engine.tpl.html', 'gen.mjs', 'timeline.mjs', 'PROJECT.json', '脚本.md']) {
    const root = fixture(t);
    if (target === '脚本.md') fs.writeFileSync(file(root, target), script.replace('# 试片', '# 另一种全局要求'));
    else fs.writeFileSync(file(root, target), 'changed baseline');
    assert.deepEqual(sceneDraftRecovery(root).reusable, []);
    assert.throws(() => rebase(root, { reuse_scenes: [1] }), { code: 'UNSAFE_DRAFT_REUSE' });
    rebase(root); assert.equal(sceneDraftStatus(root).stale, false);
  }
});

test('旧清单仍能读取/写入；不能追认没有旧身份证据的草稿', t => {
  const root = fixture(t);
  const old = manifest(root);
  fs.writeFileSync(manifestPath(root), JSON.stringify({ count: old.count, scriptHash: old.scriptHash, sourceHash: old.sourceHash }));
  assert.equal(sceneDraftStatus(root).stale, false);
  writeSceneDraft(root, 2, body(5));
  comment(root);
  assert.deepEqual(sceneDraftRecovery(root).reusable, []);
  const result = rebase(root);
  assert.equal(fs.readFileSync(file(root, result.archive_path + '/S2.js'), 'utf8'), body(5) + '\n');
  assert.equal(manifest(root).version, 2);
  writeSceneDraft(root, 1, body(1));
  comment(root); assert.deepEqual(sceneDraftRecovery(root).reusable, [1]);
});

test('源冲突不能被重开/参数确认抹成可覆盖，原文件和草稿不变', t => {
  const root = fixture(t);
  fs.writeFileSync(file(root, 'scenes.src.js'), '用户外部修改，不准覆盖\n');
  const preview = sceneDraftRecovery(root), before = fs.readFileSync(manifestPath(root));
  assert.equal(preview.source_conflict, true); assert.equal(preview.can_rebase, false);
  assert.deepEqual(preview.reusable, []);
  assert.throws(() => rebaseSceneDrafts(root, { ...preview, acknowledge_source: true }), { code: 'DRAFT_SOURCE_CONFLICT' });
  assert.deepEqual(fs.readFileSync(manifestPath(root)), before);
  assert.equal(fs.readFileSync(file(root, 'scenes.src.js'), 'utf8'), '用户外部修改，不准覆盖\n');
  assert.throws(() => assembleSceneDrafts(root), /未覆盖作者文件/);
});

test('CAS覆盖脚本、源、清单、逐场草稿、引擎；不允许旧检查结果重放', t => {
  for (const target of ['脚本.md', 'scenes.src.js', 'manifest', 'draft', 'engine.tpl.html']) {
    const root = fixture(t); comment(root);
    const preview = sceneDraftRecovery(root);
    const targetFile = target === 'manifest' ? manifestPath(root) : target === 'draft' ? active(root, 1) : file(root, target);
    fs.appendFileSync(targetFile, target === 'manifest' ? '\n' : '\n// changed\n');
    const before = fs.readFileSync(manifestPath(root));
    assert.throws(() => rebaseSceneDrafts(root, { ...preview, reuse_scenes: [1] }), { code: 'STALE_DRAFT_RECOVERY' });
    assert.deepEqual(fs.readFileSync(manifestPath(root)), before);
  }
  const root = fixture(t), preview = sceneDraftRecovery(root);
  rebaseSceneDrafts(root, preview);
  assert.throws(() => rebaseSceneDrafts(root, preview), { code: 'STALE_DRAFT_RECOVERY' });
  assert.throws(() => rebaseSceneDrafts(root, { script_hash: preview.script_hash }), { code: 'STALE_DRAFT_RECOVERY' });
});

test('直接改过的草稿不能自动复用，原始字节仍归档', t => {
  const root = fixture(t);
  fs.writeFileSync(active(root, 1), body(8) + '\r\n'); comment(root);
  assert.deepEqual(sceneDraftRecovery(root).reusable, [2]);
  const result = rebase(root);
  assert.equal(fs.readFileSync(file(root, result.archive_path + '/S1.js'), 'utf8'), body(8) + '\r\n');
});

test('无owner的旧/未知门保持阻断，读检查不清锁并给明确人工处理提示', t => {
  const root = fixture(t); comment(root);
  const preview = sceneDraftRecovery(root), gate = file(root, 'out/.vh-scene-drafts/.transaction');
  fs.mkdirSync(gate, { mode: 0o700 });
  const before = tree(root), blocked = sceneDraftRecovery(root);
  assert.equal(blocked.transaction_pending, true); assert.equal(blocked.can_rebase, false);
  assert.equal(blocked.transaction.recoverable, false); assert.equal(blocked.transaction.reason, 'missing_owner');
  assert.match(blocked.transaction.action, /人工/);
  assert.throws(() => recoverSceneDraftTransaction(root, blocked), { code: 'DRAFT_TRANSACTION_NOT_RECOVERABLE' });
  assert.deepEqual(blocked.reusable, []); assert.deepEqual(tree(root), before);
  for (const operation of [() => rebaseSceneDrafts(root, preview), () => writeSceneDraft(root, 1, body(1)), () => assembleSceneDrafts(root)]) {
    assert.throws(operation, { code: 'DRAFT_TRANSACTION_BUSY' });
  }
  assert.equal(sceneDraftStatus(root).stale, true);
});

test('准备阶段失败不切换清单，旧场次仍完整', t => {
  const root = fixture(t); comment(root);
  const preview = sceneDraftRecovery(root), before = fs.readFileSync(manifestPath(root));
  fs.writeFileSync(file(root, 'out/.vh-scene-drafts/generations'), '不是目录');
  assert.throws(() => rebaseSceneDrafts(root, { ...preview, reuse_scenes: [1, 2] }), { code: 'INVALID_DRAFT_PATH' });
  assert.deepEqual(fs.readFileSync(manifestPath(root)), before);
  assert.equal(fs.readFileSync(active(root, 1), 'utf8'), body(1) + '\n');
  assert.equal(fs.existsSync(file(root, 'out/.vh-scene-drafts/.transaction')), false);
});

test('符号链接/目录路径拒绝，不能越界读取或覆盖', t => {
  for (const target of ['out', 'home', 'manifest', 'draft', 'script', 'source', 'engine', 'history']) {
    const root = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-draft-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    comment(root);
    const preview = sceneDraftRecovery(root);
    const mapping = { out: 'out', home: 'out/.vh-scene-drafts', manifest: 'out/.vh-scene-drafts/manifest.json',
      draft: 'out/.vh-scene-drafts/S1.js', script: '脚本.md', source: 'scenes.src.js', engine: 'engine.tpl.html', history: 'out/.vh-scene-drafts/history' };
    const targetPath = file(root, mapping[target]);
    if (fs.existsSync(targetPath)) fs.renameSync(targetPath, targetPath + '.saved');
    fs.symlinkSync(outside, targetPath);
    assert.throws(() => rebaseSceneDrafts(root, { ...preview, reuse_scenes: [1] }), { code: 'INVALID_DRAFT_PATH' });
    assert.deepEqual(fs.readdirSync(outside), []);
  }
  const root = fixture(t);
  fs.unlinkSync(active(root, 1)); fs.mkdirSync(active(root, 1));
  assert.throws(() => sceneDraftRecovery(root), { code: 'INVALID_DRAFT_PATH' });
});

test('FIFO与损坏清单故障关闭，检查不挂起、不重建旧数据', t => {
  const root = fixture(t), draft = active(root, 1);
  fs.unlinkSync(draft);
  assert.equal(spawnSync('mkfifo', [draft]).status, 0);
  assert.throws(() => sceneDraftRecovery(root), { code: 'INVALID_DRAFT_PATH' });
  fs.unlinkSync(draft);
  fs.writeFileSync(manifestPath(root), '{broken');
  assert.throws(() => sceneDraftRecovery(root));
  assert.throws(() => rebaseSceneDrafts(root, {}));
  assert.equal(fs.readFileSync(manifestPath(root), 'utf8'), '{broken');
});

test('准备归档期间再变更也须重新CAS，不能提交陈旧恢复', t => {
  const root = fixture(t); comment(root);
  const preview = sceneDraftRecovery(root), before = fs.readFileSync(manifestPath(root));
  const rename = fs.renameSync;
  let changed = false;
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (!changed && String(to).includes('/history/')) {
      changed = true; fs.appendFileSync(file(root, '脚本.md'), '\n<!-- concurrent edit -->');
    }
    return result;
  };
  try { assert.throws(() => rebaseSceneDrafts(root, { ...preview, reuse_scenes: [1] }), { code: 'STALE_DRAFT_RECOVERY' }); }
  finally { fs.renameSync = rename; }
  assert.equal(changed, true); assert.deepEqual(fs.readFileSync(manifestPath(root)), before);
});

test('跨进程事务门串行化重开，不能有两个恢复同时提交', t => {
  const root = fixture(t); comment(root);
  const preview = sceneDraftRecovery(root), rename = fs.renameSync;
  let contender;
  const moduleURL = new URL('../lib/scene-drafts.mjs', import.meta.url).href;
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (!contender && String(to).includes('/history/')) {
      contender = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { rebaseSceneDrafts } from ${JSON.stringify(moduleURL)};
        try { rebaseSceneDrafts(${JSON.stringify(root)}, ${JSON.stringify(preview)}); process.exit(3); }
        catch (e) { if (e.code !== 'DRAFT_TRANSACTION_BUSY') throw e; }
      `], { encoding: 'utf8' });
    }
    return result;
  };
  try { rebaseSceneDrafts(root, { ...preview, reuse_scenes: [1] }); }
  finally { fs.renameSync = rename; }
  assert.equal(contender.status, 0, contender.stderr);
  assert.deepEqual(sceneDraftStatus(root).present, [1]);
});

test('真实SIGKILL后显式恢复：清单切换前后活动代完整，能继续重开/写入/组装', t => {
  for (const phase of ['before', 'after']) {
    const root = fixture(t); comment(root);
    const preview = sceneDraftRecovery(root), original = fs.readFileSync(manifestPath(root));
    crashRebase(root, phase);
    if (phase === 'before') assert.deepEqual(fs.readFileSync(manifestPath(root)), original);
    else assert.ok(manifest(root).generation);
    for (const n of [1, 2]) assert.equal(fs.readFileSync(active(root, n), 'utf8'), body(n) + '\n');
    const beforeRead = tree(root), recovery = sceneDraftRecovery(root);
    assert.equal(recovery.transaction_pending, true); assert.equal(recovery.transaction_recoverable, true);
    assert.equal(recovery.transaction.reason, 'owner_dead');
    assert.equal(sceneDraftStatus(root).transaction.recoverable, true);
    assert.deepEqual(tree(root), beforeRead);
    assert.throws(() => rebaseSceneDrafts(root, preview), { code: 'DRAFT_TRANSACTION_BUSY' });
    const history = file(root, 'out/.vh-scene-drafts/history');
    for (const id of fs.readdirSync(history)) {
      assert.deepEqual(fs.readFileSync(path.join(history, id, 'manifest.json')), original);
    }
    const activeBefore = manifest(root).generation || null;
    const contents = () => tree(root).filter(([name]) => !name.includes('/.transaction') && name !== 'out/.vh-scene-drafts')
      .map(([name, mode, , digest]) => [name, mode, digest]);
    const preserved = contents();
    assert.equal(recoverSceneDraftTransaction(root, recovery).ok, true);
    assert.deepEqual(contents(), preserved);
    assert.equal(manifest(root).generation || null, activeBefore);
    assert.equal(sceneDraftRecovery(root).transaction_pending, false);
    if (phase === 'before') rebase(root, { reuse_scenes: [1, 2] });
    writeSceneDraft(root, 2, body(7));
    assert.equal(fs.readFileSync(active(root, 1), 'utf8'), body(1) + '\n');
    assembleSceneDrafts(root); assert.equal(sceneAssemblyMatches(root), true);
  }
});

test('活进程/复用PID/EPERM/外机身份均不能恢复，不按门年龄推断死亡', t => {
  const root = fixture(t); comment(root);
  const rename = fs.renameSync;
  let inspected = false;
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (!inspected && String(to).includes('/history/')) {
      inspected = true;
      const gate = file(root, 'out/.vh-scene-drafts/.transaction');
      fs.utimesSync(gate, new Date(0), new Date(0));
      const check = sceneDraftRecovery(root);
      assert.equal(check.transaction.owner_pid, process.pid);
      assert.equal(check.transaction.reason, 'owner_alive_or_unverifiable');
      assert.equal(check.transaction_recoverable, false);
      assert.throws(() => recoverSceneDraftTransaction(root, check), { code: 'DRAFT_TRANSACTION_NOT_RECOVERABLE' });
    }
    return result;
  };
  try { rebase(root, { reuse_scenes: [1] }); } finally { fs.renameSync = rename; }
  assert.equal(inspected, true);
  const second = fixture(t); comment(second); crashRebase(second);
  const gate = file(second, 'out/.vh-scene-drafts/.transaction');
  const ownerFile = path.join(gate, fs.readdirSync(gate)[0]), original = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  for (const owner of [{ ...original, pid: process.pid }, { ...original, process: { ...original.process, host: 'another-host' } }]) {
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    const check = sceneDraftRecovery(second);
    assert.equal(check.transaction_recoverable, false);
    assert.throws(() => recoverSceneDraftTransaction(second, check), { code: 'DRAFT_TRANSACTION_NOT_RECOVERABLE' });
  }
  fs.writeFileSync(ownerFile, JSON.stringify(original));
  const kill = process.kill;
  process.kill = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); };
  try { assert.equal(sceneDraftRecovery(second).transaction_recoverable, false); } finally { process.kill = kill; }
});

test('恢复CAS覆盖门身份和活动代；未知门文件、损坏活动代及旧token不能清理', t => {
  for (const target of ['script', 'owner', 'directory', 'draft', 'unknown']) {
    const root = fixture(t); comment(root); crashRebase(root);
    const check = sceneDraftRecovery(root), gate = file(root, 'out/.vh-scene-drafts/.transaction');
    const name = fs.readdirSync(gate)[0];
    if (target === 'script') comment(root);
    if (target === 'owner') fs.appendFileSync(path.join(gate, name), '\n');
    if (target === 'directory') {
      fs.renameSync(gate, gate + '.saved'); fs.mkdirSync(gate, { mode: 0o700 });
      fs.copyFileSync(path.join(gate + '.saved', name), path.join(gate, name));
    }
    if (target === 'draft') fs.writeFileSync(active(root, 1), body(9));
    if (target === 'unknown') fs.writeFileSync(path.join(gate, 'user-note.tmp'), '用户文件，不准删除');
    const before = tree(root);
    assert.throws(() => recoverSceneDraftTransaction(root, check));
    assert.deepEqual(tree(root), before);
    const current = sceneDraftRecovery(root);
    if (target === 'draft' || target === 'unknown') {
      assert.equal(current.transaction_recoverable, false);
      assert.throws(() => recoverSceneDraftTransaction(root, current), { code: 'DRAFT_TRANSACTION_NOT_RECOVERABLE' });
    }
  }
});

test('并发恢复仅一方领取旧owner，不会删除随后新建的未知门', t => {
  const root = fixture(t); comment(root); crashRebase(root);
  const check = sceneDraftRecovery(root), gate = file(root, 'out/.vh-scene-drafts/.transaction');
  const unlink = fs.unlinkSync;
  let contender;
  fs.unlinkSync = target => {
    if (!contender && String(target).includes('/.transaction/owner-')) {
      contender = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { recoverSceneDraftTransaction } from ${JSON.stringify(new URL('../lib/scene-drafts.mjs', import.meta.url).href)};
        recoverSceneDraftTransaction(${JSON.stringify(root)}, ${JSON.stringify(check)});
      `], { encoding: 'utf8' });
      fs.mkdirSync(gate);
      fs.writeFileSync(path.join(gate, 'unknown-user.tmp'), 'keep');
    }
    return unlink(target);
  };
  try { assert.throws(() => recoverSceneDraftTransaction(root, check), { code: 'STALE_DRAFT_TRANSACTION' }); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(contender.status, 0, contender.stderr);
  assert.equal(fs.readFileSync(path.join(gate, 'unknown-user.tmp'), 'utf8'), 'keep');
  assert.equal(sceneDraftRecovery(root).transaction_recoverable, false);
});

test('空项目检查不建目录，无清单孤儿草稿可归档但不能复用', t => {
  const root = fixture(t, 0), before = tree(root);
  assert.equal(sceneDraftRecovery(root).manifest_hash, null); assert.deepEqual(tree(root), before);
  fs.mkdirSync(file(root, 'out/.vh-scene-drafts'), { recursive: true });
  fs.writeFileSync(file(root, 'out/.vh-scene-drafts/S9.js'), body(9));
  assert.throws(() => writeSceneDraft(root, 1, body(1)), { code: 'UNTRACKED_SCENE_DRAFTS' });
  const result = rebase(root);
  assert.equal(fs.readFileSync(file(root, result.archive_path + '/S9.js'), 'utf8'), body(9));
  assert.deepEqual(result.reused, []);
});
