import { isDiscussionOnly } from './change-contract.mjs';

/* 本轮新指令的选择规则（纯函数，便于回归）。
 *
 * 两种入口都要正确：
 *  1) CLI 新任务：没有任务 ID，指令就是用户刚输入的文本。
 *  2) 网页/内部派发：即使带任务 ID，只要是“新任务”（非恢复），
 *     任务记录里的 message 仍是本轮新指令；否则新片子的第一句话会被丢掉。
 * 只有“恢复原任务”才不带新指令；恢复时用户补的要求放在 resumeInstructions。
 */
export function freshInstructionFor({ shouldResume = false, raw = '', resumeInstructions = [] } = {}) {
  if (Array.isArray(resumeInstructions) && resumeInstructions.length) {
    return resumeInstructions.map(n => n.content || '').filter(Boolean).join('\n');
  }
  if (shouldResume) return '';
  return String(raw || '').trim();
}

// Source text is not a control channel. A leading explicit read-only request
// still wins, including a short request entered at the new-video entry point.
export function instructionKindFor({ mode, shouldResume = false, hasScript = false, text = '' } = {}) {
  if (shouldResume || hasScript || !['article', 'topic'].includes(mode)) return 'request';
  const firstLine = String(text).trim().split('\n')[0];
  return isDiscussionOnly(firstLine) ? 'request' : 'material';
}
