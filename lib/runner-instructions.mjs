/* Receipts mean an instruction was included in an accepted session request,
 * not that an edit is done. Uncertain requests must be inspected on resume. */
import { createHash } from 'node:crypto';
const key = note => createHash('sha256').update(String(note.id)).update('\0').update(note.content).digest('hex');

export function pendingRunnerInstructions(instructions = [], included = []) {
  if (!Array.isArray(instructions) || !Array.isArray(included)) throw new Error('补充要求记录损坏，未启动执行器');
  const known = new Set(included), seen = new Set();
  return instructions.map(note => {
    if (!note || typeof note.id !== 'string' || !note.id || typeof note.content !== 'string' || !note.content.trim()) throw new Error('补充要求记录损坏，未启动执行器');
    return { ...note, key: key(note) };
  }).filter(note => {
    if (known.has(note.key) || seen.has(note.key)) return false;
    seen.add(note.key); return true;
  });
}

export function instructionsPrompt(notes) {
  return notes.length ? '\n\n【用户补充要求，优先于原计划】\n' + notes.map((note, i) =>
    `${i + 1}. [${note.key.slice(0, 16)}] ${note.content}`).join('\n') +
    '\n先核对当前文件与上次不确定的副作用；收到要求不等于已落实，不重复已完成的制作或对外动作。' : '';
}
