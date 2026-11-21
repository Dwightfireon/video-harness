/* 插话接收不等于修改完成。验收绑定当前作者文件内容，后续改动会使旧验收失效。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PUBLIC_AUTHORS = ['脚本.md', 'scenes.src.js', '发布文案.md'];
/* 方案与证据是制作依据，不进入公开发布物；脱敏默认只约束交付内容。
 * 用户明确要求内部资料也脱敏时，另建范围，不能靠反复搜索把两个范围混在一起。 */
export const INTERNAL_EVIDENCE = ['方案.md', 'claims.json'];
const TRACKED_AUTHORS = [...PUBLIC_AUTHORS, 'engine.tpl.html', '方案.md', 'claims.json'];
const hash = text => createHash('sha256').update(text).digest('hex');
const read = (project, file) => { try { return fs.readFileSync(path.join(project, file), 'utf8'); } catch { return null; } };
export function authorRevision(project) {
  return Object.fromEntries(TRACKED_AUTHORS.map(file => [file, read(project, file)]).map(([file, text]) => [file, text == null ? null : hash(text)]));
}
export function explicitReplacements(text) {
  const rules = [];
  for (const m of String(text).matchAll(/[“"「『']([^”"」』'\n]{1,60})[”"」』']\s*(?:替换为|替换成|改为|改成)\s*[“"「『']([^”"」』'\n]{1,60})[”"」』']/g)) {
    if (m[1] !== m[2]) rules.push({ from: m[1], to: m[2] });
  }
  return rules;
}
export function isChangeRequest(text) {
  return /脱敏|匿名|不(?:要|许).{0,15}(?:政治|人名|名字)|替换为|替换成|改成|改为|删掉|删除|修正|修复|保留.{0,12}(?:重点|精华|核心)|(?:不要|不用|没必要|不必).{0,12}(?:放|加|讲|写|出现|保留)/.test(String(text));
}

/* 判断"用户这一轮是不是提了要求"，不能用"包含哪些编辑动词"来做：
 * 那张词表永远补不完（真实事故：片尾接广告、换标题、改字幕各漏一次）。
 * 反过来做：只要用户真的说了话，就默认是一条要求；只有一小撮
 * 纯"继续"类短语才豁免。新说法于是默认被覆盖，而不是默认被忽略。 */
const CONTINUATION_ONLY = [
  /^(?:请|那就|就)?(?:继续|接着|往下)(?:做|执行|完成|推进|跑)?(?:原任务|下去|吧|好了)?[。！!.…\s]*$/,
  /^(?:继续|接着|往下)(?:完成|执行|推进)?(?:之前|原来|刚才)的?(?:任务|工作|制作)?[。！!.…\s]*$/,
  /* 只在"推进已有工作"这一小类里豁免：继续出片/继续渲染/按原稿继续。
   * 这是封闭集合；除此之外一律当作用户要求（宁可多改一次，不可漏掉要求）。 */
  /^(?:保留|按照|按|沿用).{0,16}?(?:继续|接着|往下)(?:做|出片|渲染|完成|推进|跑).{0,8}$/,
  /(?:继续|接着|往下)(?:出片|渲染|完成|推进|跑起来)[。！!.…\s]*$/,
  /^(?:retry|continue|resume|go on|keep going)[.!…\s]*$/i,
  /^(?:请)?(?:完成|制作|生成)(?:当前|这个|这支|这部|这条|该)?(?:视频|片子|影片)(?:吧)?[。！!.…\s]*$/,
];
export function isPureContinuation(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return true;
  if (value.length > 30) return false;
  return CONTINUATION_ONLY.some(pattern => pattern.test(value));
}

/* 用户明确说"先讨论/只读/不要改"时，不能拿新要求去强行改稿。 */
export function isDiscussionOnly(text) {
  const value = String(text || '');
  if (/先(?:讨论|检查资料|只读|分析)|只(?:讨论|看看|检查)|(?:只读|只做审查|仅做审查)|(?:不能|禁止|不许)(?:编辑|修改|写入)/.test(value)) return true;
  // A scoped prohibition is not a global stop: “不要改脚本，只改画面”
  // and “不要执行旧计划，改写另一个文件” still authorize the named edit.
  if (/(?:不要|不许|禁止)(?:写入|写|修改|改动|执行)(?:任何|所有)?(?:文件|内容|代码|操作|命令)?(?:[。！!，,；;\n]|$)/.test(value)) return true;
  const positiveEdit = value.split(/[，,。；;\n]/).some(clause =>
    /^\s*(?:只|仅|现在|请|改为)?\s*(?:改写|修改|替换|调整|补充|新增|写入|制作|生成|重做|改)(?!善)/.test(clause));
  return !positiveEdit && /不要(?:写|修改|执行)|只读/.test(value);
}

/** Clearing an existing read-only scope requires a positive imperative, not an
 * unrelated question. The surrounding task still controls which files may change. */
export function isExplicitMutation(text) {
  if (isDiscussionOnly(text)) return false;
  return String(text || '').split(/[，,。；;\n]/).some(clause =>
    /^\s*(?:(?:请|现在|直接|开始|继续|允许|可以|同意|那就|帮我|麻烦)\s*)*(?:修改|修复|改写|写入|保存|制作|生成|重做|替换|调整|新增|补充|删除|删去|删掉|去掉|添加|加上|改)(?!建议|方法|方式)/.test(clause));
}

export function nextReadOnlyScope(previous, note) {
  if (!String(note || '').trim() || isPureContinuation(note)) return !!previous;
  if (isDiscussionOnly(note)) return true;
  return previous ? !isExplicitMutation(note) : false;
}

export function replacementRemainder(text, rule) {
  return rule.to.includes(rule.from) ? text.split(rule.to).join(' '.repeat(rule.to.length)) : text;
}
export function addChange(project, changes, { id, text }) {
  /* Source material (whole pasted articles) is handled by the caller's size
   * check; here the test is "is this an actionable instruction at all". */
  if (!isChangeRequest(text)) return null;
  const key = id || 'change-' + hash(String(text)).slice(0, 20);
  const existing = changes.find(c => c.id === key || c.text === text);
  if (existing) return existing;
  const change = { id: key, text: String(text), kind: /脱敏|匿名|不(?:要|许).{0,15}(?:政治|人名|名字)/.test(text) ? 'redact' : 'edit',
    baseline: authorRevision(project), rules: explicitReplacements(text), forbidden: [], status: 'received' };
  change.rules = change.rules.map(rule => ({ ...rule, files: PUBLIC_AUTHORS.filter(file => read(project, file)?.includes(rule.from)) }));
  change.scope = 'public';
  change.semantic = change.kind === 'edit' && !change.rules.length;
  for (const previous of changes) {
    if (change.rules.length && previous.rules?.length && change.rules.some(next => previous.rules.some(old => next.from === old.from || next.from === old.to))) {
      previous.status = 'superseded'; previous.supersededBy = key;
    }
  }
  if (/不(?:要|用|必).{0,6}(?:脱敏|匿名)/.test(text)) {
    for (const previous of changes) if (previous.kind === 'redact') { previous.status = 'superseded'; previous.supersededBy = key; }
    change.status = 'superseded'; change.summary = '用户明确取消脱敏要求，保留历史但不再作为待完成修改。';
  }
  changes.push(change); return change;
}
export function restoreChanges(project, saved, messages, task) {
  const changes = structuredClone(saved || []);
  // 旧检查点迁移：只识别明确的插话，不从材料逐字稿中抽出“用户要求”。
  for (const message of messages || []) {
    const prefix = '【用户中途补充指令，优先级高于原计划】';
    if (message.role === 'user' && message.content?.startsWith(prefix)) addChange(project, changes, { text: message.content.slice(prefix.length) });
  }
  const original = String(task || '').split('用户的指令是：').at(-1).trim();
  if (!messages?.length && original.length <= 1000) addChange(project, changes, { text: original });
  return changes;
}
export function changeIsVerified(project, change) {
  if (change.status === 'superseded') return true;
  /* Legacy misclassification: the initial article/topic task text was stored as
   * a change contract. It is source material, not a pending edit. Treat only
   * that exact long "(no rules, long text)" record as non-blocking; genuine
   * semantic edit requirements remain pending until verified. */
  if (change.kind === 'edit' && change.semantic && !(change.rules || []).length &&
    typeof change.text === 'string' && change.text.length > 1000) return true;
  if (change.status !== 'verified' || !change.verifiedHashes) return false;
  const current = authorRevision(project);
  // 脱敏只对公开交付物负责；内部证据后来补写，不能把已完成的公开版本判成失效。
  const files = change.scope === 'publish' ? ['发布文案.md'] : change.scope === 'public' ? PUBLIC_AUTHORS : TRACKED_AUTHORS;
  return files.every(file => current[file] === change.verifiedHashes[file]);
}
export function pendingChanges(project, changes) { return (changes || []).filter(c => !changeIsVerified(project, c)); }
export function defineChange(change, forbidden_terms) {
  if (!Array.isArray(forbidden_terms) || !forbidden_terms.length || forbidden_terms.length > 100 || forbidden_terms.some(t => typeof t !== 'string' || t.length < 2 || t.length > 80)) {
    throw new Error('请提供明确的待移除姓名/表述清单，每项2–80字，最多100项；定义清单不代表已经修改');
  }
  change.forbidden = [...new Set([...(change.forbidden || []), ...forbidden_terms])];
  change.status = 'received'; delete change.verifiedHashes;
  return { id: change.id, forbidden: change.forbidden, status: 'received', note: '清单已登记。下一步逐项小块修改；尚未应用或验收。' };
}
export function verifyChange(project, change, { forbidden_terms = [], summary = '', review = 'mechanical' } = {}) {
  if (typeof summary !== 'string' || summary.trim().length < 12) throw new Error('请先实际核对改动，并提供至少 12 字的检查说明，不能只说“完成”');
  if (!Array.isArray(forbidden_terms) || forbidden_terms.length > 100 || forbidden_terms.some(t => typeof t !== 'string' || t.length < 2 || t.length > 80)) {
    throw new Error('禁止词须为 JSON 字符串数组，每项 2–80 字符，最多 100 项');
  }
  const forbidden = [...new Set([...(change.forbidden || []), ...forbidden_terms])];
  change.forbidden = forbidden;
  if (change.kind === 'redact' && !forbidden.length) throw new Error('脱敏要求尚未列出需移除的人名/具体表述；请先检查原稿，提供禁止词清单，再逐项修改');
  const files = change.scope === 'publish' ? ['发布文案.md'] : PUBLIC_AUTHORS;
  const documents = files.map(file => ({ file, text: read(project, file) })).filter(d => d.text != null);
  const remaining = documents.flatMap(d => forbidden.filter(term => d.text.includes(term)).map(term => `${d.file}：${term}`));
  for (const rule of change.rules || []) {
    for (const doc of documents) if (replacementRemainder(doc.text, rule).includes(rule.from)) remaining.push(`${doc.file}：${rule.from}（仍在指定替换结果之外）`);
  }
  if (remaining.length) throw new Error('要求尚未完成，公开作者文件仍包含：' + remaining.slice(0, 12).join('；'));
  for (const rule of change.rules || []) {
    const targets = rule.files?.length ? documents.filter(d => rule.files.includes(d.file)) : documents;
    if (!targets.length || targets.some(d => !d.text.includes(rule.to))) throw new Error('指定替换结果尚未核验：应在对应文件中包含「' + rule.to + '」；不能只删原词就冒充已按要求替换');
  }
  const current = authorRevision(project);
  const changed = (change.scope === 'publish' ? files : TRACKED_AUTHORS).filter(file => current[file] !== change.baseline[file]);
  if (!changed.length && !forbidden.length) throw new Error('作者文件未改变，不能把一句说明当作已执行修改');
  change.status = 'verified'; change.summary = summary.trim(); change.verifiedHashes = current;
  change.review = change.semantic ? 'needs-human' : review;
  if (change.semantic) change.reviewNote = '语义要求已登记为完成候选；机械检查不能证明内容取舍正确，交付前仍须人工审阅。';
  return { id: change.id, status: 'verified', changedFiles: changed, checkedFiles: documents.map(d => d.file),
    review: change.review, scope: files,
    note: '改动/禁止词机械核验通过；本记录不代替内容语义审阅。最终视频仍须按新版本重建并验收。' };
}
export function changesPrompt(project, changes) {
  const pending = pendingChanges(project, changes);
  if (!pending.length) return '';
  if (pending.every(c => c.scope === 'publish')) return '【发布文案要求尚未验收，不能宣布完成】\n' +
    pending.map(c => `ID ${c.id}：${c.text}`).join('\n') +
    '\n本次只修改并核验发布文案.md；不修改脚本、场景或媒体。已有文案用短补丁，语义正确性仍须人工审阅。';
  return '【用户要求尚未验收，不能宣布完成】\n' + pending.map(c => `ID ${c.id}：${c.text}`).join('\n') +
    '\n交付范围只有 脚本.md、scenes.src.js、发布文案.md；方案.md 和 claims.json 是内部证据，不是发布内容，不要为了脱敏反复搜索或改写它们。' +
    '\n脱敏先用 define_change 列出具体姓名/表述（不是已完成），然后用 read_edit_file / patch_text 做短替换；只有布局/结构改变才用 read_scene / replace_scene。不要整片重写。' +
    '公开发布文件无残留时，执行器会直接做机械核验并推进，不需要模型再重复登记或搜索证据文件。收到指令不等于已应用，旧文件/旧视频不能充当这次交付。';
}

export function projectSemanticReviewPending(project) {
  try {
    const task = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8'));
    if (!/^[a-zA-Z0-9_-]+$/.test(task.id || '')) return [];
    const cp = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-tasks', task.id, 'checkpoint.json'), 'utf8'));
    if (cp.taskId !== task.id) return [];
    const contracts = restoreChanges(project, cp.changeContracts, cp.messages, cp.task);
    return (contracts || []).filter(c => c.status === 'verified' && c.review === 'needs-human' && !c.humanReviewed);
  } catch { return []; }
}

export function projectPendingChanges(project) {
  try {
    const task = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8'));
    if (!/^[a-zA-Z0-9_-]+$/.test(task.id || '')) return [];
    const cp = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-tasks', task.id, 'checkpoint.json'), 'utf8'));
    if (cp.taskId !== task.id) return [];
    const contracts = restoreChanges(project, cp.changeContracts, cp.messages, cp.task);
    return pendingChanges(project, contracts);
  } catch { return []; }
}
