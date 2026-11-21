/* A task's goal is not the subprocess's exit code. Hashes prove scope/version
 * changes, not the semantic correctness of an edit or a human review. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDiscussionOnly, isPureContinuation, nextReadOnlyScope } from './change-contract.mjs';
import { isReviewRequest } from './review-request.mjs';
import { TASK_MODES } from './task-prompts.mjs';

export const CONTRACT_AUTHORS = Object.freeze(['脚本.md', 'scenes.src.js', 'engine.tpl.html', '方案.md', 'claims.json', '发布文案.md']);
const targets = {
  article: ['脚本.md', 'scenes.src.js', 'engine.tpl.html'],
  topic: ['脚本.md', 'scenes.src.js', 'engine.tpl.html'],
  edit: ['脚本.md', 'scenes.src.js', 'engine.tpl.html', '发布文案.md'],
  'edit-visual': ['scenes.src.js', 'engine.tpl.html'],
  'edit-script': ['脚本.md', 'scenes.src.js'],
  'edit-copy': ['发布文案.md'],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function taskAuthorRevision(project) {
  return Object.fromEntries(CONTRACT_AUTHORS.map(name => {
    const file = path.join(fs.realpathSync(project), name);
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!fs.fstatSync(fd).isFile()) throw new Error('作者文件必须为普通文件：' + name);
      return [name, sha(fs.readFileSync(fd))];
    } catch (error) {
      if (error.code === 'ENOENT') return [name, null];
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }));
}

export function createTaskContract(project, { mode = 'edit', message = '', previous } = {}) {
  if (!TASK_MODES.includes(mode)) throw new Error('无效任务模式：' + mode);
  /* 新片/新稿入口（article/topic）粘贴的是原文，不是给编辑的指令。
   * 文章正文常出现「先分析」「不要修改」「检查有没有显示异常」这类句子，那是在讲别的事，
   * 不能据此把整支片子判成只读任务。只有整段输入很短、又明确是「先讨论/只读」时才算请求。
   * 已经明确只读的任务仍由 nextReadOnlyScope 保持，直到用户给出明确修改动作。
   * 改稿、审阅等既有场景保留原来的判定。 */
  const text = String(message);
  const sourceMode = ['article', 'topic'].includes(mode);
  const explicitReadOnly = text.trim().length <= 60 && isDiscussionOnly(text);
  const readOnly = sourceMode && !previous?.readOnly ? explicitReadOnly
    : nextReadOnlyScope(previous?.readOnly, message) || isReviewRequest(message);
  return { version: 1, mode, readOnly, baseline: taskAuthorRevision(project),
    allowedAuthors: readOnly ? [] : mode.startsWith('edit-') ? targets[mode] : [...CONTRACT_AUTHORS],
    changeTargets: targets[mode], requireChange: !readOnly && !isPureContinuation(message),
    instructionHash: sha(String(message)), capturedAt: Date.now() };
}

export function taskScopeObservation(project, contract) {
  if (!contract) return { stale: false, changed: [] };
  if (contract.version !== 1 || !TASK_MODES.includes(contract.mode) || !contract.baseline ||
      !Array.isArray(contract.allowedAuthors) || !Array.isArray(contract.changeTargets)) {
    return { stale: true, reason: '任务范围合同损坏，未认定修改完成', changed: [] };
  }
  const current = taskAuthorRevision(project);
  const changed = CONTRACT_AUTHORS.filter(name => current[name] !== contract.baseline[name]);
  const forbidden = changed.filter(name => !contract.allowedAuthors.includes(name));
  if (forbidden.length) return { stale: true, reason: '修改越出本轮范围：' + forbidden.join('、') + '；文件已保留，未自动回退，请先核对', changed, forbidden };
  if (contract.requireChange && !contract.changeTargets.some(name => current[name] !== null && current[name] !== contract.baseline[name])) {
    return { stale: true, reason: '本轮要求尚无对应作者文件改动，旧文件或一句完成说明不能证明已经落实', changed };
  }
  return { stale: false, changed };
}

export function taskContractPrompt(contract) {
  if (!contract) return '';
  return '【本轮执行范围】\n' + (contract.readOnly
    ? '本轮只读并回答，不修改作者文件，不启动制作或付费审稿。'
    : '任务模式：' + contract.mode + '。允许修改的作者文件：' + contract.allowedAuthors.join('、') + '。' +
      '不得为绕过检查更改 PROJECT.json、任务状态、阶段指纹或用户设置。' +
      (contract.requireChange ? '必须实际落实要求；只回复完成或沿用旧成片不算完成。' : '先核对已有文件，只补失效阶段。'));
}
