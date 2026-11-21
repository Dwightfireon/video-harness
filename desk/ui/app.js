/* 渲染层：只管界面与调用顺序，投稿判断都在主进程/模块里。 */
import { validateInput } from '../publish-contract.mjs';
import { offlinePartitions, searchPartitions, partitionLabel, partitionAdvice, validateSelection, AI_CHANNEL_URL,
  HUMAN_PARTITION_TAXONOMY, HUMAN_COMPAT_TID } from '../partitions.mjs';
const $ = selector => document.querySelector(selector);

/* 点封面缩略图放大：发布台没有独立的图片查看器，用一个覆盖层就地展示，
 * 再点一次关闭。避免为了看一眼封面去打开系统看图工具。 */
function toggleCoverZoom(src) {
  let layer = $('#coverZoom');
  if (layer) { layer.remove(); return; }
  layer = document.createElement('div');
  layer.id = 'coverZoom';
  layer.className = 'cover-zoom';
  const img = document.createElement('img');
  img.src = src;
  img.alt = '封面大图';
  layer.appendChild(img);
  layer.addEventListener('click', () => layer.remove());
  document.body.appendChild(layer);
}
const state = {
  projects: [], current: null, draft: null, partitions: [], partitionsLive: false,
  account: null, ready: null, busy: false, plan: null, steps: [], qrTimer: null, result: null,
  partitionCatalog: offlinePartitions(),
  /* 批量发布：selected 是勾选顺序（用户可调），batch 是最近一次的结果。 */
  selected: [], batch: null, batching: false,
};

const fmtBytes = n => !Number.isFinite(n) || n <= 0 ? '—' : n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
const fmtSec = s => !Number.isFinite(s) ? '' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const fmtTime = ms => {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  if (min < 1440) return Math.round(min / 60) + ' 小时前';
  return new Date(ms).toLocaleDateString('zh-CN');
};

function setTab(name) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('on', tab.dataset.tab === name);
  for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('on', pane.id === 'pane-' + name);
}

function setBusy(busy) {
  state.busy = busy;
  const blockers = state.draft && !busy ? submitBlockers() : [];
  $('#btnPlan').disabled = busy || !state.draft;
  $('#btnSubmit').disabled = busy || !state.draft || blockers.length > 0;
  $('#submitBlockers').textContent = busy ? '正在处理，请稍候。' : !state.draft ? '先选择项目。'
    : blockers.length ? '还不能提交：' + blockers.join('；') : '本地表单条件已满足；正式投稿仍会重新核验分区与媒体。';
  $('#refresh').disabled = busy;
  $('#btnAccount').disabled = busy;
  for (const id of ['#fTitle', '#pTitle', '#fPartition', '#fPartitionSearch', '#btnReloadPartitions', '#fTags', '#fDesc', '#fCover', '#fReprint', '#fCopyright', '#fSource', '#fDynamic']) $(id).disabled = busy;
  $('#fCover').disabled = busy || !state.draft?.cover?.ok;
}

/* 提交前必须明确的项。分区没选就不让点，避免“点了没反应”或“投错分区”。 */
function submitBlockers() {
  const form = readForm();
  const blockers = [...validateInput(form, state.draft), ...validateSelection(form, state.partitionCatalog)];
  if (!state.account?.loggedIn) blockers.push('还没有登录');
  else if (!state.ready) blockers.push('正在核对投稿体检结果');
  else if (!state.ready.ok) blockers.push('投稿体检未通过');
  return [...new Set(blockers)];
}
function accountLabel() {
  const account = state.account;
  if (!account?.loggedIn) return account?.expired ? '登录已过期，点此重登' : '未登录，点此扫码';
  const warn = state.ready && !state.ready.ok ? ' · 投稿受限' : '';
  return '已登录：' + (account.name || 'B 站账号') + (account.level ? '（LV' + account.level + '）' : '') + warn;
}

function paintAccount() {
  const btn = $('#btnAccount');
  btn.textContent = accountLabel();
  btn.style.borderColor = state.account?.loggedIn ? 'var(--accent2)' : 'var(--warn)';
  btn.style.color = state.account?.loggedIn ? 'var(--ok)' : 'var(--warn)';
  paintBatch();
}

function renderProjects() {
  const box = $('#projects');
  box.innerHTML = '';
  if (!state.projects.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '还没有作品。请先在映序创作空间中创建视频。';
    box.appendChild(empty);
    return;
  }
  for (const project of state.projects) {
    const row = document.createElement('div');
    row.className = 'row project-row';

    // 勾选框只表示"进入批量队列"，不改当前选中的项目。
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pick';
    check.title = '加入批量发布队列';
    check.checked = state.selected.includes(project.id);
    check.disabled = state.batching;
    check.onchange = () => {
      state.selected = check.checked
        ? [...state.selected.filter(id => id !== project.id), project.id]
        : state.selected.filter(id => id !== project.id);
      paintBatch();
    };

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item' + (state.current === project.id ? ' on' : '');
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = project.title || project.hint || project.id;
    const meta = document.createElement('span');
    meta.className = 'm';
    // 没有文案时用脚本线索当主标题，把目录名降到副行，否则认不出是哪个视频。
    const bits = [project.title || project.hint ? project.id : null,
      project.hasCopy ? '有文案' : '无文案', project.video ? '有视频' : '无视频', fmtTime(project.updatedAt)].filter(Boolean);
    meta.textContent = bits.join(' · ');
    btn.append(title, meta);
    btn.onclick = () => { if (!state.busy && !state.batching) loadDraft(project.id); };

    row.append(check, btn);
    box.appendChild(row);
  }
  paintBatch();
}

/* ---------- 批量发布 ---------- */
function paintBatch() {
  const count = $('#batchCount');
  const button = $('#btnBatch');
  if (!count || !button) return;
  const n = state.selected.length;
  count.textContent = n ? `已选 ${n}` : '未选择';
  count.className = 'pill ' + (n ? 'ok' : '');
  button.disabled = !n || state.batching || !state.account?.loggedIn;
  button.textContent = state.batching ? '发布中…' : '发布所选作品';
  $('#btnBatchCancel').hidden = !state.batching;
  $('#batchInterval').disabled = state.batching;
  const list = $('#batchSteps');
  if (!list) return;
  list.innerHTML = '';
  for (const item of state.batch?.results || []) {
    const li = document.createElement('li');
    li.className = item.ok ? 'done' : 'failed';
    li.textContent = `${item.index}/${item.total} ${item.id}` + (item.ok ? ' · BV ' + (item.bvid || '—') : ' · ' + (item.message || item.outcome));
    list.appendChild(li);
  }
  if (state.batch && !state.batching) {
    const li = document.createElement('li');
    li.className = state.batch.ok ? 'done' : 'failed';
    li.textContent = state.batch.ok
      ? `全部 ${state.batch.results.length} 支已提交`
      : `已停止：${state.batch.results.filter(r => !r.ok).length} 支失败，其余未提交`;
    list.appendChild(li);
  }
}

async function submitBatch() {
  if (!state.account?.loggedIn) { openLogin(); return; }
  if (!state.selected.length) return;
  // 批量发布沿用当前表单的分区：它必须先选好，否则每条都要重新问。
  const form = readForm();
  if (!form.partitionTaxonomy || !(form.humanType2 || form.tid)) {
    toastError('先在左边选好投稿分区，再批量发布'); return;
  }
  const interval = Number($('#batchInterval').value) || 3;
  const confirmed = window.confirm(
    `确认自动发布 ${state.selected.length} 支视频？\n\n顺序：${state.selected.join('、')}\n间隔：${interval} 秒\n分区：${$('#fPartition').selectedOptions[0]?.textContent || '未选'}\n\n` +
    '任何一条失败会立即停止，后面的不会提交。已提交的稿件无法在这里撤回。');
  if (!confirmed) return;

  state.batching = true;
  state.batch = null;
  paintBatch();
  setTab('log');
  try {
    const result = await window.vh.batch({
      ids: state.selected,
      intervalMs: interval * 1000,
      partitionTaxonomy: form.partitionTaxonomy,
      humanType2: form.humanType2,
      tid: form.tid,
      confirmed: true,
    });
    state.batch = result;
    if (!result.ok) toastError('批量发布未全部完成：' + result.failed.map(f => f.id + ' ' + (f.message || f.outcome)).join('；'));
    else setTab('result');
  } catch (error) {
    toastError('批量发布失败：' + error.message);
  } finally {
    state.batching = false;
    paintBatch();
  }
}

function renderPartitions(keyword = '') {
  const human = state.partitionCatalog.taxonomy === HUMAN_PARTITION_TAXONOMY;
  $('#partitionLabel').textContent = human ? '投稿分区（新版）' : '投稿分区（旧版）';
  $('#fPartitionSearch').placeholder = human ? '搜 人工智能 / AI / Agent / 知识 / 科技数码' : '搜 AI / Agent / 人工智能 / 计算机 / 231';
  const select = $('#fPartition');
  const keep = select.value;
  select.innerHTML = '';
  if (!state.partitions.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（没有分区数据）';
    select.appendChild(option);
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = keyword ? '— 请选择（已筛选）—' : '— 请选择分区 —';
  select.appendChild(placeholder);

  const query = String(keyword || '').trim();
  const matched = searchPartitions(state.partitions, query);

  const groups = new Map();
  for (const item of matched) {
    const parent = item.parent || (human ? '新版分区' : '其他');
    if (!groups.has(parent)) {
      const group = document.createElement('optgroup');
      group.label = parent;
      groups.set(parent, group);
      select.appendChild(group);
    }
    const option = document.createElement('option');
    option.value = String(item.id);
    option.textContent = partitionLabel(item);
    if (item.description) option.title = item.description;
    groups.get(parent).appendChild(option);
  }
  if (keep && matched.some(item => String(item.id) === keep)) select.value = keep;
  else select.value = '';

  const last = Number(localStorage.getItem('vh.partition') || 0);
  const lastItem = last ? state.partitions.find(item => item.id === last) : null;
  const hint = lastItem ? ` 上次投过「${lastItem.name}」，请确认这次是否一样。` : '';
  // 上次的选择只做提示、不自动选中：投错分区发出去就撤不回来了。
  // 但提示要有一个能点的入口，否则用户只能自己在 30 个分区里翻。
  const useLast = $('#btnUseLastPartition');
  if (useLast) {
    const canUse = Boolean(lastItem) && !select.value;
    useLast.hidden = !canUse;
    if (canUse) $('#lastPartitionName').textContent = lastItem.name;
  }
  const base = state.partitionsLive
    ? human ? '当前账号已启用新版投稿分区，使用 human_type2 提交。' : '当前账号的实时旧投稿分区，使用 tid 提交。'
    : '离线参考清单：不能据此提交。';
  const count = query ? ` 匹配 ${matched.length} 个。` : '';
  $('#partitionNote').textContent = base + count + hint + (state.partitionCatalog.reason ? ' ' + state.partitionCatalog.reason : '');
  $('#partitionNote').style.color = state.partitionsLive ? 'var(--ink2)' : 'var(--warn)';
  paintPartitionAdvice();
  if (state.draft) { paintPlanMeta(); setBusy(state.busy); }
}

function paintPartitionAdvice() {
  const selected = state.partitions.find(item => item.id === Number($('#fPartition').value));
  $('#partitionAdvice').textContent = partitionAdvice(selected, state.partitionCatalog.taxonomy);
}

function renderDraft() {
  const draft = state.draft;
  const card = $('#draftCard');
  if (!draft) { card.hidden = true; return; }
  card.hidden = false;
  $('#fTitle').value = draft.fields.title || '';
  $('#fTags').value = draft.fields.tags || '';
  $('#fDesc').value = draft.fields.desc || '';
  $('#fComment').value = draft.copy.comment || '';
  updateTitleCount();

  // 标签只反映“素材是否齐全”，不代表现在就能提交（分区未选也不能投稿）。
  const ready = $('#draftReady');
  const problems = draft.warnings.filter(w => /no-(video|copy)|video-stale/.test(w.code));
  ready.textContent = draft.blockers?.length ? '成片不可用' : problems.length ? '缺必填' : '素材已载入';
  ready.className = 'pill ' + (problems.length ? 'bad' : 'ok');
  ready.title = problems.length ? problems.map(w => w.text).join('\n')
    : '成片与文案已载入，不代表审阅通过；分区仍需你自己选择。';

  const box = $('#warnings');
  box.innerHTML = '';
  for (const warn of draft.warnings) {
    const div = document.createElement('div');
    div.className = 'warn' + (/no-(video|copy)|video-stale/.test(warn.code) ? ' bad' : '');
    div.textContent = warn.text;
    box.appendChild(div);
  }
  if (!draft.warnings.length) {
    const div = document.createElement('div');
    div.className = 'warn dim';
    div.textContent = '文案机械检查通过；分区与发布口径仍需你核对。';
    box.appendChild(div);
  }

  const assets = $('#assets');
  assets.innerHTML = '';
  const videoRow = document.createElement('div');
  videoRow.className = 'asset';
  videoRow.innerHTML = '<strong>成片</strong>';
  const videoText = document.createElement('span');
  videoText.className = 'grow';
  videoText.textContent = draft.video ? `${draft.video.kind} · ${fmtBytes(draft.video.bytes)}` + (draft.video.duration ? ` · ${fmtSec(draft.video.duration)}` : '') : '没有成片';
  videoRow.appendChild(videoText);
  assets.appendChild(videoRow);

  /* 封面单独占一行并给够高度：缩略图原来压到 32px 高，
   * 320×180 的图缩完只剩 57px 宽，夹在「封面」和文件名中间几乎看不见，
   * 用户会以为根本没生成封面。这里改成整行展示 + 点击放大。 */
  const coverRow = document.createElement('div');
  coverRow.className = 'asset cover-asset';
  coverRow.innerHTML = '<strong>封面</strong>';
  if (draft.coverThumb) {
    const img = document.createElement('img');
    img.src = draft.coverThumb;
    img.alt = draft.cover?.ok ? `封面预览 ${draft.cover.file}` : '封面预览';
    img.className = 'cover-thumb';
    img.title = '点开放大';
    img.addEventListener('click', () => toggleCoverZoom(img.src));
    coverRow.appendChild(img);
  }
  const coverText = document.createElement('span');
  coverText.className = 'grow';
  const check = { info: draft.coverInfo, warnings: draft.coverNotes || [] };
  coverText.textContent = draft.cover?.ok
    ? `${draft.cover.file} · ${check?.info ? check.info.width + '×' + check.info.height + ' · ' : ''}${fmtBytes(draft.cover.bytes)}`
    : (draft.cover?.reason || '没有封面');
  coverRow.appendChild(coverText);
  if (draft.cover?.ok && draft.coverNotes?.length) {
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = '注意';
    flag.title = draft.coverNotes.join('\n');
    coverRow.appendChild(flag);
  }
  assets.appendChild(coverRow);
  $('#fCover').disabled = state.busy || !draft.cover?.ok;
  if (!draft.cover?.ok) $('#fCover').checked = false;

  $('#pTitle').value = draft.fields.title || '';
  renderPrepare(draft);
  paintPlanMeta();
  setBusy(state.busy);
}

/* 缺文案/封面时给一键补齐；不缺就完全隐藏，不占地方。 */
function renderPrepare(draft) {
  const box = $('#prepareBox');
  const missingCopy = !draft.fields.title;
  const missingCover = !draft.cover?.ok;
  const missingVideo = !draft.video;
  if (!missingCopy && !missingCover) { box.hidden = true; return; }
  if (missingVideo && missingCopy) {
    // 连成片都没有：先出片，这里不冒充能补齐。
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const parts = [];
  if (missingCopy) parts.push('发布文案（标题/简介/标签/封面文案）');
  if (missingCover) parts.push('封面图');
  $('#prepareText').textContent = '这个项目还缺：' + parts.join('、') + '。补齐后才能投稿。';
  $('#btnPrepare').textContent = missingCopy ? '一键补齐文案和封面' : '生成封面';
}

function paintPlanMeta() {
  const draft = state.draft;
  if (!draft) return;
  const option = $('#fPartition').selectedOptions[0];
  $('#pPartition').textContent = option ? option.textContent.replace(/（\d+）$/, '') : '未选择';
  $('#pTags').textContent = $('#fTags').value.trim() || '—';
  $('#pVideo').textContent = draft.video ? `${path0(draft.video.path)} · ${fmtBytes(draft.video.bytes)}` : '—';
  $('#pCoverMeta').textContent = draft.cover?.ok ? draft.cover.file : (draft.cover?.reason || '无');
  const img = $('#planCover');
  if (draft.coverThumb) { img.src = draft.coverThumb; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
}

function invalidatePlan() {
  if (!state.plan) return;
  state.plan = null;
  $('#planBody').hidden = true;
  $('#planEmpty').hidden = false;
  $('#planEmpty').textContent = '表单已修改，之前的预览已失效；请重新试运行。';
}

const path0 = p => String(p || '').split('/').pop();

function updateTitleCount() {
  const n = $('#fTitle').value.trim().length;
  $('#titleCount').textContent = n + ' / 80';
  $('#titleCount').style.color = n > 80 ? 'var(--bad)' : n === 0 ? 'var(--bad)' : '';
}

function readForm() {
  const human = state.partitionCatalog.taxonomy === HUMAN_PARTITION_TAXONOMY;
  const selected = Number($('#fPartition').value) || 0;
  return {
    id: state.current,
    title: $('#fTitle').value.trim(),
    desc: $('#fDesc').value,
    tags: $('#fTags').value.trim(),
    partitionTaxonomy: state.partitionCatalog.taxonomy,
    humanType2: human ? selected : 0,
    tid: human ? HUMAN_COMPAT_TID : selected,
    copyright: Number($('#fCopyright').value) || 1,
    source: $('#fSource').value.trim(),
    dynamic: $('#fDynamic').value,
    noReprint: $('#fReprint').checked,
    cover: $('#fCover').checked,
  };
}

async function loadDraft(id) {
  if (state.current !== id) {
    $('#fPartitionSearch').value = '';
    $('#fPartition').value = '';
    renderPartitions();
  }
  state.current = id;
  state.plan = null;
  renderProjects();
  setBusy(true);
  try {
    state.draft = await window.vh.draft(id);
    renderDraft();
    setTab('plan');
    // 选题后立刻生成预览，避免右侧一片空白等人点按钮。
    await plan({ silent: true });
  } catch (error) {
    state.draft = null;
    renderDraft();
    toastError('读取项目失败：' + error.message);
  } finally { setBusy(false); }
}

/* ---- 试运行 ---- */
async function plan({ silent = false } = {}) {
  const form = readForm();
  if (!form.title) {
    // 项目已选中、只是还没标题：不能说“先选项目”，那是错的引导。
    $('#planEmpty').innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = '这个项目还没有标题';
    const p = document.createElement('p');
    p.textContent = '先点左侧「一键补齐文案和封面」，或直接手填标题、标签、简介。填好后这里会显示将要提交的全文。';
    $('#planEmpty').append(h, p);
    $('#planEmpty').hidden = false;
    $('#planBody').hidden = true;
    return;
  }
  setBusy(true);
  if (!silent) setTab('plan');
  try {
    const result = await window.vh.plan(form);
    state.plan = result;
    $('#planEmpty').hidden = true;
    $('#planBody').hidden = false;
    $('#pTitle').value = form.title;
    paintPlanMeta();
    $('#planJson').textContent = renderPlan(result, form);
    // 预览已渲染：立刻滚到右侧顶部，让人看到刚填的内容而不是空白引导。
    $('#pane-plan').scrollTop = 0;
  } catch (error) {
    toastError('试运行失败：' + error.message);
  } finally { setBusy(false); }
}

function renderPlan(result, form) {
  const payload = result.payload;
  if (!payload) return ['还不能提交：', ...(result.problems || ['参数不完整']).map(p => '· ' + p),
    ...((result.warnings || []).length ? ['', '提醒：', ...result.warnings.map(w => '· ' + w.text)] : [])].join('\n');
  const cover = result.cover || {};
  const coverLine = !form.cover ? '不上传封面'
    : cover.ok
      ? `${cover.file} · ${cover.info?.width || '?'}×${cover.info?.height || '?'} · ${fmtBytes(cover.info?.bytes)}` + (cover.note ? `（${cover.note}）` : '')
      : '不可用：' + (cover.issues || []).join('；');
  const lines = [
    '标题：' + payload.title + `（${payload.title.length} 字）`,
    '分区：' + ($('#fPartition').selectedOptions[0]?.textContent || payload.tid),
    '标签：' + payload.tag,
    '版权：' + (payload.copyright === 2 ? '转载 · ' + payload.source : '自制') + (payload.no_reprint ? ' · 禁止转载' : ''),
    '视频：' + result.video.file + ' · ' + fmtBytes(result.video.bytes) + (result.video.duration ? ' · ' + fmtSec(result.video.duration) : ''),
    '封面：' + coverLine,
    '',
    '简介：',
    payload.desc || '（空）',
  ];
  if (payload.dynamic) lines.push('', '粉丝动态：' + payload.dynamic);
  const warnings = (result.warnings || []).filter(w => !/no-cover/.test(w.code) || form.cover);
  const coverWarnings = form.cover && cover.ok ? (cover.warnings || []) : [];
  const all = warnings.map(w => w.text).concat(coverWarnings);
  if (all.length) lines.push('', '提醒：', ...all.map(w => '· ' + w));
  if (result.problems?.length) lines.push('', '还不能提交：', ...result.problems.map(p => '· ' + p));
  // 参数问题已由上面的 problems 覆盖；这里只补“与表单无关”的提交前提。
  const otherBlockers = submitBlockers().filter(item => /登录|体检/.test(item));
  if (otherBlockers.length) lines.push('', '提交前还需要：', ...otherBlockers.map(p => '· ' + p));
  lines.push('', '— 实际提交的 JSON —', JSON.stringify(payload, null, 2));
  return lines.join('\n');
}

/* ---- 提交 ---- */
async function submit() {
  if (!state.account?.loggedIn) { openLogin(); return; }
  const form = readForm();
  const blockers = submitBlockers();
  if (blockers.length) return toastError(blockers.join('；'));
  const confirmed = window.confirm(`确认投稿？\n\n标题：${form.title}\n分区：${$('#fPartition').selectedOptions[0]?.textContent}\n标签：${form.tags}\n\n投稿提交后无法在这里撤回，需要去 B 站稿件管理里删改。`);
  if (!confirmed) return;

  setBusy(true);
  setTab('log');
  state.steps = [{ name: '准备', detail: '开始上传', state: 'doing' }];
  paintSteps();
  try {
    const result = await window.vh.submit({ ...form, confirmed: true });
    // 主进程把失败也作为结果返回（保留已完成步骤），这里必须按 ok 区分，不能当成功。
    if (!result?.ok) {
      state.steps = result?.steps?.length ? result.steps : [{ name: '失败', detail: result?.message || '未知错误', state: 'failed' }];
      // 提交请求已发出但结果未知时，可能已经投稿成功；提醒先核对再重试，避免重复稿件。
      if (result?.outcome === 'unknown') {
        state.steps.push({ name: '注意', detail: '若错误发生在提交之后，稿件可能已创建。请先到 B 站「稿件管理」核对，不要直接重试。', state: 'failed' });
      }
      paintSteps();
      setTab('log');
      return;
    }
    state.result = result;
    renderResult(result);
    setTab('result');
    // 投稿成功立刻去「稿件管理」确认一次：这是唯一能证明稿件真的建好了的地方。
    if (result.bvid) {
      window.vh.verify(result.bvid).then(check => {
        const line = $('#resultVerify');
        if (!line) return;
        if (check.found) {
          line.textContent = `✓ 已在稿件管理确认：${check.stateDesc || '已创建'}` + (check.title ? ` · ${check.title}` : '');
          line.className = 'verify ok';
        } else {
          line.textContent = '稿件管理里暂时还没出现（刚提交时可能需要等一会儿刷新）。可用上方按钮手动核对。';
          line.className = 'verify warn';
        }
      }).catch(error => {
        const line = $('#resultVerify');
        if (line) { line.textContent = '自动确认失败：' + error.message; line.className = 'verify warn'; }
      });
    }
  } catch (error) {
    state.steps.push({ name: '失败', detail: error.message, state: 'failed' });
    paintSteps();
    setTab('log');
  } finally { setBusy(false); $('#progressWrap').hidden = true; }
}

function paintSteps() {
  const list = $('#steps');
  list.innerHTML = '';
  if (!state.steps.length) {
    list.innerHTML = '<li class="waiting">还没有开始。</li>';
    return;
  }
  for (const step of state.steps) {
    const li = document.createElement('li');
    li.className = step.state || 'waiting';
    li.textContent = step.name;
    if (step.detail) {
      const span = document.createElement('span');
      span.className = 'detail';
      span.textContent = step.detail;
      li.appendChild(span);
    }
    list.appendChild(li);
  }
}

function renderResult(result) {
  $('#resultEmpty').hidden = true;
  $('#resultBody').hidden = false;
  $('#resultTitle').textContent = result.bvid ? '投稿已提交：BV ' + result.bvid : '投稿已提交';
  // 用户最容易误会的地方：接口成功 ≠ 立刻能搜到。分开写清楚各阶段在哪里可见。
  $('#resultLine').textContent = [
    result.url ? '稿件地址：' + result.url : '服务端返回了 aid ' + (result.aid ?? '—') + '。',
    '',
    '已确认的事实：服务端已接收并返回 BV 号，稿件已创建。',
    '',
    '接下来 B 站会转码与审核，可见性依次是：',
    '1. 创作中心「稿件管理」——最快，通常几分钟内出现',
    '2. 稿件链接可直接访问——转码完成后',
    '3. 搜索、个人空间、推荐流——审核通过后才逐步出现',
    '',
    '所以「搜不到」在刚发布的几分钟到几十分钟里是正常的，不代表没发出去。',
    '要确认有没有发成功，请看「稿件管理」，不要用搜索结果判断。',
  ].join('\n');
  $('#resultJson').textContent = JSON.stringify({ aid: result.aid, bvid: result.bvid, url: result.url, steps: result.steps }, null, 2);
  if (result.warnings?.length) $('#resultLine').textContent += '\n\n附加提醒：' + result.warnings.join('；');
  if (result.declarationVerification?.state === 'confirmed') $('#resultLine').textContent += '\n\n' + result.declarationVerification.message;
  $('#btnOpenResult').onclick = () => result.url && window.vh.openExternal(result.url);
  $('#btnOpenManage').onclick = () => window.vh.openExternal('https://member.bilibili.com/platform/upload-manager/article');
  $('#btnCopyComment').onclick = async () => {
    const comment = $('#fComment').value.trim();
    if (!comment) return toastError('没有置顶评论内容');
    await window.vh.copy(comment);
    $('#btnCopyComment').textContent = '已复制';
    setTimeout(() => { $('#btnCopyComment').textContent = '复制置顶评论'; }, 1500);
  };
}

/* ---- 一键补齐文案 / 封面 ---- */
async function prepare() {
  if (!state.current) return;
  const button = $('#btnPrepare');
  setBusy(true);
  button.disabled = true;
  button.textContent = '处理中…';
  const log = $('#prepareLog');
  log.hidden = false;
  log.textContent = '';
  try {
    const result = await window.vh.prepare(state.current);
    state.draft = result.draft;
    renderDraft();
    const failed = (result.steps || []).filter(s => !s.ok);
    if (failed.length) {
      toastError('补齐未完成：' + failed.map(s => s.name).join('、') + ' 失败，请看上面的日志。');
    } else {
      log.textContent += '\n✓ 已补齐，可以继续核对并提交。';
    }
  } catch (error) {
    toastError('补齐失败：' + error.message);
  } finally {
    setBusy(false);
    button.disabled = false;
    renderPrepare(state.draft);
  }
}

/* ---- 登录 ---- */
async function openLogin() {
  $('#loginModal').hidden = false;
  await refreshQr();
}

async function refreshQr() {
  $('#qrStatus').textContent = '正在获取二维码…';
  $('#qrStatus').className = 'status';
  $('#qrImage').removeAttribute('src');
  paintChecks(null);
  clearInterval(state.qrTimer);
  try {
    const qr = await window.vh.qr();
    $('#qrImage').src = qr.image;
    $('#qrStatus').textContent = '等待扫码…';
    state.qrTimer = setInterval(async () => {
      try {
        const result = await window.vh.poll();
        if (result.state === 'waiting') $('#qrStatus').textContent = '等待扫码…';
        else if (result.state === 'scanned') $('#qrStatus').textContent = '已扫码，请在手机上确认登录';
        else if (result.state === 'expired') { $('#qrStatus').textContent = '二维码已过期，点「换一张」'; clearInterval(state.qrTimer); }
        else if (result.state === 'ok') {
          clearInterval(state.qrTimer);
          state.account = result.account;
          paintAccount();
          $('#qrStatus').textContent = '登录成功：' + (result.account.name || '');
          $('#qrStatus').className = 'status ok';
          paintChecks(result.ready);
          state.ready = result.ready;
          await loadPartitions();
        }
      } catch (error) { $('#qrStatus').textContent = '轮询失败：' + error.message; }
    }, 2000);
  } catch (error) {
    $('#qrStatus').textContent = '获取二维码失败：' + error.message;
  }
}

async function loadPartitions() {
  const result = await window.vh.partitions();
  if (state.partitionCatalog.taxonomy !== result.taxonomy) {
    $('#fPartition').value = '';
    state.plan = null;
    $('#planBody').hidden = true;
    $('#planEmpty').hidden = false;
    $('#planEmpty').textContent = '分区模式已更新，请重新选择分区并试运行。';
  }
  state.partitionCatalog = result;
  state.partitions = result.list || [];
  state.partitionsLive = Boolean(result.live);
  renderPartitions($('#fPartitionSearch').value);
}

/* 体检结果：明确区分“登录成功”和“真能投稿”，不把前者当后者。 */
function paintChecks(ready) {
  const list = $('#checkList');
  list.innerHTML = '';
  if (!ready?.checks?.length) { list.hidden = true; return; }
  list.hidden = false;
  for (const check of ready.checks) {
    const li = document.createElement('li');
    const mark = document.createElement('span');
    mark.className = 'mark ' + (check.ok ? 'ok' : 'bad');
    mark.textContent = check.ok ? '✓' : '✗';
    const name = document.createElement('span');
    name.textContent = check.name;
    li.append(mark, name);
    if (check.note) {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = check.note;
      li.appendChild(note);
    }
    list.appendChild(li);
  }
  if (!ready.ok) {
    const li = document.createElement('li');
    li.className = 'bad';
    li.textContent = '还不能投稿：上面标 ✗ 的项需要先解决。';
    list.appendChild(li);
  }
}

function toastError(message) {
  setTab('log');
  state.steps.push({ name: '提示', detail: message, state: 'failed' });
  paintSteps();
}

function bindEvents() {
  $('#refresh').onclick = () => boot();
  $('#btnPlan').onclick = () => plan();
  $('#btnSubmit').onclick = () => submit();
  $('#btnBatch').onclick = () => submitBatch();
  $('#btnBatchCancel').onclick = async () => { await window.vh.batchCancel(); };
  window.vh.onBatchStep?.(entry => {
    state.batch = state.batch || { results: [], ok: true };
    state.batch.results.push(entry);
    state.batch.ok = !entry.ok;
    paintBatch();
  });
  $('#btnPrepare').onclick = () => prepare();
  $('#btnAccount').onclick = () => openLogin();
  $('#btnRefreshQr').onclick = () => refreshQr();
  $('#btnCloseLogin').onclick = () => { $('#loginModal').hidden = true; clearInterval(state.qrTimer); };
  $('#btnLogout').onclick = async () => {
    clearInterval(state.qrTimer);
    await window.vh.logout();
    state.account = { loggedIn: false };
    paintAccount();
    $('#qrStatus').textContent = '已退出登录。';
    $('#qrStatus').className = 'status';
    await loadPartitions();
  };
  for (const tab of document.querySelectorAll('.tab')) tab.onclick = () => setTab(tab.dataset.tab);
  $('#fTitle').addEventListener('input', () => { invalidatePlan(); updateTitleCount(); $('#pTitle').value = $('#fTitle').value; setBusy(state.busy); });
  $('#pTitle').addEventListener('input', () => { invalidatePlan(); $('#fTitle').value = $('#pTitle').value; updateTitleCount(); setBusy(state.busy); });
  $('#fTags').addEventListener('input', () => { invalidatePlan(); paintPlanMeta(); setBusy(state.busy); });
  $('#fPartitionSearch').addEventListener('input', event => { invalidatePlan(); renderPartitions(event.target.value); });
  $('#btnReloadPartitions').onclick = async () => {
    setBusy(true);
    try { await loadPartitions(); } catch (error) { toastError('刷新分区失败：' + error.message); }
    finally { setBusy(false); }
  };
  $('#btnAiChannel').onclick = () => window.vh.openExternal(AI_CHANNEL_URL);
  $('#btnUseLastPartition').onclick = () => {
    const last = String(localStorage.getItem('vh.partition') || '');
    const select = $('#fPartition');
    if (!last || ![...select.options].some(o => o.value === last)) { toastError('上次的分区不在当前列表里，请手动选择'); return; }
    select.value = last;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  $('#fPartition').addEventListener('change', () => {
    invalidatePlan();
    localStorage.setItem('vh.partition', $('#fPartition').value);
    paintPlanMeta();
    paintPartitionAdvice();
    setBusy(state.busy);
  });
  $('#fCopyright').addEventListener('change', () => { invalidatePlan(); $('#sourceField').hidden = $('#fCopyright').value !== '2'; setBusy(state.busy); });
  for (const id of ['#fSource', '#fDesc', '#fCover', '#fReprint', '#fDynamic']) $(id).addEventListener('input', () => { invalidatePlan(); setBusy(state.busy); });
  window.vh.onProgress(progress => {
    if (progress.phase === 'upload') {
      $('#progressWrap').hidden = false;
      $('#progressBar').style.width = Math.round(progress.bytes / progress.total * 100) + '%';
      const current = state.steps[state.steps.length - 1];
      if (current && current.state === 'doing') current.detail = `第 ${progress.chunk}/${progress.chunks} 块 · ${fmtBytes(progress.bytes)} / ${fmtBytes(progress.total)}`;
      paintSteps();
    } else if (progress.phase === 'retry') {
      const current = state.steps[state.steps.length - 1];
      if (current) current.detail = `第 ${progress.chunk} 块重试第 ${progress.attempt} 次`;
      paintSteps();
    }
  });
  window.vh.onStep(step => {
    const current = state.steps[state.steps.length - 1];
    if (current && current.state === 'doing') current.state = 'done';
    state.steps.push({ name: step.name, detail: step.detail, state: 'doing' });
    paintSteps();
  });
  // 补齐过程的实时输出：让“调用模型可能要一分钟”这件事有反馈，不假装卡住。
  window.vh.onPrepareLog(entry => {
    const log = $('#prepareLog');
    log.hidden = false;
    log.textContent += (entry.type === 'start' ? '\n▸ ' : '  ') + entry.text + '\n';
    log.scrollTop = log.scrollHeight;
  });
}

async function boot() {
  setBusy(true);
  try {
    const data = await window.vh.init();
    state.projects = data.projects;
    if (!state.projects.some(project => project.id === state.current)) {
      state.current = null;
      state.draft = null;
      renderDraft();
    }
    state.account = data.account;
    state.partitions = data.partitions || [];
    state.partitionsLive = false;
    state.partitionCatalog = { ...offlinePartitions(), list: state.partitions };
    state.ready = null;
    $('#appVersion').textContent = 'v' + data.version;
    paintAccount();
    renderProjects();
    renderPartitions();
    if (state.account?.loggedIn) {
      await loadPartitions();
      // 打开就体检一次：把“登录还在但投稿被风控”这类情况提前暴露。
      window.vh.check().then(ready => { state.ready = ready; paintAccount(); setBusy(state.busy); })
        .catch(() => { state.ready = { ok: false }; paintAccount(); setBusy(state.busy); });
    }
    if (state.projects[0]) await loadDraft(state.projects[0].id);
  } catch (error) { toastError('启动失败：' + error.message); }
  finally { setBusy(false); }
}

bindEvents();
boot();
