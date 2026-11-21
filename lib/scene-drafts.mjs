/* 一场一文件；只有所有场景完整且基线未改变时才组装作者文件。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { parseScript } from './state.mjs';
import { withSceneMetadata } from './scene-metadata.mjs';
import { readVisualIntent } from './scene-visual.mjs';
import { validateSceneSource } from './author-edits.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const home = project => path.join(project, 'out', '.vh-scene-drafts');
const manifestFile = project => path.join(home(project), 'manifest.json');
const sourceFile = project => path.join(project, 'scenes.src.js');
const scriptFile = project => path.join(project, '脚本.md');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const generationOK = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const draftFile = (project, scene, info = manifest(project)) => path.join(home(project),
  ...(info?.generation ? ['generations', info.generation] : []), `S${scene}.js`);
// Never follow project-local links, including dangling links and directory links.
function safePath(project, file, create = false) {
  let cursor = fs.realpathSync(project);
  const resolved = path.resolve(file), root = cursor;
  const base = resolved.startsWith(root + path.sep) ? root : path.resolve(project);
  const parts = path.relative(base, resolved).split(path.sep);
  if (parts.some(p => !p || p === '..') || path.isAbsolute(parts[0])) fail('INVALID_DRAFT_PATH', '草稿路径不安全');
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    if (create && i < parts.length - 1) {
      try { fs.mkdirSync(cursor, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    let st;
    try { st = fs.lstatSync(cursor); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) {
      fail('INVALID_DRAFT_PATH', '草稿、作者文件及其父目录不能是符号链接或特殊文件');
    }
  }
  return cursor;
}
const read = file => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) fail('INVALID_DRAFT_PATH', '草稿必须是普通文件');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
};
const projectRead = (project, file) => read(safePath(project, file));
const readSource = project => {
  try { return projectRead(project, sourceFile(project)); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
};
const put = (project, file, text, beforeCommit = () => {}) => {
  file = safePath(project, file, true);
  const temp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    beforeCommit(); safePath(project, file); fs.renameSync(temp, file);
  }
  finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
};

const gateFile = project => path.join(home(project), '.transaction');
const gateIdentity = stat => [stat.dev, stat.ino, stat.birthtimeMs];
const activeHash = state => hash(JSON.stringify([state.manifestHash, state.draftHash]));
function processIdentity() {
  const result = spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' },
  });
  const started = result.stdout?.trim();
  if (result.status !== 0 || !started || started.length > 100) fail('DRAFT_PROCESS_IDENTITY', '无法核验事务持有进程启动身份；未开始草稿事务');
  return { host: os.hostname(), platform: process.platform, started };
}
function ownerDead(owner) {
  if (owner.process.host !== os.hostname() || owner.process.platform !== process.platform) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (e) { return e.code === 'ESRCH'; } // PID reuse, EPERM and all uncertainty stay blocked.
}
function transaction(project, fn) {
  safePath(project, manifestFile(project), true);
  const gate = gateFile(project), id = randomUUID();
  try { fs.mkdirSync(gate, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') fail('DRAFT_TRANSACTION_BUSY', '分场草稿事务未结束；先 sceneDraftRecovery 检查 transaction，再显式 recoverSceneDraftTransaction；未知/无 owner 的门须人工核对，不能按时间强删'); throw e; }
  const identity = gateIdentity(fs.lstatSync(gate)), name = `owner-${id}.json`;
  let ownerText;
  try {
    const owner = { version: 1, id, pid: process.pid, process: processIdentity(), project: fs.realpathSync(project),
      active_hash: activeHash(recoverySnapshot(project)) };
    ownerText = JSON.stringify(owner);
    const fd = fs.openSync(path.join(gate, name), 'wx', 0o600);
    try { fs.writeFileSync(fd, ownerText); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return fn();
  } finally {
    // Only remove the exact metadata made by this call. Unknown files stay put.
    if (JSON.stringify(gateIdentity(fs.lstatSync(gate))) === JSON.stringify(identity)) {
      if (ownerText !== undefined) {
        const names = fs.readdirSync(gate);
        if (names.length === 1 && names[0] === name && projectRead(project, path.join(gate, name)) === ownerText) {
          fs.unlinkSync(path.join(gate, name)); fs.rmdirSync(gate);
        }
      } else if (!fs.readdirSync(gate).length) fs.rmdirSync(gate);
    }
  }
}
const inTransaction = project => {
  try { fs.lstatSync(gateFile(project)); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
};

function snapshot(project) {
  const script = projectRead(project, scriptFile(project)), scenes = parseScript(script);
  if (!scenes.length || scenes.length > 1000 || scenes.some((s, i) => s.n !== i + 1)) throw new Error('脚本场次须从 S1 开始连续编号且有旁白');
  // Absence is evidence too: adding a previously absent engine invalidates reuse.
  const engine = ['engine.tpl.html', 'gen.mjs', 'timeline.mjs', 'PROJECT.json'].map(name => {
    try { return [name, hash(projectRead(project, path.join(project, name)))]; }
    catch (e) { if (e.code === 'ENOENT') return [name, null]; throw e; }
  });
  const clean = script.replace(/<!--[\s\S]*?-->/g, '');
  const headings = [...clean.matchAll(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/gm)];
  // Keep visual instructions as well as exact numbered narration. Ignore only
  // explicit HTML comments; do not guess whether prose is unimportant.
  const identities = scenes.map(s => {
    const at = headings.findIndex(h => +h[1] === s.n);
    return { n: s.n, title: s.title, narrationHash: hash(JSON.stringify(s.lines)),
      sceneHash: at < 0 ? null : hash(clean.slice(headings[at].index, headings[at + 1]?.index).trim()) };
  });
  return { version: 2, scriptHash: hash(script), sourceHash: hash(readSource(project)), count: scenes.length,
    engineHash: hash(JSON.stringify(engine)), contextHash: hash(clean.slice(0, headings[0]?.index ?? clean.length).trim()), identities };
}
function manifest(project) {
  let text;
  try { text = projectRead(project, manifestFile(project)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const info = JSON.parse(text);
  if (!Number.isInteger(info?.count) || info.count < 1 || info.count > 1000 ||
    !/^[a-f0-9]{64}$/.test(info.scriptHash) || !/^[a-f0-9]{64}$/.test(info.sourceHash) ||
    (info.generation !== undefined && !generationOK(info.generation))) {
    throw new Error('分场草稿清单损坏，已停止写入；请人工核对');
  }
  return info;
}
function baseline(project) {
  const current = snapshot(project);
  const previous = manifest(project);
  if (previous && (previous.scriptHash !== current.scriptHash || previous.sourceHash !== current.sourceHash || previous.count !== current.count ||
    (previous.engineHash && previous.engineHash !== current.engineHash))) {
    throw new Error('脚本或 scenes.src.js 已在分场草稿期间改变；草稿保留，未覆盖作者文件。请核对后另行处理');
  }
  return previous || current;
}
function checked(content) {
  return validateSceneSource(content);
}

export function sceneDraftStatus(project) {
  let info, manifestHash;
  try { info = manifest(project); manifestHash = info ? hash(projectRead(project, manifestFile(project))) : null; }
  catch { return { count: 0, present: [], missing: [], stale: true }; }
  if (!info) return null;
  const present = [];
  for (let i = 1; i <= info.count; i++) if (fs.existsSync(draftFile(project, i, info))) present.push(i);
  let stale = false;
  try { baseline(project); stale = inTransaction(project); } catch { stale = true; }
  let transactionStatus;
  try { transactionStatus = inspectTransaction(project, recoverySnapshot(project)); }
  catch { transactionStatus = { pending: inTransaction(project), recoverable: false, reason: 'invalid_active_generation' }; }
  return { count: info.count, present, missing: Array.from({ length: info.count }, (_, i) => i + 1).filter(i => !present.includes(i)),
    stale, generation: info.generation || null, manifestHash, transaction: transactionStatus };
}

export function writeSceneDraft(project, scene, content, metadata = {}) {
  return transaction(project, () => {
    const expected = baseline(project);
    if (!Number.isInteger(scene) || scene < 1 || scene > expected.count) throw new Error(`场次必须在 1–${expected.count} 范围内`);
    const body = checked(withSceneMetadata(content, metadata)), file = draftFile(project, scene, expected);
    if (!fs.existsSync(manifestFile(project))) {
      if (fs.readdirSync(home(project)).some(n => /^S[1-9]\d*\.js$/.test(n))) {
        fail('UNTRACKED_SCENE_DRAFTS', '发现无清单的旧草稿；请先 sceneDraftRecovery 并受控重开，不能静默覆盖');
      }
      put(project, manifestFile(project), JSON.stringify(expected));
    }
    let same = false;
    try { same = projectRead(project, file) === body + '\n'; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (same && expected.draftHashes?.[scene] === hash(body + '\n')) return `S${scene} 草稿内容已相同，未重复写入；${sceneDraftStatus(project).present.length}/${expected.count} 场已保存`;
    if (!same) put(project, file, body + '\n');
    put(project, manifestFile(project), JSON.stringify({ ...expected, revision: randomUUID(),
      draftHashes: { ...expected.draftHashes, [scene]: hash(body + '\n') } }));
    if (same) return `S${scene} 草稿内容已相同，未重复写入；${sceneDraftStatus(project).present.length}/${expected.count} 场已保存`;
    return `已保存 S${scene} 场草稿；${sceneDraftStatus(project).present.length}/${expected.count} 场已保存（尚未改动 scenes.src.js）`;
  });
}

export function assembleSceneDrafts(project, metadata = {}) {
  return transaction(project, () => {
    const info = manifest(project);
    if (!info) throw new Error('还没有分场草稿，未改动 scenes.src.js');
    const manifestText = projectRead(project, manifestFile(project));
    if (JSON.stringify(JSON.parse(manifestText)) !== JSON.stringify(info)) fail('STALE_DRAFT_ASSEMBLY', '组装期间草稿清单已改变；未覆盖作者文件');
    const currentBaseline = snapshot(project);
    if (info.scriptHash !== currentBaseline.scriptHash || info.count !== currentBaseline.count ||
        (info.engineHash && info.engineHash !== currentBaseline.engineHash)) {
      throw new Error('脚本已在分场草稿期间改变；草稿保留，未覆盖作者文件');
    }
    const current = readSource(project);
    if (hash(current) !== currentBaseline.sourceHash) fail('STALE_DRAFT_ASSEMBLY', '组装期间 scenes.src.js 已改变；未覆盖作者文件');
    const recheck = expectedSourceHash => {
      const latest = snapshot(project);
      if (latest.scriptHash !== currentBaseline.scriptHash || latest.count !== currentBaseline.count ||
          latest.engineHash !== currentBaseline.engineHash || latest.sourceHash !== expectedSourceHash ||
          projectRead(project, manifestFile(project)) !== manifestText) {
        fail('STALE_DRAFT_ASSEMBLY', '组装准备期间 source/script/engine 或草稿清单已改变；保留现场，不覆盖作者文件或更新旧清单');
      }
    };
    const missing = Array.from({ length: info.count }, (_, i) => i + 1).filter(i => !fs.existsSync(draftFile(project, i, info)));
    if (missing.length) {
      if (hash(current) !== info.sourceHash) throw new Error('scenes.src.js 已在分场草稿期间改变；未覆盖作者文件');
      throw new Error('尚缺 S' + missing.join('、S') + ' 场草稿；未改动 scenes.src.js');
    }
    const chunks = Array.from({ length: info.count }, (_, i) => checked(withSceneMetadata(projectRead(project, draftFile(project, i + 1, info)), metadata)));
    const next = chunks.join('\n\n//---\n\n') + '\n';
    if (hash(current) !== info.sourceHash && current !== next) throw new Error('scenes.src.js 已在草稿期间改变；未覆盖作者文件');
    // 崩溃可能发生在原子更换 source 与更新 manifest 之间；相同产物直接补记清单，不覆盖原文件。
    if (current !== next) put(project, sourceFile(project), next, () => recheck(currentBaseline.sourceHash));
    // Source and manifest are separate atomic files, not one transaction. If an
    // external edit lands between them, keep it and leave the old manifest as
    // recoverable evidence; never roll the source back over the external edit.
    put(project, manifestFile(project), JSON.stringify({ ...info, sourceHash: hash(next), revision: randomUUID() }), () => recheck(hash(next)));
    return `已组装 ${info.count} 场到 scenes.src.js；草稿仍保留。请运行 vh build --estimate 并逐场检查。`;
  });
}

export function sceneAssemblyMatches(project) {
  try {
    const info = manifest(project);
    const current = snapshot(project);
    if (inTransaction(project) || !info || info.scriptHash !== current.scriptHash || info.count !== current.count ||
        (info.engineHash && info.engineHash !== current.engineHash)) return false;
    return projectRead(project, sourceFile(project)) === Array.from({ length: info.count }, (_, i) => checked(projectRead(project, draftFile(project, i + 1, info)))).join('\n\n//---\n\n') + '\n';
  } catch { return false; }
}

export function sceneDraftMatches(project, scene, content, metadata = {}) {
  try { return !inTransaction(project) && projectRead(project, draftFile(project, scene)) === checked(withSceneMetadata(content, metadata)) + '\n'; } catch { return false; }
}

// Only provide prior context from a current, manifest-verified draft. Missing,
// stale or manually changed drafts must not steer a subsequent scene.
export function previousSceneVisualIntent(project, scene) {
  try {
    if (!Number.isInteger(scene) || scene < 2 || inTransaction(project)) return null;
    const info = manifest(project);
    if (!info || !info.draftHashes?.[scene - 1]) return null;
    baseline(project);
    const text = projectRead(project, draftFile(project, scene - 1, info));
    if (hash(text) !== info.draftHashes[scene - 1]) return null;
    const result = readVisualIntent(text);
    return result.status === 'declared' ? result.intent : null;
  } catch { return null; }
}

function recoverySnapshot(project) {
  const current = snapshot(project), previous = manifest(project);
  const manifestText = previous ? projectRead(project, manifestFile(project)) : null;
  const directory = path.dirname(draftFile(project, 1, previous));
  safePath(project, path.join(directory, '.path-check'));
  let names;
  try { names = fs.readdirSync(directory).filter(n => /^S[1-9]\d*\.js$/.test(n)).sort(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; names = []; }
  const drafts = names.map(name => ({ name, text: projectRead(project, path.join(directory, name)) }));
  const manifestHash = manifestText === null ? null : hash(manifestText);
  const draftHash = hash(JSON.stringify(drafts.map(d => [d.name, hash(d.text)])));
  const recoveryHash = hash(JSON.stringify([current, manifestHash, draftHash]));
  const sourceConflict = !!previous && previous.sourceHash !== current.sourceHash;
  const scenes = current.identities.map(identity => {
    const draft = drafts.find(d => d.name === `S${identity.n}.js`);
    const old = previous?.identities?.find?.(s => s.n === identity.n);
    let reason = !draft ? 'missing_draft' : sourceConflict ? 'source_conflict' :
      previous?.version !== 2 || !old || !identity.sceneHash ? 'missing_identity' :
      previous.engineHash !== current.engineHash ? 'engine_changed' :
      previous.contextHash !== current.contextHash ? 'script_context_changed' :
      JSON.stringify(old) !== JSON.stringify(identity) ? 'scene_changed' :
      previous.draftHashes?.[identity.n] !== hash(draft.text) ? 'draft_not_verified' : null;
    if (!reason) { try { checked(draft.text); } catch { reason = 'invalid_draft'; } }
    return { scene: identity.n, title: identity.title, present: !!draft, reusable: !reason, reason };
  });
  return { current, previous, manifestText, drafts, manifestHash, draftHash, recoveryHash, sourceConflict, scenes };
}

function activeGenerationProof(project, state, owner) {
  try {
    if (state.previous?.generation && !fs.lstatSync(path.dirname(draftFile(project, 1, state.previous))).isDirectory()) return null;
    for (const draft of state.drafts) checked(draft.text);
    if (activeHash(state) === owner.active_hash) return 'unchanged_active_generation';
    const info = state.previous;
    if (info?.version !== 2 || !info.draftHashes || typeof info.draftHashes !== 'object' || Array.isArray(info.draftHashes)) return null;
    const recorded = Object.entries(info.draftHashes).sort(([a], [b]) => `S${a}.js` < `S${b}.js` ? -1 : 1);
    if (recorded.length !== state.drafts.length || recorded.some(([n, value], i) =>
      !/^[1-9]\d*$/.test(n) || +n > info.count || state.drafts[i].name !== `S${n}.js` || hash(state.drafts[i].text) !== value)) return null;
    return 'verified_committed_generation';
  } catch { return null; }
}

// Read-only. Never evict by age or infer death from a changed/reused PID.
function inspectTransaction(project, state) {
  const gate = gateFile(project);
  const blocked = (reason, extra = {}) => ({ pending: true, recoverable: false, reason,
    action: '保持草稿与事务门原样；核对持有进程、owner 记录和活动代。未知/无 owner 的门不能自动删除，请人工恢复有效记录或确认全部证据后人工处理。', ...extra });
  let stat;
  try { stat = fs.lstatSync(gate); } catch (e) { if (e.code === 'ENOENT') return { pending: false, recoverable: false, reason: 'unlocked' }; throw e; }
  try {
    safePath(project, path.join(gate, '.path-check'));
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) return blocked('invalid_gate');
    const names = fs.readdirSync(gate);
    if (!names.length) return blocked('missing_owner');
    if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(names[0])) return blocked('unknown_gate_metadata');
    const ownerFile = path.join(gate, names[0]), ownerStat = fs.lstatSync(ownerFile);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1 || ownerStat.size > 4096 ||
        (ownerStat.mode & 0o777) !== 0o600 || (process.getuid && ownerStat.uid !== process.getuid())) return blocked('invalid_owner');
    const text = projectRead(project, ownerFile), owner = JSON.parse(text);
    if (owner.version !== 1 || !generationOK(owner.id) || names[0] !== `owner-${owner.id}.json` ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2147483647 || owner.project !== fs.realpathSync(project) ||
        !/^[a-f0-9]{64}$/.test(owner.active_hash) || typeof owner.process?.host !== 'string' ||
        typeof owner.process?.platform !== 'string' || typeof owner.process?.started !== 'string' ||
        !owner.process.started.trim() || owner.process.started.length > 100) return blocked('invalid_owner');
    const identity = gateIdentity(stat), proof = activeGenerationProof(project, state, owner);
    const transactionHash = hash(JSON.stringify([identity, gateIdentity(ownerStat), ownerStat.ctimeMs, text, state.recoveryHash]));
    const detail = { transaction_id: owner.id, owner_pid: owner.pid, process: owner.process, transaction_hash: transactionHash,
      active_generation_proof: proof, gate_identity: identity };
    if (JSON.stringify(gateIdentity(fs.lstatSync(gate))) !== JSON.stringify(identity) ||
        fs.readdirSync(gate).join() !== names.join() || projectRead(project, ownerFile) !== text) return blocked('gate_changed');
    if (!ownerDead(owner)) return blocked(owner.process.host !== os.hostname() || owner.process.platform !== process.platform
      ? 'foreign_process_identity' : 'owner_alive_or_unverifiable', detail);
    if (!proof) return blocked('unverified_active_generation', detail);
    return { pending: true, recoverable: true, reason: 'owner_dead', ...detail,
      action: '将本次检查的 transaction_hash 和 recovery_hash 传给 recoverSceneDraftTransaction；仅清理这轮已死亡事务的 owner 与空门，不改草稿、历史或临时文件。' };
  } catch { return blocked('invalid_gate_metadata'); }
}

/** Explicit abandoned-gate recovery. Neither status API calls this implicitly.
 * Both CAS tokens come from sceneDraftRecovery. Only ESRCH proves owner death;
 * unknown/ownerless gates, PID reuse, EPERM and changed generations stay blocked.
 */
export function recoverSceneDraftTransaction(project, { transaction_hash, recovery_hash } = {}) {
  const inspect = () => {
    const state = recoverySnapshot(project), gate = inspectTransaction(project, state);
    if (!gate.transaction_hash) fail('DRAFT_TRANSACTION_NOT_RECOVERABLE', `事务门不能安全恢复：${gate.reason}。${gate.action || '请重新检查事务状态'}`);
    if (typeof transaction_hash !== 'string' || typeof recovery_hash !== 'string' ||
        gate.transaction_hash !== transaction_hash || state.recoveryHash !== recovery_hash) {
      fail('STALE_DRAFT_TRANSACTION', '事务门或活动代 CAS 已改变/缺失；请重新 sceneDraftRecovery，未清理事务门');
    }
    if (!gate.recoverable) fail('DRAFT_TRANSACTION_NOT_RECOVERABLE', `事务门不能安全恢复：${gate.reason}。${gate.action}`);
    return gate;
  };
  inspect();
  const gate = inspect(), directory = gateFile(project), ownerFile = path.join(directory, `owner-${gate.transaction_id}.json`);
  // The UUID-bearing filename is also the cleanup claim: concurrent recoverers
  // cannot unlink a newer owner's metadata or both successfully claim this one.
  try { fs.unlinkSync(safePath(project, ownerFile)); }
  catch (e) { if (e.code === 'ENOENT') fail('STALE_DRAFT_TRANSACTION', '事务已被另一恢复者处理；请重新检查'); throw e; }
  if (JSON.stringify(gateIdentity(fs.lstatSync(directory))) !== JSON.stringify(gate.gate_identity)) {
    fail('STALE_DRAFT_TRANSACTION', '事务目录身份已改变，未删除目录；请人工核对');
  }
  fs.rmdirSync(directory); // Never recursive; unknown files are never removed.
  return { ok: true, recovered: true, transaction_id: gate.transaction_id, recovery_hash,
    message: '已清理经核验死亡的事务 owner 与空门；活动草稿、历史和所有临时文件保持原样。请重新 sceneDraftRecovery 后继续。' };
}

/** Read-only recovery preview. Hashes are CAS tokens, NOT author review receipts.
 * Pass all four *_hash tokens to rebaseSceneDrafts and explicitly select reuse_scenes.
 * An interrupted .transaction is reported, never cleared by this read-only API.
 */
export function sceneDraftRecovery(project) {
  const beforeBusy = inTransaction(project), state = recoverySnapshot(project);
  const after = recoverySnapshot(project);
  if (state.recoveryHash !== after.recoveryHash) fail('STALE_DRAFT_RECOVERY', '读取期间草稿或基线已改变，请重新检查');
  const busy = beforeBusy || inTransaction(project);
  const transactionStatus = inspectTransaction(project, state);
  return { scriptHash: state.current.scriptHash, sourceHash: state.current.sourceHash,
    manifestHash: state.manifestHash, engineHash: state.current.engineHash, recoveryHash: state.recoveryHash,
    script_hash: state.current.scriptHash, source_hash: state.current.sourceHash,
    manifest_hash: state.manifestHash, engine_hash: state.current.engineHash, recovery_hash: state.recoveryHash,
    count: state.current.count, stale: !!state.previous && (state.previous.scriptHash !== state.current.scriptHash ||
      state.sourceConflict || state.previous.count !== state.current.count ||
      (state.previous.engineHash && state.previous.engineHash !== state.current.engineHash)),
    source_conflict: state.sourceConflict, transaction_pending: busy, transaction: transactionStatus,
    transaction_hash: transactionStatus.transaction_hash || null, transaction_recoverable: transactionStatus.recoverable,
    can_rebase: !busy && !state.sourceConflict,
    reusable: busy ? [] : state.scenes.filter(s => s.reusable).map(s => s.scene), scenes: state.scenes };
}

/** Start a new draft generation without modifying any author file.
 * External source changes are deliberately NOT acknowledgeable here: reconcile
 * scenes.src.js separately, then inspect again. reuse_scenes defaults to none.
 * History and staged generations precede the sole commit point (manifest rename).
 * A process crash leaves a fail-closed transaction, never a mixed active generation.
 */
export function rebaseSceneDrafts(project, { script_hash, source_hash, manifest_hash, recovery_hash, reuse_scenes = [] } = {}) {
  return transaction(project, () => {
    const state = recoverySnapshot(project);
    const cas = latest => {
      if (typeof script_hash !== 'string' || typeof source_hash !== 'string' || typeof recovery_hash !== 'string' ||
          script_hash !== latest.current.scriptHash || source_hash !== latest.current.sourceHash ||
          manifest_hash !== latest.manifestHash || recovery_hash !== latest.recoveryHash) {
        fail('STALE_DRAFT_RECOVERY', '恢复基线已过期或缺少 CAS 哈希；请先 sceneDraftRecovery，未切换草稿');
      }
    };
    cas(state);
    if (state.sourceConflict) fail('DRAFT_SOURCE_CONFLICT', 'scenes.src.js 有外部修改；不能通过重开草稿授权覆盖，请先明确核对并解决源冲突');
    if (!Array.isArray(reuse_scenes) || new Set(reuse_scenes).size !== reuse_scenes.length ||
        reuse_scenes.some(n => !Number.isInteger(n) || !state.scenes.some(s => s.scene === n && s.reusable))) {
      fail('UNSAFE_DRAFT_REUSE', '复用列表只能包含检查结果中有完整身份证据的场次');
    }
    const id = randomUUID(), history = path.join(home(project), 'history', id);
    if (state.manifestText !== null) put(project, path.join(history, 'manifest.json'), state.manifestText);
    for (const draft of state.drafts) put(project, path.join(history, draft.name), draft.text);
    put(project, path.join(history, 'recovery.json'), JSON.stringify({ version: 1, created_at: new Date().toISOString(),
      script_hash, source_hash, manifest_hash, recovery_hash, reuse_scenes, generation: id }));
    const next = { ...state.current, generation: id, revision: randomUUID(), draftHashes: {},
      recovery: { previousManifestHash: state.manifestHash, history: `history/${id}`, reused: reuse_scenes } };
    // Create even an empty generation before the manifest can reference it.
    safePath(project, path.join(home(project), 'generations', id, '.path-check'), true);
    for (const n of reuse_scenes) {
      const text = state.drafts.find(d => d.name === `S${n}.js`).text;
      put(project, draftFile(project, n, next), text); next.draftHashes[n] = hash(text);
    }
    put(project, manifestFile(project), JSON.stringify(next), () => cas(recoverySnapshot(project)));
    return { ok: true, reused: [...reuse_scenes], missing: state.scenes.filter(s => !reuse_scenes.includes(s.scene)).map(s => s.scene),
      archive_path: path.relative(path.resolve(project), history).split(path.sep).join('/'),
      manifest_hash: hash(JSON.stringify(next)), message: '已受控重开分场草稿；旧清单和草稿已归档，未改动 scenes.src.js，亦不代表内容已审阅' };
  });
}
