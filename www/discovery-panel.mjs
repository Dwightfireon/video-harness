/* 单条建议、待选候选和历史各有自己的范围；搜索不会隐式替换或投票。 */
import { createDiscoveryAPI } from './discovery-api.mjs';
const STATUS = { candidate: '待选择', suggestion: '待确认建议', queued: '已加入队列', seen: '已经看过', dismissed: '不感兴趣', duplicate: '重复选题', archived: '已收起', superseded: '已采用其他角度' };
const FEEDBACK = { interested: '想做', seen: '已经看过', 'not-interested': '不感兴趣' };
const RESEARCH_STATUS = { unresearched: '尚未调查', leads: '已有研究线索 · 不代表已回答', insufficient: '材料不足 · 问题已保留', reframe: '建议调整问题 · 原题未改动' };
const HISTORY_KEYS = ['historyOffset', 'historyLimit', 'historyFilter', 'historyQuery'];

export function safeSourceURL(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(text).join(' · ');
  return value == null ? '' : String(value);
}

export function attachDiscoveryPanel(root, {
  request, api = createDiscoveryAPI(request), refreshQueue = async () => {},
  showQueue = () => {}, subscribeQueueChanges = () => () => {}, pollMs = 3000,
} = {}) {
  const $ = selector => root.querySelector(selector), doc = root.ownerDocument;
  const cards = new Map(), receipts = new Map(), dirty = new Set(), pending = new Set();
  let state = null, epoch = 0, historyEpoch = 0, jobEpoch = 0, job = null, jobBaselineKnown = false, submission = null, searching = false, polling = false, timer = null, disposed = false;
  let announceDone = false;
  let candidateOrder = [], view = { historyOffset: 0, historyLimit: 20, historyFilter: 'all', historyQuery: '' };
  const controls = { query: $('#discQuery'), mode: $('#discMode'), count: $('#discCount'), notes: $('#discNotes') };
  const node = (tag, className, content) => { const el = doc.createElement(tag); if (className) el.className = className; if (content != null) el.textContent = content; return el; };
  function button(label, handler, className = 'btn') { const el = node('button', className, label); el.type = 'button'; el.onclick = handler; return el; }
  function message(el, value, error = false) { if (typeof el === 'string') el = $(el); el.textContent = value; el.classList.toggle('error', error); }
  const isCandidate = item => item.status === 'candidate' && item.placement !== 'history';
  const inQueue = item => item.inQueue ?? (item.status === 'queued' && Boolean(item.queueId));
  const viewMatches = next => HISTORY_KEYS.filter(key => key !== 'historyOffset').every(key => next[key] == null || next[key] === view[key]);
  const canReplace = item => isCandidate(item) && !item.queueId && !item.feedback;
  const singleJob = value => value?.followupId && !(value.count > 1) && !(value.results?.length > 1);
  const researchJob = value => value?.operation === 'research' && value.topicId;
  const taskIdentity = value => {
    const identity = [value?.operation || 'questions', value?.topicId || null, value?.followupId || null, value?.followup || null];
    if (identity[0] === 'questions' && !value?.followupId) identity.push(value?.query || '', value?.mode || 'focused', value?.count || null);
    return JSON.stringify(identity);
  };
  function reconcile(host, elements) {
    const live = new Set(elements);
    for (const el of [...host.children]) if (!live.has(el)) el.remove();
    elements.forEach((el, i) => { if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null); });
  }
  function setBusy() {
    $('#discBtn').disabled = searching;
    $('#discBtn').textContent = searching && !singleJob(job) && !researchJob(job) ? (job?.mode === 'recent' ? '正在搜近期动态…' : '正在提出问题…') : '查找选题';
    for (const selector of ['#discConfigSave', '#discEnabled', '#discAutoQueue']) $(selector).disabled = pending.has('config');
    for (const selector of ['#discNotesSave', '#discNotesClear']) $(selector).disabled = pending.has('preferences');
    $('#discFeedbackClear').disabled = $('#discFeedbackConfirmYes').disabled = pending.size > 0;
    $('#discHistoryPrev').disabled = pending.size > 0 || !(state?.historyOffset > 0);
    $('#discHistoryNext').disabled = pending.size > 0 || state?.historyNextOffset == null;
    for (const record of cards.values()) {
      const item = record.item, busy = pending.has(item.id) || pending.has('clear-feedback');
      record.el.setAttribute('aria-busy', String(busy));
      for (const el of record.actions.querySelectorAll('button')) el.disabled = busy;
      record.submit.disabled = busy;
      const duplicate = item.status === 'duplicate', queued = inQueue(item);
      record.accept.disabled = busy || queued || duplicate;
      record.accept.textContent = queued ? '已入队' : item.queueState === 'removed' ? '重新入队' : duplicate ? '重复选题' : '加入队列';
      record.accept.setAttribute('aria-label', queued ? '已加入队列' : item.queueState === 'removed' ? '重新加入队列' : duplicate ? '重复候选不入队' : '想做并加入队列');
      if (item.question?.version === 1 && !queued && item.canEnqueue !== true) record.accept.disabled = true;
      const researching = searching && researchJob(job) && job.topicId === item.id;
      record.research.disabled = searching || busy;
      record.research.textContent = researching ? '正在调查此题…' : item.researchAssessment?.status === 'unresearched' || !item.researchAssessment ? '调查此题' : '继续调查';
      record.deeper.disabled = record.different.disabled = searching || busy;
      const local = searching && singleJob(job) && job.followupId === item.id;
      record.different.textContent = local && job.followup === 'different' ? '正在为此题换角度…' : '换角度';
      record.deeper.textContent = local && job.followup === 'deeper' ? '正在为此题找子题…' : '找一个子题';
    }
    for (const receipt of receipts.values()) for (const el of receipt.el.querySelectorAll('button')) el.disabled = pending.has(receipt.id) || pending.has('clear-feedback');
  }
  for (const [key, el] of Object.entries(controls)) el.oninput = () => dirty.add(key);
  function disclosure(toggle, panel, arrow) {
    $(toggle).onclick = () => {
      const expanded = $(toggle).getAttribute('aria-expanded') !== 'true';
      $(toggle).setAttribute('aria-expanded', String(expanded)); $(panel).hidden = !expanded;
      if (arrow) $(arrow).textContent = expanded ? '−' : '＋';
    };
  }
  disclosure('#discPreferencesToggle', '#discPreferencesEditor');
  disclosure('#discHistoryToggle', '#discHistoryBody', '#discHistoryArrow');

  function feedbackEditor(item, save) {
    const form = node('div', 'topic-feedback'); form.hidden = true;
    const reasonLabel = node('label', '', '原因（可选）'), reason = node('select');
    for (const value of ['', '已经了解这个问题', '最近看过类似内容', '题目太泛', '缺少新意', '太技术', '太像广告', '这个对象没兴趣', '资料或依据不足', '其他']) {
      const option = node('option', '', value || '不填写原因'); option.value = value; reason.append(option);
    }
    const noteLabel = node('label', '', '备注（可选）'), note = node('textarea'); note.maxLength = 500;
    note.placeholder = '补充原因，不会把一次反馈当成整个领域的黑名单';
    reasonLabel.append(reason); noteLabel.append(note);
    const submit = button('保存反馈说明', () => save(reason.value, note.value)), buttons = node('div', 'topic-buttons');
    buttons.append(submit, button('取消', () => { form.hidden = true; })); form.append(reasonLabel, noteLabel, buttons);
    function open(value = item.feedback) {
      if (form.hidden) { reason.value = value?.reason || ''; note.value = value?.note || ''; }
      form.hidden = false; note.focus();
    }
    return { form, reason, note, submit, open };
  }
  function createCard(item) {
    const el = node('article', 'discovery-topic'); el.dataset.topicId = item.id;
    const heading = node('h3'), summary = node('p', 'topic-summary'), audience = node('p', 'topic-audience'), evidenceMeta = node('p', 'topic-evidence-meta'), status = node('p', 'topic-state');
    const details = node('details', 'topic-explanation'), detailLabel = node('summary', '', '查看讲法与来源'), content = node('div');
    details.append(detailLabel, content);
    const feedback = node('p', 'topic-feedback-history'), actions = node('div', 'topic-buttons'), local = node('p', 'topic-local-message'); local.setAttribute('role', 'status');
    const suggestions = node('div', 'topic-suggestions'); suggestions.hidden = true;
    const record = { el, heading, summary, audience, evidenceMeta, status, details, detailLabel, content, feedback, actions, local, suggestions, item, signature: '' };
    const action = (body, success, opts = {}) => mutate(body, record.local, success, { record, ...opts });
    record.accept = button('想做并加入队列', () => action({ action: record.item.queueState === 'removed' ? 'requeue' : 'accept', id: item.id }, '已加入待做队列，尚未启动制作。', { queue: true, receipt: 'queued' }), 'btn primary');
    record.research = button('调查此题', () => discover(record, 'research'), 'btn primary');
    record.research.title = '只调查当前问题，检查前提、寻找依据与缺口；不会替换问题或自动入队';
    record.seen = button('已经看过', () => action({ action: 'feedback', id: item.id, kind: 'seen' }, '已记为已经看过，可撤销或补充原因。', { receipt: 'seen' }));
    record.dismiss = button('不感兴趣', () => action({ action: 'feedback', id: item.id, kind: 'not-interested' }, '已记录反馈，可撤销或补充原因。', { receipt: 'dismissed' }));
    record.deeper = button('找一个子题', () => discover(record, 'deeper'));
    record.different = button('换角度', () => discover(record, 'different'));
    record.different.title = '仅为这个选题找一个替代角度，确认采用后才替换原题';
    record.deeper.title = '仅沿这个选题找一个子题，不受顶部方向和每批数量影响';
    record.archive = button('先收起', () => action({ action: 'archive', id: item.id }, '已收进历史，不记作不感兴趣。', { receipt: 'archived' }));
    record.restore = button('放回候选', () => action({ action: 'restore', id: item.id }, '已放回候选，其他选题不变。'));
    record.undo = button('撤销此条反馈', () => action({ action: 'clear-feedback', id: item.id }, '此条反馈已撤销；已入队内容不变。'));
    const editor = feedbackEditor(item, async (reason, note) => {
      const kind = record.item.feedback?.kind;
      if (!['seen', 'not-interested'].includes(kind)) { editor.form.hidden = true; return; }
      if (await action({ action: 'feedback', id: item.id, kind, reason, note }, '反馈说明已保存。')) editor.form.hidden = true;
    });
    Object.assign(record, editor);
    record.edit = button('补充 / 修改原因', () => { record.details.open = true; editor.open(record.item.feedback); });
    const more = node('details', 'topic-more'), moreLabel = node('summary', '', '更多'), moreBody = node('div', 'topic-more-body');
    moreLabel.setAttribute('aria-label', '更多选题操作');
    moreBody.append(record.seen, record.dismiss, record.deeper, record.archive, record.restore, record.edit, record.undo);
    more.append(moreLabel, moreBody); record.more = more;
    more.onkeydown = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (record.el.classList.contains('is-history')) { record.details.open = false; record.detailLabel.focus(); }
      else { more.open = false; moreLabel.focus(); }
    };
    more.addEventListener('focusout', event => {
      // focusout 时 activeElement 可能暂时是 body；必须用目标焦点，避免吞掉菜单按钮的 click。
      if (event.relatedTarget && !record.el.classList.contains('is-history') && !more.contains(event.relatedTarget)) more.open = false;
    });
    actions.append(record.research, record.accept, record.different, more);
    el.append(heading, summary, audience, evidenceMeta, status, details, feedback, actions, editor.form, local, suggestions);
    return record;
  }
  function updateCard(record, item, history = false) {
    const wasHistory = record.el.classList.contains('is-history');
    record.item = item; record.el.classList.toggle('is-history', history);
    record.el.dataset.topicStatus = item.status;
    record.more.hidden = false;
    if (history) record.more.open = true;
    else if (wasHistory) record.more.open = false;
    const research = item.research?.version === 1 ? item.research : null;
    const question = item.question?.version === 1 ? item.question : null;
    const assessment = item.researchAssessment?.version === 1 ? item.researchAssessment : null;
    const evidence = (Array.isArray(research?.sources) ? research.sources : []).filter(source => safeSourceURL(source?.url));
    const mainSource = evidence.find(source => research.kind === 'news' ? source.eventDate : source.publishedAt) || evidence[0];
    const sourceDate = mainSource && (research.kind === 'news' ? mainSource.eventDate : mainSource.publishedAt);
    record.heading.textContent = item.topic || item.coreQuestion || '选题';
    record.summary.textContent = question ? question.value || item.why || '' : research?.selectionReason || item.why || '';
    record.audience.textContent = question?.audience ? '对谁有用：' + question.audience : ''; record.audience.hidden = !question?.audience;
    const sourceMeta = mainSource ? [research.kind === 'news' ? '新闻进展' : '研究材料', new URL(mainSource.url).hostname,
      sourceDate ? `${research.kind === 'news' ? '事件' : '发表'} ${sourceDate}` : '发表日期未确认'].join(' · ') : '';
    record.evidenceMeta.textContent = question ? [RESEARCH_STATUS[assessment?.status] || RESEARCH_STATUS.unresearched, sourceMeta].filter(Boolean).join('\n') : sourceMeta || '旧推荐 · 未记录原文依据';
    record.detailLabel.textContent = history ? '查看原题说明与来源' : question ? '查看调查方向与依据' : '查看讲法与来源';
    const signature = JSON.stringify([item.coreQuestion, item.subject, item.outline, item.difference, item.angle, item.sources, item.query, item.at, item.research, item.why, item.question, item.researchAssessment]);
    if (signature !== record.signature) {
      record.signature = signature;
      const meta = node('p', 'topic-meta', [item.query && '探索方向：' + item.query, item.at && new Date(item.at).toLocaleString('zh-CN')].filter(Boolean).join(' · '));
      const dl = node('dl');
      for (const [label, value] of [['对象', item.subject], ['具体问题', item.coreQuestion], ['为什么问', question?.value], ['对谁有用', question?.audience], ['调查方向', question?.investigate], ['待查前提', question?.premises], ['看点', !question && research?.selectionReason ? item.why : ''], ['讲法', item.outline], ['区别', item.difference], ['角度', item.angle], ['调查发现', assessment?.finding], ['尚缺什么', assessment?.gaps], ['建议问法（尚未采用）', assessment?.suggestedQuestion]]) {
        if (!text(value)) continue;
        dl.append(node('dt', '', label));
        if (Array.isArray(value)) {
          const items = value.map(text).filter(Boolean);
          if (!items.length) continue;
          const dd = node('dd');
          const ul = node('ul', 'topic-dl-list');
          for (const entryText of items) ul.append(node('li', '', entryText));
          dd.append(ul);
          dl.append(dd);
        } else {
          dl.append(node('dd', '', text(value)));
        }
      }
      const material = node('div', 'topic-evidence');
      if (evidence.length) {
        material.append(node('p', 'topic-meta', '程序已匹配工具返回正文中的摘录与日期，不等于独立事实核证；来源类型及支持关系仍是模型判断。'));
        for (const source of evidence) {
          const entry = node('section', 'topic-evidence-source');
          entry.append(node('h4', '', source.title || new URL(source.url).hostname), node('p', 'topic-meta', [
            ({ primary: '一手材料', reporting: '独立报道', analysis: '分析文章' }[source.sourceType] || '来源类型未确认'),
            '发表：' + (source.publishedAt || '未确认'), source.eventDate && '事件：' + source.eventDate,
          ].filter(Boolean).join(' · ')), node('p', 'topic-evidence-supports', '要点：' + (source.supports || '待核对')), node('blockquote', '', source.quote || ''));
          if (source.publicationQuote) entry.append(node('p', 'topic-meta', '发表日期原句：' + source.publicationQuote));
          if (source.eventQuote) entry.append(node('p', 'topic-meta', '事件日期原句：' + source.eventQuote));
          material.append(entry);
        }
        if (Array.isArray(research.caveats) && research.caveats.length) material.append(node('p', 'topic-meta', '材料限定：' + research.caveats.join('；')));
        if (research.recordPath) material.append(node('p', 'topic-meta', '检索记录：' + research.recordPath));
      }
      const sources = node('div', 'topic-sources');
      for (const value of item.sources || []) { const url = safeSourceURL(value); if (!url) continue; const link = node('a', '', new URL(url).hostname + ' ↗'); Object.assign(link, { href: url, target: '_blank', rel: 'noopener noreferrer', title: url }); sources.append(link); }
      if (!sources.childElementCount) sources.textContent = question ? '尚未取得可匹配原文的来源；问题可以先保留，不代表前提或结论已成立。' : '旧记录没有保存来源，不补造出处';
      record.content.replaceChildren(meta, dl, material, sources);
    }
    record.status.textContent = item.queueState === 'removed' ? '曾加入队列 · 目前已移出' : item.queueState === 'legacy' ? '历史制作记录' : STATUS[item.status] || '待选择';
    const f = item.feedback;
    record.feedback.textContent = f ? ['反馈：' + (FEEDBACK[f.kind] || f.kind), f.reason, f.note].filter(Boolean).join(' · ') : '';
    record.feedback.hidden = !f;
    record.undo.hidden = !f; record.edit.hidden = !f || f.kind === 'interested';
    record.different.hidden = record.deeper.hidden = false;
    record.restore.hidden = !['archived', 'superseded'].includes(item.status) || Boolean(item.queueId);
    record.archive.hidden = !isCandidate(item);
    const needsEvidence = Boolean(question && !inQueue(item) && item.canEnqueue !== true);
    record.accept.hidden = ['superseded', 'archived', 'suggestion'].includes(item.status);
    record.accept.title = needsEvidence ? '先调查此题；有符合要求的原文依据后才能加入队列' : '';
    if (needsEvidence && !record.accept.hidden) record.evidenceMeta.textContent += '\n有符合要求的原文依据后，才能加入队列。';
    record.research.hidden = !question || item.status === 'suggestion' || inQueue(item) || item.status === 'duplicate';
    record.research.classList.toggle('primary', item.canEnqueue !== true);
    record.seen.hidden = f?.kind === 'seen'; record.dismiss.hidden = f?.kind === 'not-interested';
    const host = history ? record.details : record.el;
    if (record.actions.parentNode !== host) {
      if (history) host.append(record.actions, record.form);
      else { host.insertBefore(record.actions, record.local); host.insertBefore(record.form, record.local); }
    }
  }
  function createReceipt(record, kind) {
    let receipt = receipts.get(record.item.id);
    if (receipt) return receipt;
    const id = record.item.id, el = node('div', 'topic-receipt'); el.dataset.receiptId = id;
    const caption = node('p'), buttons = node('div', 'topic-buttons');
    const undo = button('撤销', () => mutate({ action: receipt.kind === 'archived' ? 'restore' : 'clear-feedback', id }, receipt.local, '已撤销本次操作。', { record }));
    const queueLink = button('查看待做队列', showQueue);
    buttons.append(undo, queueLink);
    const editor = feedbackEditor(record.item, async (reason, note) => {
      const currentKind = record.item.feedback?.kind;
      if (!['seen', 'not-interested'].includes(currentKind)) { editor.form.hidden = true; return; }
      if (await mutate({ action: 'feedback', id, kind: currentKind, reason, note }, receipt.local, '反馈说明已保存。', { record })) editor.form.hidden = true;
    });
    const edit = button('补充原因', () => editor.open(record.item.feedback)); buttons.append(edit);
    buttons.append(button('收起提示', () => { receipts.delete(id); candidateOrder = candidateOrder.filter(key => key !== id); paint(state); }));
    const local = node('p', 'topic-local-message'); local.setAttribute('role', 'status');
    el.append(caption, buttons, editor.form, local); receipt = { id, el, local, caption, undo, queueLink, edit, kind, ...editor }; receipts.set(id, receipt); return receipt;
  }
  function updateReceipt(receipt, item) {
    const kind = item.queueId || inQueue(item) ? 'queued' : item.feedback?.kind === 'seen' ? 'seen' : item.feedback?.kind === 'not-interested' ? 'dismissed' : ['archived', 'superseded'].includes(item.status) ? 'archived' : null;
    if (!kind || isCandidate(item)) { receipts.delete(item.id); return; }
    if (kind !== receipt.kind) receipt.form.hidden = true;
    receipt.kind = kind;
    const label = kind === 'queued' ? item.queueState === 'removed' ? '曾加入队列，目前已移出' : '已加入待做队列' : { seen: '已记为已经看过', dismissed: '已记为不感兴趣', archived: '已收进历史' }[kind];
    receipt.caption.textContent = `「${item.topic}」${label}。`;
    receipt.undo.hidden = kind === 'queued'; receipt.queueLink.hidden = kind !== 'queued';
    receipt.edit.hidden = !['seen', 'dismissed'].includes(kind);
  }
  function suggestionCard(item) {
    let record = cards.get(item.id);
    if (!record) { record = createCard(item); cards.set(item.id, record); }
    updateCard(record, item); record.el.classList.add('topic-suggestion');
    if (!record.suggestionLabel) {
      record.suggestionLabel = node('p', 'topic-suggestion-label'); record.el.prepend(record.suggestionLabel);
      record.adopt = button('采用这个角度', () => mutate({ action: 'adopt', id: item.id, replace: true }, record.local, '已只替换原题，其他候选不变。', { record }), 'btn primary');
      record.promote = button('另存为候选', () => mutate({ action: 'adopt', id: item.id, replace: false }, record.local, '已另存为候选，原题不变。', { record }));
      record.discard = button('不用这个建议', () => mutate({ action: 'dismiss-suggestion', id: item.id }, record.local, '建议已收起，未记录负反馈。', { record }));
      record.actions.append(record.adopt, record.promote, record.discard);
    }
    for (const el of [record.research, record.accept, record.seen, record.dismiss, record.different, record.deeper, record.archive, record.restore, record.edit, record.undo]) el.hidden = true;
    record.more.hidden = true;
    const parent = cards.get(item.parentId)?.item;
    record.suggestionLabel.textContent = `${item.followup === 'deeper' ? '子题建议' : '替代角度'} · 原题：${parent?.topic || '来自历史选题'}（尚未采用）`;
    record.suggestionLabel.hidden = record.promote.hidden = record.discard.hidden = false;
    record.adopt.hidden = item.followup !== 'different' || !parent || !canReplace(parent);
    return record.el;
  }
  function paint(next) {
    if (disposed || state?.revision != null && next.revision != null && next.revision < state.revision) return false;
    if (state && !viewMatches(next)) next = { ...next, ...Object.fromEntries([...HISTORY_KEYS, 'history', 'historyTotal', 'historyNextOffset'].map(key => [key, state[key]])) };
    else if (next.historyOffset != null) view = { ...view, historyOffset: next.historyOffset };
    state = next;
    const config = next.config || {};
    for (const [key, value] of Object.entries({ query: config.query || '', mode: ['focused', 'explore', 'recent'].includes(config.mode) ? config.mode : 'focused', count: config.count || 3, notes: next.preferences?.notes || '' })) if (!dirty.has(key)) controls[key].value = value;
    if (!pending.has('config')) { $('#discEnabled').checked = Boolean(config.enabled); $('#discAutoQueue').checked = config.autoQueue === true; }
    const topics = next.topics || [], candidates = next.candidates || topics.filter(isCandidate), suggestions = next.suggestions || topics.filter(item => item.status === 'suggestion');
    const history = next.history || topics.filter(item => !isCandidate(item) && item.status !== 'suggestion');
    const live = new Map([...topics, ...candidates, ...history, ...suggestions].map(item => [item.id, item]));
    if (next.updated) live.set(next.updated.id, next.updated);
    for (const item of live.values()) {
      let record = cards.get(item.id); if (!record) { record = createCard(item); cards.set(item.id, record); }
      updateCard(record, item, !isCandidate(item) && item.status !== 'suggestion');
      record.el.classList.toggle('topic-suggestion', item.status === 'suggestion');
      if (record.suggestionLabel && item.status !== 'suggestion') { record.suggestionLabel.hidden = true; for (const el of [record.adopt, record.promote, record.discard]) el.hidden = true; }
      if (receipts.has(item.id)) updateReceipt(receipts.get(item.id), item);
    }
    const ids = new Set(candidates.map(item => item.id)), replacements = new Map(candidates.filter(item => item.parentId).map(item => [item.parentId, item.id]));
    const order = candidateOrder.map(id => ids.has(id) || receipts.has(id) || pending.has(id) ? id : replacements.get(id)).filter(Boolean);
    const extras = candidates.map(item => item.id).filter(id => !order.includes(id));
    candidateOrder = [...extras, ...order];
    reconcile($('#discCandidates'), candidateOrder.map(id => ids.has(id) ? cards.get(id).el : receipts.get(id)?.el || (pending.has(id) ? cards.get(id)?.el : null)).filter(Boolean));
    reconcile($('#discHistoryList'), history.filter(item => !pending.has(item.id) || !candidateOrder.includes(item.id) || receipts.has(item.id)).map(item => cards.get(item.id).el));
    const byParent = new Map();
    for (const item of suggestions) { if (!byParent.has(item.parentId)) byParent.set(item.parentId, []); byParent.get(item.parentId).push(suggestionCard(item)); }
    const detached = [];
    for (const record of cards.values()) {
      const children = byParent.get(record.item.id) || [];
      const visibleParent = ids.has(record.item.id) || history.some(item => item.id === record.item.id);
      reconcile(record.suggestions, visibleParent ? children : []); record.suggestions.hidden = !visibleParent || !children.length;
      if (!visibleParent && children.length) detached.push(...children);
    }
    for (const [id, children] of byParent) if (!cards.has(id)) detached.push(...children);
    reconcile($('#discSuggestionList'), detached); $('#discDetachedSuggestions').hidden = !detached.length;
    $('#discTopicCount').textContent = candidates.length + ' 个待选择';
    $('#discHistoryCount').textContent = '（' + (next.historyTotal ?? history.length) + '）';
    $('#discFeedbackCount').textContent = '· ' + (next.feedbackCount || 0) + ' 条反馈';
    $('#discEmpty').hidden = candidates.length > 0 || receipts.size > 0;
    $('#discEmpty').textContent = '暂无待选择候选。可以查找新候选，或从历史中放回。';
    const offset = next.historyOffset || 0, total = next.historyTotal ?? history.length;
    $('#discHistoryPageStatus').textContent = total ? `第 ${offset + 1}–${offset + history.length} 条，共 ${total} 条` : '没有符合条件的历史记录';
    setBusy(); return true;
  }

  async function loadTopics() {
    const token = ++epoch;
    const next = await api.topics(view);
    if (token === epoch) paint(next);
    return next;
  }
  async function mutate(body, target, success, { record, queue = false, receipt, saved = {} } = {}) {
    const key = body.id || (body.action === 'preferences' ? 'preferences' : body.action === 'config' ? 'config' : 'clear-feedback');
    if (pending.has(key) || pending.has('clear-feedback')) return false;
    const active = doc.activeElement, focused = record?.el.contains(active) || receipts.get(body.id)?.el.contains(active);
    const wasCandidate = record && isCandidate(record.item);
    let succeeded = false;
    pending.add(key); ++epoch; setBusy(); message(target, '正在保存…');
    try {
      const next = await api.update(body, view);
      if (disposed) return false;
      for (const [name, value] of Object.entries(saved)) if (controls[name].value === value) dirty.delete(name);
      if (receipt && wasCandidate) createReceipt(record, receipt);
      if (body.action === 'clear-feedback' && !body.id) receipts.clear();
      if (!paint(next) && state) paint(state); // 迟到回执仍须显示本条操作的确认，不应用旧数据。
      if (record && !record.el.classList.contains('is-history')) record.more.open = false;
      message(target, success); message('#discActionMsg', success);
      if (!searching && ['adopt', 'dismiss-suggestion'].includes(body.action) && job?.results?.some(item => item.id === body.id)) message('#discMsg', '本次单条建议已处理；其他候选不变。');
      if (queue) { try { await refreshQueue(); } catch (error) { message(target, '入队已保存，但队列显示刷新失败：' + error.message, true); } }
      succeeded = true;
      return true;
    } catch (error) {
      message(target, '操作失败：' + error.message, true);
      if (key === 'config' && state) { $('#discEnabled').checked = Boolean(state.config?.enabled); $('#discAutoQueue').checked = state.config?.autoQueue === true; }
      return false;
    } finally {
      pending.delete(key); setBusy();
      if (succeeded && focused && !disposed && (doc.activeElement === active || doc.activeElement === doc.body)) {
        const host = receipts.get(body.id)?.el || (record?.item.status === 'archived' && body.action === 'dismiss-suggestion' ? cards.get(record.item.parentId)?.el : record?.el);
        [...(host?.querySelectorAll('button,summary,a[href]') || [])].find(el => !el.disabled && el.getClientRects().length)?.focus({ preventScroll: true });
      }
    }
  }
  function schedulePoll() { clearTimeout(timer); if (!disposed) timer = setTimeout(() => poll(), pollMs); }
  function paintJob(data, acknowledged = false) {
    if (submission && !acknowledged) {
      // POST 尚未回包时，旧任务的终态不能解除当前请求的忙碌态。
      // 轮询读到身份匹配的新作业则可接管，避免迟到 POST 一直锁住已完成的任务。
      const incoming = data.job;
      if (!submission.baselineKnown || !incoming?.id || incoming.id === submission.previousId || taskIdentity(incoming) !== taskIdentity(submission.body)) return;
      submission = null;
    } else if (acknowledged) submission = null;
    jobBaselineKnown = true;
    job = data.job || null; searching = data.view?.state === 'running'; setBusy();
    const investigating = researchJob(job), single = singleJob(job), target = investigating ? cards.get(job.topicId) : single && cards.get(job.followupId), action = investigating ? '调查问题' : job?.followup === 'deeper' ? '找子题' : '换角度';
    if (searching) {
      announceDone = true;
      message('#discMsg', target ? `正在为「${target.item.topic}」${action}，其他候选保持不变。` : data.view?.text || '正在查找新候选…');
      if (target) message(target.local, investigating ? '正在检查问题前提、寻找依据和缺口；原题与已有材料保留，不自动入队。' : `正在为这一题${action}，建议会显示在这里；原题暂不改变。`);
    } else if (data.view?.state === 'failed') {
      const error = (investigating ? '调查失败：' : '查找失败：') + (data.view.text || job?.reason || '未知原因') + '。原题、已有材料和其他候选均保留。';
      // 失败常常是搜索服务不可用；把可操作的下一步一起写出来，不留一句“失败”就结束。
      const hints = Array.isArray(data.view?.hints) ? data.view.hints : Array.isArray(job?.hints) ? job.hints : [];
      message('#discMsg', error + (hints.length ? '\n可以这样处理：' + hints.map(item => '· ' + item).join(' ') : ''), true);
      if (target) message(target.local, error, true);
    } else if (data.view?.state === 'done') {
      if (!announceDone) { message('#discMsg', ''); return; }
      const count = Array.isArray(job?.results) ? job.results.length : null;
      const processed = single && count && job.results.every(item => cards.has(item.id) && cards.get(item.id).item.status !== 'suggestion');
      let value = investigating ? '本题调查已结束，请查看卡片中的调查发现、材料与缺口；原题未改动，本次调查不会自动入队。' : job?.followupId && !single ? '旧版换角度产生的候选已保留；新的「换角度」只生成单条待确认建议。' : single ? processed ? '本次单条建议已处理；其他候选不变。' : count ? '已找到单条建议，请在原题下确认是否采用；其他候选未变。' : '这次没有合适的替代建议，原题保留。' : count == null ? '查找完成，候选与历史已更新。' : count ? `本次新增 ${count} 个问题候选，已有候选保留；可选择感兴趣的问题继续调查，尚未启动制作。` : job?.skipped > 0 && !job?.materialRejected ? `本次生成了 ${job.candidates || job.skipped} 条候选，但均与已有候选或历史重复，已自动跳过；可换个更具体的方向再试。` : job?.mode === 'recent' ? `本次轻联网执行了 ${job.searchCount || 0} 次搜索，但未筛出不重复的新候选；建议换更具体的产品、公司或事件关键词再试。` : '本次没有新增候选，已有内容保留。';
      if (!investigating && !count && job?.materialRejected > 0) value += ` ${job.materialRejected} 条材料因原文、日期或讲述依据不足未推荐，不凑数。`;
      message('#discMsg', value); if (target) message(target.local, value);
    }
  }
  async function poll() {
    if (disposed) return;
    if (polling) { schedulePoll(); return; }
    polling = true; const token = jobEpoch; let retry = false;
    try {
      const data = await api.job();
      if (token !== jobEpoch || disposed) return;
      paintJob(data);
      if (!searching) {
        try { await loadTopics(); } catch (error) { message('#discActionMsg', '候选读取失败：' + error.message + '。保留上次结果，将重试读取。', true); retry = true; }
        try { await refreshQueue(); } catch (error) { message('#discActionMsg', '队列刷新失败：' + error.message, true); }
      }
    } catch (error) { if (token === jobEpoch) { message('#discMsg', '检索状态读取失败：' + error.message + '。仅重连读取，不重新提交。', true); retry = true; } }
    finally { polling = false; if (searching || retry) schedulePoll(); }
  }
  async function discover(record, followup) {
    if (searching) return;
    const count = Number(controls.count.value);
    if (!record && (!Number.isInteger(count) || count < 1 || count > 10)) { message('#discMsg', '每批数量请填 1–10 的整数。', true); return; }
    const investigating = followup === 'research';
    const body = investigating ? { operation: 'research', topicId: record.item.id } : record ? { followupId: record.item.id, followup } : { query: controls.query.value.trim(), mode: controls.mode.value, count };
    const requestState = { previousId: job?.id || null, baselineKnown: jobBaselineKnown, body };
    submission = requestState;
    const token = ++jobEpoch; clearTimeout(timer); searching = true;
    announceDone = true;
    job = investigating ? { operation: 'research', topicId: record.item.id } : record ? { followupId: record.item.id, followup } : { operation: 'questions', mode: controls.mode.value }; setBusy();
    const target = record?.local || $('#discMsg'); message(target, record ? '正在为这一条提交请求，其他候选不变…' : '正在提交新一批候选查找…');
    try {
      const data = await api.search(body);
      if (disposed || token !== jobEpoch) return;
      if (submission !== requestState) { schedulePoll(); return; } // 已由轮询确认的新作业，不被迟到 POST 倒退。
      ++jobEpoch; // POST 确认之前启动的 GET 不能随后覆盖新作业。
      paintJob(data, true); schedulePoll();
    }
    catch (error) {
      if (disposed || token !== jobEpoch) return;
      if (submission !== requestState) { schedulePoll(); return; }
      submission = null;
      message(target, '提交未确认：' + error.message + '。正在核对已有任务，不会自动重新提交。', true);
      // HTTP 409/断连都只读取后台状态，避免把另一个任务误认为本次请求，或重复付费。
      await poll();
      if (!disposed && token === jobEpoch && job && ((job.followupId || null) !== (body.followupId || null) || (job.followup || null) !== (body.followup || null) || (job.operation || 'questions') !== (body.operation || 'questions') || (job.topicId || null) !== (body.topicId || null))) message(target, '本次请求未确认，后台已有另一项查找；正在显示已有任务，不会重复提交。请等它结束后再试。', true);
    }
  }
  $('#discBtn').onclick = () => discover();
  $('#discRefresh').onclick = async () => { try { await loadTopics(); await poll(); } catch (error) { message('#discActionMsg', '读取候选失败：' + error.message, true); } };
  $('#discConfigSave').onclick = () => {
    const count = Number(controls.count.value); if (!Number.isInteger(count) || count < 1 || count > 10) { message('#discConfigMsg', '每批数量请填 1–10 的整数。', true); return; }
    const saved = { query: controls.query.value, count: controls.count.value, mode: controls.mode.value };
    mutate({ action: 'config', config: { query: saved.query.trim(), count, mode: saved.mode } }, '#discConfigMsg', '查找设置已保存，自动发现将使用这些设置。', { saved });
  };
  for (const [selector, name] of [['#discEnabled', 'enabled'], ['#discAutoQueue', 'autoQueue']]) $(selector).onchange = () => mutate({ action: 'config', config: { [name]: $(selector).checked } }, '#discConfigMsg', name === 'enabled' ? '自动发现设置已保存，定时制作和发布未改变。' : '自动入队设置已保存，只影响自动发现。');
  $('#discNotesSave').onclick = () => mutate({ action: 'preferences', notes: controls.notes.value }, '#discPreferencesMsg', '个人偏好已保存。', { saved: { notes: controls.notes.value } });
  $('#discNotesClear').onclick = () => mutate({ action: 'preferences', notes: '' }, '#discPreferencesMsg', '已清空个人偏好，反馈历史不变。', { saved: { notes: controls.notes.value } });
  $('#discFeedbackClear').onclick = () => { $('#discFeedbackConfirm').hidden = false; };
  $('#discFeedbackConfirmNo').onclick = () => { $('#discFeedbackConfirm').hidden = true; };
  $('#discFeedbackConfirmYes').onclick = async () => { if (await mutate({ action: 'clear-feedback' }, '#discPreferencesMsg', '全部反馈已清空，选题位置和队列保持不变。')) $('#discFeedbackConfirm').hidden = true; };
  async function changeHistory(patch) {
    if (pending.size) return;
    const token = ++historyEpoch;
    const previous = view; view = { ...view, ...patch }; message('#discHistoryMsg', '正在读取历史…');
    try { await loadTopics(); if (token === historyEpoch) message('#discHistoryMsg', ''); }
    catch (error) { if (token === historyEpoch) { view = previous; message('#discHistoryMsg', '历史读取失败：' + error.message + '。保留上次列表。', true); } }
  }
  $('#discHistorySearchForm').onsubmit = event => { event.preventDefault(); changeHistory({ historyOffset: 0, historyFilter: $('#discHistoryFilter').value, historyQuery: $('#discHistoryQuery').value.trim() }); };
  $('#discHistoryFilter').onchange = () => changeHistory({ historyOffset: 0, historyFilter: $('#discHistoryFilter').value, historyQuery: $('#discHistoryQuery').value.trim() });
  $('#discHistoryPrev').onclick = () => changeHistory({ historyOffset: Math.max(0, view.historyOffset - view.historyLimit) });
  $('#discHistoryNext').onclick = () => { if (state?.historyNextOffset != null) changeHistory({ historyOffset: state.historyNextOffset }); };
  const ready = loadTopics().catch(error => message('#discActionMsg', '读取候选失败：' + error.message, true));
  ready.then(() => poll());
  const unsubscribe = subscribeQueueChanges(() => {
    loadTopics().catch(error => message('#discActionMsg', '队列已更新，但历史读取失败：' + error.message + '。请刷新候选与历史。', true));
  });
  return { ready, refresh: loadTopics, poll, dispose() { disposed = true; submission = null; ++epoch; ++jobEpoch; clearTimeout(timer); unsubscribe(); } };
}
