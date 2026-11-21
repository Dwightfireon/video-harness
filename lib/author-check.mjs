/* Explicit author-only check reuse. Never used as a media/release gate.
 * Whitelisted read footprints; unknown shared checker versions run uncached. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { skillDir } from './state.mjs';
import { analyze, writeReport } from './clarity.mjs';
import { parseEvidenceAnchors } from './author-evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = 'out/.vh-author-check.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Audited read footprint: script + top-level research/*.md, built-in fs/path only.
const KNOWN_SCRIPT = 'dc6b7f7eca343d7844cd1a5466603009b3a9488cf888174d66c6de84d86b2cbc';
const read = file => { try { return fs.readFileSync(file); } catch { return null; } };
const codeHashes = () => Object.fromEntries(['author-check.mjs', 'clarity.mjs', 'author-evidence.mjs', 'state.mjs']
  .map(n => [n, hash(read(path.join(HERE, n)) || '')]));
const loadedCode = JSON.stringify(codeHashes());

function inputs(project, { kind, terms, skill: explicitSkill }) {
  const base = fs.realpathSync(project), files = {};
  let safe = true;
  const add = (name, target = path.join(base, name)) => {
    try {
      if (!fs.realpathSync(target).startsWith(base + path.sep)) { files[name] = 'outside-project'; safe = false; return; }
      const bytes = read(target); files[name] = bytes ? hash(bytes) : 'unreadable';
      if (!bytes) safe = false;
    } catch (error) { files[name] = 'missing'; if (error.code !== 'ENOENT') safe = false; }
  };
  for (const name of ['脚本.md', '方案.md', 'PROJECT.json', 'vh.config.json']) add(name);
  let receipt = {};
  const receiptBytes = read(path.join(base, 'out/.vh-runner.json'));
  if (receiptBytes) {
    try {
      receipt = JSON.parse(receiptBytes);
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
          (receipt.authorEvidence && !Array.isArray(receipt.authorEvidence.anchors))) throw new Error('bad receipt');
    } catch { receipt = {}; safe = false; }
  }
  const plan = read(path.join(base, '方案.md'))?.toString('utf8') || '';
  const anchors = [...parseEvidenceAnchors(plan).anchors, ...(receipt.authorEvidence?.anchors || [])];
  for (const a of anchors) if (a?.source?.path) add(a.source.path);
  let names = [];
  try { names = fs.readdirSync(path.join(base, 'research')).filter(n => n.endsWith('.md')).sort(); }
  catch (error) { if (error.code !== 'ENOENT') safe = false; }
  for (const name of names) add('research/' + name);
  const skill = kind === 'script' ? skillDir(explicitSkill) : null;
  if (kind === 'script' && !skill) throw new Error('找不到 article-video skill，未执行脚本检查；请配置 ARTICLE_VIDEO_SKILL_DIR');
  const checker = skill ? path.join(skill, 'scripts/check-script.mjs') : null;
  const checkerHash = checker ? hash(read(checker) || '') : null;
  const code = codeHashes();
  const identity = { version: 1, base, kind, terms, files, researchNames: names, evidence: receipt.authorEvidence || null,
    code, checker, checkerHash, node: process.version, execPath: process.execPath, nodeOptions: process.env.NODE_OPTIONS || '' };
  // Preloads have arbitrary dependencies. A long-lived caller whose on-disk
  // modules changed must restart before its loaded code can create a receipt.
  safe &&= !identity.nodeOptions && !process.execArgv.some(a => /^--(?:import|require|loader|experimental-loader)(?:=|$)|^-r/.test(a));
  return { key: hash(JSON.stringify(identity)), checker,
    cacheable: safe && JSON.stringify(code) === loadedCode && (kind !== 'script' || checkerHash === KNOWN_SCRIPT) };
}

export function runAuthorCheck(project, { kind = 'clarity', terms = '', skill = '', show = false, onExecute = () => {} } = {}) {
  if (!['script', 'clarity'].includes(kind)) throw new Error('作者检查只支持 script / clarity，不执行任意 shell');
  project = fs.realpathSync(project);
  const before = inputs(project, { kind, terms, skill });
  const cacheFile = path.join(project, CACHE);
  let saved;
  try { saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  const valid = before.cacheable && saved?.version === 1 && saved.key === before.key && saved.result &&
    saved.digest === hash(JSON.stringify(saved.result)) && [0, 1].includes(saved.result?.exitCode) &&
    typeof saved.result?.stdout === 'string' && typeof saved.result?.stderr === 'string';
  // --show must not quietly run a new check or display a stale result as current.
  if (show && !valid) throw new Error('没有当前输入版本的完整检查结果；先执行检查，不展示过期结果');
  if (valid) return { ...saved.result, cached: true, key: before.key };
  onExecute();
  let result;
  if (kind === 'script') {
    const args = [before.checker, path.join(project, '脚本.md')];
    if (terms) args.push('--terms', terms);
    const proc = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    result = { exitCode: proc.status === 0 && !proc.error && !proc.signal ? 0 : 1,
      stdout: proc.stdout || '', stderr: (proc.stderr || '') + (proc.error ? '\n' + proc.error.message : ''),
      semanticStatus: 'not-verified', executionError: Boolean(proc.error || proc.signal) };
  } else {
    const res = analyze(project);
    const report = writeReport(project, res);
    result = { exitCode: res.fail.length ? 1 : 0, stdout: fs.readFileSync(report, 'utf8'), stderr: '',
      fail: res.fail, pending: res.pending, semanticStatus: 'not-verified', executionError: false };
  }
  const after = inputs(project, { kind, terms, skill });
  // Cache failures as failures too. Pending remains pending. Race/error results
  // are returned honestly but not committed as reusable evidence.
  if (before.cacheable && after.cacheable && before.key === after.key && !result.executionError) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const temp = cacheFile + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, key: before.key, result, digest: hash(JSON.stringify(result)) }), { mode: 0o600 });
      fs.renameSync(temp, cacheFile);
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }
  return { ...result, cached: false, key: before.key, cacheable: before.cacheable && after.cacheable && before.key === after.key && !result.executionError };
}
