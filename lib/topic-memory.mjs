/* 选题记忆与显式反馈。与制作状态分开，不把移除/换一批当成负反馈。 */
import { randomUUID, createHash } from 'node:crypto';
import { readSchedule, writeSchedule, topicDetails } from './schedule.mjs';
import { canEnqueueTopic } from './topic-research-store.mjs';

export const DISCOVERY_DEFAULTS = Object.freeze({
  enabled: false, query: 'AI 工具与本地大模型领域值得讲给普通用户的问题与变化',
  count: 3, mode: 'focused', autoQueue: false,
});

export function discoverySettings(queue) {
  return { ...DISCOVERY_DEFAULTS, ...(queue.discoveryConfig || {}) };
}

/* schedule 的制作输入规范化会略去未知 item 属性；记忆事务不应顺便删掉它们。 */
export function readTopicSchedule(root) {
  return readSchedule(root, { preserveItemFields: true });
}

export function bumpDiscoveryRevision(queue) {
  queue.discoveryRevision = Math.max(0, Number(queue.discoveryRevision) || 0) + 1;
}

/* 只读兼容：旧文件没有的来源不补造；GET 不负责迁移写盘。 */
export function topicHistory(queue) {
  const records = Array.isArray(queue.discoveryTopics) ? queue.discoveryTopics.filter(item => item && typeof item.id === 'string' && typeof item.topic === 'string') : [];
  const out = records.map(item => ({ ...item }));
  const known = new Set(out.map(item => item.topic));
  for (const item of [...(queue.items || []), ...(queue.runs || [])]) {
    if (!item?.topic || known.has(item.topic)) continue;
    known.add(item.topic);
    const key = item.id || createHash('sha256').update(item.topic).digest('hex').slice(0, 20);
    out.push({ ...topicDetails(item), id: `legacy-${key}`, topic: item.topic, at: item.addedAt || item.at || 0,
      query: '', status: 'queued', ...(item.id && (queue.items || []).includes(item) ? { queueId: item.id } : {}) });
  }
  return out;
}

const isCandidate = item => item.status === 'candidate' && item.placement !== 'history';
const currentQueueItem = (queue, record) => (queue.items || []).find(item => item.id === record.queueId || item.discoveryId === record.id);

function queuePlacement(queue, record) {
  const inQueue = !!currentQueueItem(queue, record);
  return { inQueue, queueState: inQueue ? 'present' : record.queueId ? 'removed' : record.status === 'queued' ? 'legacy' : 'none' };
}

export function topicRecordState(queue, record, root) {
  return { ...record, ...queuePlacement(queue, record), canEnqueue: canEnqueueTopic(root, record) };
}

function integer(value, fallback, min, max) {
  const n = Number(value);
  return value == null || !Number.isFinite(n) ? fallback : Math.max(min, Math.min(max, Math.floor(n)));
}

export function topicState(root, { limit = 100, historyLimit = 20, historyOffset = 0, historyFilter = 'all', historyQuery = '' } = {}) {
  const queue = readSchedule(root);
  // 持久数组顺序作为同一时间戳的稳定顺序，不在每次点击后随机重排同批候选。
  const all = topicHistory(queue).map((item, index) => ({ item: { ...item, ...queuePlacement(queue, item) }, index }))
    .sort((a, b) => (Number(b.item.at) || 0) - (Number(a.item.at) || 0) || a.index - b.index)
    .map(entry => entry.item);
  const candidates = all.filter(isCandidate), suggestions = all.filter(item => item.status === 'suggestion');
  historyLimit = integer(historyLimit, 20, 1, 100);
  historyOffset = integer(historyOffset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (!['all', 'queued', 'seen', 'dismissed', 'archived', 'duplicate'].includes(historyFilter)) historyFilter = 'all';
  historyQuery = text(historyQuery, 1000);
  const search = historyQuery.toLocaleLowerCase();
  const history = all.filter(item => !isCandidate(item) && item.status !== 'suggestion').filter(item => {
    if (historyFilter === 'queued' && item.queueState === 'none') return false;
    if (historyFilter === 'seen' && item.status !== 'seen' && item.feedback?.kind !== 'seen') return false;
    if (historyFilter === 'dismissed' && item.status !== 'dismissed' && item.feedback?.kind !== 'not-interested') return false;
    if (historyFilter === 'archived' && !['archived', 'superseded'].includes(item.status) && item.placement !== 'history') return false;
    if (historyFilter === 'duplicate' && item.status !== 'duplicate') return false;
    return !search || [item.topic, item.title, item.coreQuestion, item.feedback?.reason, item.feedback?.note]
      .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(search));
  });
  historyOffset = history.length ? Math.min(historyOffset, Math.floor((history.length - 1) / historyLimit) * historyLimit) : 0;
  // Pagination/filtering precede evidence replay: invisible historical records
  // must not synchronously reread every archived page on each UI refresh.
  // Memoize only within this response, so changed evidence is checked next time.
  const exposed = new Map();
  const present = item => {
    if (!exposed.has(item.id)) exposed.set(item.id, { ...item, canEnqueue: canEnqueueTopic(root, item) });
    return exposed.get(item.id);
  };
  return { topics: [...candidates, ...all.filter(item => !isCandidate(item))].slice(0, integer(limit, 100, 1, 500)).map(present),
    candidates: candidates.map(present), suggestions: suggestions.map(present), history: history.slice(historyOffset, historyOffset + historyLimit).map(present),
    historyTotal: history.length, historyOffset, historyLimit, historyFilter, historyQuery,
    historyNextOffset: historyOffset + historyLimit < history.length ? historyOffset + historyLimit : null,
    revision: Math.max(0, Number(queue.discoveryRevision) || 0),
    total: all.length, preferences: { notes: typeof queue.discoveryPreferences?.notes === 'string' ? queue.discoveryPreferences.notes : '' },
    config: discoverySettings(queue), feedbackCount: all.filter(item => item.feedback).length };
}

function bad(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

export function configureDiscovery(queue, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('选题设置必须是对象');
  const next = { ...(queue.discoveryConfig || {}) };
  for (const key of ['enabled', 'autoQueue']) {
    if (key in patch) { if (typeof patch[key] !== 'boolean') bad(`${key} 必须是开关`); next[key] = patch[key]; }
  }
  if ('query' in patch) {
    if (typeof patch.query !== 'string' || !patch.query.trim() || patch.query.length > 1000) bad('检索方向需为 1–1000 字');
    next.query = patch.query.trim();
  }
  if ('mode' in patch) {
    if (!['focused', 'explore', 'recent'].includes(patch.mode)) bad('探索模式只能是 focused、explore 或 recent');
    next.mode = patch.mode;
  }
  if ('count' in patch) {
    if (!Number.isInteger(patch.count) || patch.count < 1 || patch.count > 10) bad('每批候选数需为 1–10');
    next.count = patch.count;
  }
  queue.discoveryConfig = next;
  return next;
}

/* 同一同步事务内写候选状态与队列，不跨 await，不重写旧快照。 */
export function enqueueCandidate(queue, record, { root } = {}) {
  if (record.status === 'suggestion') bad('请先采用建议，再加入队列', 409);
  const previous = queue.items.find(item => item.discoveryId === record.id || item.id === record.queueId || item.topic === record.topic);
  if (previous) { record.status = 'queued'; record.queueId = previous.id; return previous; }
  // 一次选择只入队一次。用户移除了已入队的项，不因双击/旧标签页自动重新添加。
  if (record.queueId) return null;
  if (record.status === 'duplicate') bad('重复候选不能入队，请换一个问题');
  if (!canEnqueueTopic(root, record)) bad('请先调查问题；只有找到有效原文线索的候选才能加入队列', 409);
  const item = { id: randomUUID(), topic: record.topic, addedAt: Date.now(), ...topicDetails(record), discoveryId: record.id };
  queue.items.push(item);
  record.queueId = item.id;
  record.status = 'queued';
  return item;
}

export function updateTopicState(root, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('选题操作必须是对象');
  if ('id' in input && (typeof input.id !== 'string' || !input.id)) bad('选题 id 无效');
  const queue = readTopicSchedule(root);
  queue.discoveryTopics = topicHistory(queue);
  const records = queue.discoveryTopics;
  let item, updated;
  const find = () => {
    const record = records.find(entry => entry.id === input.id);
    if (!record) bad('选题记录不存在', 404);
    updated = record;
    return record;
  };
  if ('placement' in input && input.placement !== 'history') bad('展示位置无效');
  if (input.action === 'config') configureDiscovery(queue, input.config);
  else if (input.action === 'preferences') {
    if (typeof input.notes !== 'string' || input.notes.length > 4000) bad('偏好说明最多 4000 字');
    queue.discoveryPreferences = { notes: input.notes.trim() };
  } else if (input.action === 'clear-feedback') {
    if (input.id && !records.some(record => record.id === input.id)) bad('选题记录不存在', 404);
    for (const record of records) {
      if (input.id && record.id !== input.id) continue;
      delete record.feedback;
      // 单条撤销兼容旧的 seen/dismissed；批量清反馈不让历史重新涌进候选。
      if (input.id && ['seen', 'dismissed'].includes(record.status)) {
        if (record.queueId || currentQueueItem(queue, record)) record.status = 'queued';
        else if (record.placement !== 'history') record.status = 'candidate';
      }
      if (input.id) updated = record;
    }
  } else if (input.action === 'adopt') {
    if (typeof input.replace !== 'boolean') bad('采用建议需明确是否替换原题');
    const record = find();
    if (!record.adoptedAt) {
      if (record.status !== 'suggestion' || !record.parentId) bad('这条记录不是待采用建议', 409);
      if (input.replace) {
        if (record.followup !== 'different') bad('深入子问题请另存为候选');
        const parent = records.find(entry => entry.id === record.parentId);
        if (!parent || !isCandidate(parent) || parent.queueId || parent.feedback || currentQueueItem(queue, parent)) {
          bad('原题已入队、反馈或不再是候选，请将建议另存为候选', 409);
        }
        parent.status = 'superseded'; parent.placement = 'history'; parent.replacedBy = record.id;
      }
      record.status = 'candidate'; record.adoptedAt = Date.now();
      delete record.placement;
    }
  } else if (input.action === 'dismiss-suggestion') {
    const record = find();
    if (record.status === 'suggestion') {
      record.status = 'archived'; record.placement = 'history'; record.archiveReason = 'dismissed-suggestion';
    } else if (record.status !== 'archived' || record.archiveReason !== 'dismissed-suggestion') bad('这条记录不是待处理建议', 409);
  } else if (input.action === 'archive') {
    const record = find();
    if (!isCandidate(record) && !(record.status === 'archived' && record.placement === 'history')) bad('只能收起候选', 409);
    record.status = 'archived'; record.placement = 'history'; record.archiveReason = 'user';
  } else if (input.action === 'restore') {
    const record = find();
    if (record.queueId || currentQueueItem(queue, record) || !['archived', 'superseded', 'candidate'].includes(record.status)) bad('这条记录不能恢复为候选', 409);
    record.status = 'candidate'; delete record.placement;
    // 不撤销替代建议、不级联改动其他记录；replacedBy 保留历史关联。
  } else if (['accept', 'requeue', 'feedback'].includes(input.action)) {
    const record = find();
    if (input.action === 'accept' || input.action === 'requeue') {
      if (input.action === 'requeue' && !currentQueueItem(queue, record)) {
        if (!record.queueId || record.status === 'duplicate') bad('只有曾入队且已移除的选题可以重新入队', 409);
        delete record.queueId;
      }
      item = enqueueCandidate(queue, record, { root });
      record.feedback = { kind: 'interested', reason: '', note: '', at: Date.now() };
    } else {
      if (!['seen', 'not-interested'].includes(input.kind)) bad('反馈类型无效');
      record.feedback = { kind: input.kind, reason: text(input.reason, 100), note: text(input.note, 500), at: Date.now() };
      if (!record.queueId && !currentQueueItem(queue, record) && !['duplicate', 'archived', 'superseded', 'suggestion'].includes(record.status)) record.status = input.kind === 'seen' ? 'seen' : 'dismissed';
      if (input.placement === 'history') record.placement = 'history';
    }
  } else bad('未知的选题操作');
  bumpDiscoveryRevision(queue);
  writeSchedule(root, queue);
  return { ok: true, ...topicState(root, input.view && typeof input.view === 'object' ? input.view : {}),
    ...(updated ? { updated: topicRecordState(queue, updated, root) } : {}), ...(item ? { item } : {}) };
}

export function feedbackContext(queue) {
  return {
    notes: text(queue.discoveryPreferences?.notes, 4000),
    examples: topicHistory(queue).filter(item => item.feedback)
      .sort((a, b) => b.feedback.at - a.feedback.at).slice(0, 30)
      .map(item => ({ topic: item.topic, coreQuestion: item.coreQuestion, ...item.feedback })),
  };
}

/* 自动发现与定时制作独立；有待选候选时不反复烧搜索额度。 */
export function automaticDiscoveryReason(queue, now = Date.now(), job = null) {
  const config = discoverySettings(queue);
  if (config.enabled !== true) return 'disabled';
  if (job?.state === 'running') return 'running';
  if (queue.items.filter(item => !item.project).length > (config.keepFilled ?? 0)) return 'queue-filled';
  if (topicHistory(queue).some(item => isCandidate(item) && !item.feedback)) return 'awaiting-selection';
  const last = Math.max(Number(queue.discoveryLastAttemptAt) || 0, ...(queue.discovery || []).map(item => Number(item.at) || 0));
  const minutes = Math.max(5, Number(config.intervalMinutes) || 30);
  if (last && now - last < minutes * 60000) return 'cooldown';
  return null;
}
