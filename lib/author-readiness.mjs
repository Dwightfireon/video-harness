/* Initial author drafts are submitted explicitly; file existence is not completion.
 * Legacy projects use conservative structural checks, never project JavaScript. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseScript, parseChunks, skillDir } from './state.mjs';
import { readEditFile } from './author-edits.mjs';
import { scriptSubjectIssue, scriptNumberingIssue } from './script-metadata.mjs';
import { workflowPolicy } from './workflow-policy.mjs';
import { initializeContentReview } from './content-review.mjs';

const DOCUMENTS = new Set(['方案.md', '脚本.md']);
const hash = text => createHash('sha256').update(text).digest('hex');
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const receiptFile = (project, name) => path.join(project, 'out/.vh-author-drafts', name + '.json');
function receipt(project, name) {
  try {
    const value = JSON.parse(fs.readFileSync(receiptFile(project, name), 'utf8'));
    if (value.version !== 1 || !['writing', 'submitted'].includes(value.status)) throw new Error();
    return value;
  } catch (error) { return error.code === 'ENOENT' ? null : { status: 'invalid' }; }
}
function saveReceipt(project, name, value) {
  if (!DOCUMENTS.has(name)) throw new Error('只支持提交 方案.md / 脚本.md');
  let dir = fs.realpathSync(project);
  for (const part of ['out', '.vh-author-drafts']) {
    dir = path.join(dir, part);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('草稿状态目录不能是符号链接');
  }
  const file = path.join(dir, name + '.json'), temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, ...value }) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

// Do not interpret examples inside fenced code as actual scene declarations.
function markdown(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}
export function plannedScenes(text) {
  return [...new Set([...markdown(text).matchAll(/^\s*\|\s*\*{0,2}S(\d+)\*{0,2}\s*\|/gm)]
    .map(match => Number(match[1])).filter(n => n > 0))];
}

export function authorDocumentState(project, name, { submitting = false } = {}) {
  if (!DOCUMENTS.has(name)) throw new Error('不是可提交的作者文档');
  const text = read(path.join(project, name)), record = receipt(project, name);
  const base_hash = fs.existsSync(path.join(project, name)) ? hash(text) : null;
  if (!text.trim()) return { ok: false, state: 'missing', base_hash, reason: name + ' 还没有正文' };
  if (record?.status === 'invalid') return { ok: false, state: 'invalid', base_hash, reason: '草稿状态损坏，须先核对，不把文件存在当成完成' };
  if (name === '脚本.md') {
    const source = markdown(text), scenes = parseScript(source);
    const numbering = scriptNumberingIssue(source);
    if (numbering) return { ok: false, state: 'incomplete', base_hash, reason: numbering };
    const headings = [...source.matchAll(/^##\s*S(\d+)\b/gm)];
    if (!scenes.length || headings.length !== scenes.length || scenes.some((scene, i) => scene.n !== i + 1)) {
      return { ok: false, state: 'incomplete', base_hash, reason: '脚本场次须从 S1 连续编号，每场都要有编号旁白；不能提交空场或半截场' };
    }
    // This is initial-production reconciliation, not an instruction to restore
    // intentionally deleted scenes in an already submitted/rendered project.
    if (record?.status !== 'submitted' && !fs.existsSync(path.join(project, 'out/video.mp4'))) {
      const planned = plannedScenes(read(path.join(project, '方案.md')));
      const missing = planned.filter(n => !scenes.some(scene => scene.n === n));
      if (missing.length) return { ok: false, state: 'incomplete', base_hash,
        reason: `方案规划 ${planned.length} 场，脚本只有 ${scenes.length} 场，尚缺 ${missing.map(n => 'S' + n).join('、')}；先补齐脚本，若已明确缩小范围则同步修改方案` };
    }
  }
  if (!submitting && record?.status === 'writing') return { ok: false, state: 'writing', base_hash,
    reason: `${name} 仍是分批草稿，写完全部内容后调用 finish_draft 提交当前 base_hash` };
  return { ok: true, state: 'ready', base_hash, reason: null };
}

// Mark BEFORE writing: interruption cannot turn a half-file into an untracked
// legacy document. Continuing a legacy partial script also starts a draft;
// edits to already complete author documents remain ordinary edits.
export function beginAuthorDraft(project, name) {
  if (!DOCUMENTS.has(name)) return;
  const state = authorDocumentState(project, name);
  if (['missing', 'incomplete'].includes(state.state)) saveReceipt(project, name, { status: 'writing' });
}
export function finishAuthorDraft(project, name, base_hash) {
  if (!DOCUMENTS.has(name)) throw new Error('finish_draft 只支持 方案.md / 脚本.md');
  const current = readEditFile(project, name, { max_lines: 1 });
  if (!/^[a-f0-9]{64}$/.test(base_hash || '') || current.base_hash !== base_hash) throw new Error('base_hash 已过期或无效；先 read_edit_file 核对当前全文版本，未提交草稿');
  const status = authorDocumentState(project, name, { submitting: true });
  if (!status.ok) throw new Error(status.reason);
  if (name === '脚本.md') {
    const issue = scriptSubjectIssue(fs.readFileSync(path.join(project, name), 'utf8'), { opening: workflowPolicy(project).editorialDiagnostics });
    if (issue) throw new Error(issue);
  }
  // Recheck immediately before recording submission; no author bytes are changed.
  if (readEditFile(project, name, { max_lines: 1 }).base_hash !== base_hash) throw new Error('提交期间作者文档已改变，未提交旧稿');
  if (name === '脚本.md') initializeContentReview(project);
  saveReceipt(project, name, { status: 'submitted', base_hash });
  return { ok: true, path: name, base_hash, message: '作者草稿已提交；仅核验完整性，不代表内容或人工审阅通过' };
}

const body = chunk => chunk.replace(/^(?:\s*\/\/[^\n]*(?:\n|$))*/, '').trim();
export function sceneAuthoringState(project) {
  const file = path.join(project, 'scenes.src.js'), source = read(file), chunks = parseChunks(file);
  if (!chunks.length) return { needed: true, reason: '还没有真实场景代码' };
  let installed;
  try { installed = JSON.parse(read(path.join(project, 'PROJECT.json'))).installedFiles?.['scenes.src.js']; } catch {}
  const skill = skillDir();
  const sample = skill ? read(path.join(skill, 'assets/scenes.src.js')) : '';
  const samples = sample.split(/^\/\/---\s*$/m).map(body).filter(Boolean);
  const untouched = installed && hash(source) === installed;
  const placeholders = chunks.map((chunk, i) => samples.includes(body(chunk)) ? i + 1 : null).filter(Boolean);
  return untouched || placeholders.length
    ? { needed: true, reason: untouched ? 'scenes.src.js 仍是初始化示例，尚未制作本片画面'
      : `S${placeholders.join('、S')} 仍是初始化示例，不能以场数相等冒充画面完成` }
    : { needed: false, reason: null };
}
