/* 改片记录：从任务日志里提炼「你说过什么、它改了哪些文件」。
 *
 * 只读，不改任何制作状态。为什么单独一层：
 *   .vh-chat.log 是给人看的长日志，格式会随工具变化；界面需要的是稳定结构。
 *   把解析集中在这里，日志格式变了只改一处，面板不用跟着改。
 *
 * 不做的：还原 diff、判断改得好不好。那是人看片的事。
 */
import fs from 'node:fs';
import path from 'node:path';

const LOG = 'out/.vh-chat.log';
/* 只认作者文件与关键配置；临时文件、缓存不进列表，否则每次都有几十条噪音。 */
const TRACKED = ['脚本.md', '方案.md', 'scenes.src.js', 'engine.tpl.html', '发布文案.md', 'claims.json', 'PROJECT.json'];
/* 头部两种写法：用户指令以 `══` 开头但结尾没有；插话结尾补 ` ══`。 */
const HEADER = /^══\s+(.*?)(?:\s*══)?$/;

/* 头部行 → 结构化事件。认不出的头部不算错误，只是不展示。 */
function readHeader(text) {
  const user = text.match(/^用户\s+(\d{2}:\d{2}:\d{2})（[^）]*）：(.*)$/);
  if (user) return { kind: 'user', clock: user[1], text: user[2].trim() };
  const steer = text.match(/^插话（([^）]*)）：(.*)$/);
  if (steer) return { kind: 'steer', note: steer[1].trim(), text: steer[2].trim() };
  const resume = text.match(/^继续原任务，正在启动第\s*(\d+)\s*次执行$/);
  if (resume) return { kind: 'resume', attempt: Number(resume[1]) };
  if (/^(任务已提交|制作进程启动失败|已取消|完成|任务失败|任务未完成)/.test(text)) {
    return { kind: 'status', text };
  }
  return null;
}

/* 工具行里出现的作者文件名。同一文件多次改动只记一次。 */
function filesIn(line) {
  const out = [];
  for (const name of TRACKED) if (line.includes(name)) out.push(name);
  return out;
}

export function parseChatHistory(text, { limit = 12 } = {}) {
  const entries = [];
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(HEADER);
    if (header) {
      const event = readHeader(header[1]);
      if (event) {
        current = { ...event, files: [] };
        // 只有「人说的话」与「插话」值得单列；纯状态行并入上一条，避免列表被"完成/失败"刷屏。
        if (event.kind === 'user' || event.kind === 'steer') entries.push(current);
      }
      continue;
    }
    if (!current) continue;
    /* 只统计「真的改了」的操作。读文件也会提到文件名，
     * 全算进去会让人以为改了一堆，实际只是看了一眼。 */
    if (/^(·\s*)?(edit|write|patch|replace_scene)\s*完成/.test(line)) {
      for (const name of filesIn(line)) if (!current.files.includes(name)) current.files.push(name);
    }
  }
  return entries.slice(-limit).reverse();
}

export function readChatHistory(project, options = {}) {
  let text = '';
  try { text = fs.readFileSync(path.join(project, LOG), 'utf8'); } catch { return []; }
  return parseChatHistory(text, options);
}

/* 已归档的旧任务（开新一轮时归档）不并入当前列表：
 * 它们的目标和当前片子的关系需要人判断，混在一起会让人以为都能撤回。 */
export function archivedTaskCount(project) {
  const dir = path.join(project, 'out/.vh-tasks');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
  } catch { return 0; }
}
